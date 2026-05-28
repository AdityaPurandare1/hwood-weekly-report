// Tests for src/lib/join.mjs
// Uses Node's built-in node:test runner — no extra deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  joinAndRank,
  parseVarianceRows,
  priorWeekIssuesFromTabs,
} from '../src/lib/join.mjs';

// -----------------------------------------------------------------------------
// parseVarianceRows
// -----------------------------------------------------------------------------

test('parseVarianceRows: returns [] for null input', () => {
  assert.deepEqual(parseVarianceRows(null), []);
});

test('parseVarianceRows: returns [] for empty input', () => {
  assert.deepEqual(parseVarianceRows([]), []);
});

test('parseVarianceRows: returns [] for header-only input', () => {
  assert.deepEqual(parseVarianceRows([['Item', 'Variance']]), []);
});

test('parseVarianceRows: handles current-week header with Issue Type column', () => {
  const rows = [
    ['Item', 'Category', 'Issue Type', 'Variance', 'Replacement Value', 'Audit Results', 'Error Cause'],
    ['Test Item 750ml', 'Spirits', 'Missing', -2, '$100.00', 'Validated Count', 'Spillage'],
  ];
  const out = parseVarianceRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].Item, 'Test Item 750ml');
  assert.equal(out[0].Category, 'Spirits');
  assert.equal(out[0].Variance, -2);
  assert.equal(out[0].ReplacementValue, 100);
  assert.equal(out[0].AuditResults, 'Validated Count');
  assert.equal(out[0].ErrorCause, 'Spillage');
});

test('parseVarianceRows: handles older-week header without Issue Type column', () => {
  const rows = [
    ['Item', 'Category', 'Variance', 'Replacement Value', 'Audit Results'],
    ['Test Item 750ml', 'Spirits', -1, '$50.00', 'Count Corrected'],
  ];
  const out = parseVarianceRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].Item, 'Test Item 750ml');
  assert.equal(out[0].ReplacementValue, 50);
  assert.equal(out[0].AuditResults, 'Count Corrected');
});

test('parseVarianceRows: uses Final Variance / Final Replacement Value when standard ones are absent', () => {
  const rows = [
    ['Item', 'Category', 'Final Variance', 'Final Replacement Value', 'Audit Results'],
    ['Test Item 750ml', 'Spirits', -3, '$150.00', ''],
  ];
  const out = parseVarianceRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].Variance, -3);
  assert.equal(out[0].ReplacementValue, 150);
});

test('parseVarianceRows: parseMoney accepts "$1,234.56"', () => {
  const rows = [
    ['Item', 'Replacement Value'],
    ['Test Item 750ml', '$1,234.56'],
  ];
  const out = parseVarianceRows(rows);
  assert.equal(out[0].ReplacementValue, 1234.56);
});

test('parseVarianceRows: parseMoney accepts "-$98.50"', () => {
  const rows = [
    ['Item', 'Replacement Value'],
    ['Test Item 750ml', '-$98.50'],
  ];
  const out = parseVarianceRows(rows);
  assert.equal(out[0].ReplacementValue, -98.5);
});

test('parseVarianceRows: parseMoney passes through numeric value', () => {
  const rows = [
    ['Item', 'Replacement Value'],
    ['Test Item 750ml', 42.5],
  ];
  const out = parseVarianceRows(rows);
  assert.equal(out[0].ReplacementValue, 42.5);
});

test('parseVarianceRows: parseMoney returns 0 for null/empty/undefined', () => {
  const rows = [
    ['Item', 'Replacement Value'],
    ['A 750ml', null],
    ['B 750ml', ''],
    ['C 750ml', undefined],
  ];
  const out = parseVarianceRows(rows);
  assert.equal(out[0].ReplacementValue, 0);
  assert.equal(out[1].ReplacementValue, 0);
  assert.equal(out[2].ReplacementValue, 0);
});

test('parseVarianceRows: parseMoney returns 0 for non-numeric garbage', () => {
  const rows = [
    ['Item', 'Replacement Value'],
    ['Test Item 750ml', 'not a number'],
  ];
  const out = parseVarianceRows(rows);
  assert.equal(out[0].ReplacementValue, 0);
});

test('parseVarianceRows: skips rows with empty Item field', () => {
  const rows = [
    ['Item', 'Replacement Value'],
    ['', '$50.00'],
    ['   ', '$50.00'],
    ['Real Item 750ml', '$25.00'],
  ];
  const out = parseVarianceRows(rows);
  // Whitespace-only items pass the truthy check on r[iItem]; only fully empty is skipped.
  // The code does `r[iItem] && String(r[iItem]).trim()` — whitespace-only is skipped too.
  assert.equal(out.length, 1);
  assert.equal(out[0].Item, 'Real Item 750ml');
});

// -----------------------------------------------------------------------------
// joinAndRank
// -----------------------------------------------------------------------------

test('joinAndRank: empty notableIssues returns []', () => {
  const out = joinAndRank({
    notableIssues: [],
    varianceByVenue: {},
    priorWeekIssues: [],
  });
  assert.deepEqual(out, []);
});

test('joinAndRank: single issue with no variance, no priors -> P3 new issue $0', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'Test Venue',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
      location: 'Bar',
      quantity: 1,
      notes: 'test note',
    }],
    varianceByVenue: {},
    priorWeekIssues: [],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].priority, 'P3');
  assert.equal(out[0].weeks_flagged, 1);
  assert.equal(out[0].recurring, 'New Issue');
  assert.equal(out[0].variance_dollars, 0);
});

test('joinAndRank: $300 variance single week -> P2 (single-week $200+ rule)', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'Test Venue',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      'Test Venue': [
        { Item: 'Test Item 750ml', ReplacementValue: 300, AuditResults: '', ErrorCause: '' },
      ],
    },
    priorWeekIssues: [],
  });
  assert.equal(out[0].priority, 'P2');
  assert.equal(out[0].variance_dollars, 300);
  assert.equal(out[0].weeks_flagged, 1);
});

test('joinAndRank: $30 variance + 3 prior weeks -> P2 (recurring under $50 threshold)', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'Test Venue',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      'Test Venue': [
        { Item: 'Test Item 750ml', ReplacementValue: 30, AuditResults: '', ErrorCause: '' },
      ],
    },
    priorWeekIssues: [
      { venue: 'Test Venue', item_name: 'Test Item 750ml', issue_type: 'Missing' },
      { venue: 'Test Venue', item_name: 'Test Item 750ml', issue_type: 'Missing' },
      { venue: 'Test Venue', item_name: 'Test Item 750ml', issue_type: 'Missing' },
    ],
  });
  assert.equal(out[0].priority, 'P2');
  assert.equal(out[0].weeks_flagged, 4);
  assert.equal(out[0].recurring, 'Recurring');
});

test('joinAndRank: $80 variance + 2 prior weeks -> P1 (both criteria)', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'Test Venue',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      'Test Venue': [
        { Item: 'Test Item 750ml', ReplacementValue: 80, AuditResults: '', ErrorCause: '' },
      ],
    },
    priorWeekIssues: [
      { venue: 'Test Venue', item_name: 'Test Item 750ml', issue_type: 'Missing' },
      { venue: 'Test Venue', item_name: 'Test Item 750ml', issue_type: 'Missing' },
    ],
  });
  assert.equal(out[0].priority, 'P1');
  assert.equal(out[0].weeks_flagged, 3);
});

test('joinAndRank: boundary $49.99 + 2 weeks (1 prior) -> P2 (just under $50 threshold)', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'V',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      V: [{ Item: 'Test Item 750ml', ReplacementValue: 49.99, AuditResults: '', ErrorCause: '' }],
    },
    priorWeekIssues: [
      { venue: 'V', item_name: 'Test Item 750ml', issue_type: 'Missing' },
    ],
  });
  assert.equal(out[0].weeks_flagged, 2);
  assert.equal(out[0].priority, 'P2');
});

test('joinAndRank: boundary $50.00 + 2 weeks (1 prior) -> P1 (exactly at threshold)', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'V',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      V: [{ Item: 'Test Item 750ml', ReplacementValue: 50, AuditResults: '', ErrorCause: '' }],
    },
    priorWeekIssues: [
      { venue: 'V', item_name: 'Test Item 750ml', issue_type: 'Missing' },
    ],
  });
  assert.equal(out[0].weeks_flagged, 2);
  assert.equal(out[0].priority, 'P1');
});

test('joinAndRank: boundary $199.99 + 1 week -> P3 (just under single-week P2 threshold)', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'V',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      V: [{ Item: 'Test Item 750ml', ReplacementValue: 199.99, AuditResults: '', ErrorCause: '' }],
    },
    priorWeekIssues: [],
  });
  assert.equal(out[0].priority, 'P3');
});

test('joinAndRank: boundary $200.00 + 1 week -> P2 (exactly at single-week threshold)', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'V',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      V: [{ Item: 'Test Item 750ml', ReplacementValue: 200, AuditResults: '', ErrorCause: '' }],
    },
    priorWeekIssues: [],
  });
  assert.equal(out[0].priority, 'P2');
});

test('joinAndRank: $50 + 1 week stays P3 (recurring criterion not met)', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'V',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      V: [{ Item: 'Test Item 750ml', ReplacementValue: 50, AuditResults: '', ErrorCause: '' }],
    },
    priorWeekIssues: [],
  });
  assert.equal(out[0].priority, 'P3');
});

test('joinAndRank: $50 + 2 weeks goes P1', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'V',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      V: [{ Item: 'Test Item 750ml', ReplacementValue: 50, AuditResults: '', ErrorCause: '' }],
    },
    priorWeekIssues: [
      { venue: 'V', item_name: 'Test Item 750ml', issue_type: 'Missing' },
    ],
  });
  assert.equal(out[0].priority, 'P1');
});

test('joinAndRank: sort order — P1 first, then $ desc within priority, then weeks desc', () => {
  // Three items: one P1, two P2 (different $), one P3
  const out = joinAndRank({
    notableIssues: [
      { venue: 'V', item_name: 'Item Alpha 750ml', issue_type: 'Missing' },   // -> P3
      { venue: 'V', item_name: 'Item Bravo 750ml', issue_type: 'Missing' },   // -> P2 ($250)
      { venue: 'V', item_name: 'Item Charlie 750ml', issue_type: 'Missing' }, // -> P2 ($300)
      { venue: 'V', item_name: 'Item Delta 750ml', issue_type: 'Missing' },   // -> P1
    ],
    varianceByVenue: {
      V: [
        { Item: 'Item Alpha 750ml', ReplacementValue: 10, AuditResults: '', ErrorCause: '' },
        { Item: 'Item Bravo 750ml', ReplacementValue: 250, AuditResults: '', ErrorCause: '' },
        { Item: 'Item Charlie 750ml', ReplacementValue: 300, AuditResults: '', ErrorCause: '' },
        { Item: 'Item Delta 750ml', ReplacementValue: 75, AuditResults: '', ErrorCause: '' },
      ],
    },
    priorWeekIssues: [
      // Make Delta recurring -> P1
      { venue: 'V', item_name: 'Item Delta 750ml', issue_type: 'Missing' },
    ],
  });
  const order = out.map(r => r.product);
  assert.deepEqual(order, [
    'Item Delta 750ml',    // P1
    'Item Charlie 750ml',  // P2 $300
    'Item Bravo 750ml',    // P2 $250
    'Item Alpha 750ml',    // P3
  ]);
});

test('joinAndRank: sort tiebreak by weeks_flagged desc within same $ amount and priority', () => {
  // Two P2 items with same $0 — break by weeks descending.
  const out = joinAndRank({
    notableIssues: [
      { venue: 'V', item_name: 'Item Older 750ml', issue_type: 'Missing' },   // many priors
      { venue: 'V', item_name: 'Item Newer 750ml', issue_type: 'Missing' },   // one prior
    ],
    varianceByVenue: { V: [] },
    priorWeekIssues: [
      { venue: 'V', item_name: 'Item Older 750ml', issue_type: 'Missing' },
      { venue: 'V', item_name: 'Item Older 750ml', issue_type: 'Missing' },
      { venue: 'V', item_name: 'Item Older 750ml', issue_type: 'Missing' },
      { venue: 'V', item_name: 'Item Newer 750ml', issue_type: 'Missing' },
    ],
  });
  // Both are P2 (recurring), both $0. Older has more weeks_flagged -> comes first.
  assert.equal(out[0].product, 'Item Older 750ml');
  assert.equal(out[1].product, 'Item Newer 750ml');
});

test('joinAndRank: name matching with punctuation/spacing tolerance', () => {
  // "Mr. Black Coffee Liqueur 750ml" should match "Mr Black Coffee Liqueur 750ml"
  const out = joinAndRank({
    notableIssues: [{
      venue: 'V',
      item_name: 'Mr. Black Coffee Liqueur 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      V: [{
        Item: 'Mr Black Coffee Liqueur 750ml',
        ReplacementValue: 75,
        AuditResults: '',
        ErrorCause: '',
      }],
    },
    priorWeekIssues: [],
  });
  assert.equal(
    out[0].variance_dollars,
    75,
    'Punctuation-tolerant matching should treat "Mr." and "Mr" as the same product',
  );
});

test('joinAndRank: name matching does NOT match different products (Coke 8oz vs Coca-Cola Zero 12oz)', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'V',
      item_name: 'Coke 8oz',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      V: [{
        Item: 'Coca-Cola Zero 12oz',
        ReplacementValue: 50,
        AuditResults: '',
        ErrorCause: '',
      }],
    },
    priorWeekIssues: [],
  });
  assert.equal(out[0].variance_dollars, 0, 'Different products should not match');
});

test('joinAndRank: smart-quote tolerance — "Mr. Black" should NOT match "Mr.’s Black" (different items)', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'V',
      item_name: 'Mr. Black',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      V: [{
        Item: 'Mr.’s Black',
        ReplacementValue: 99,
        AuditResults: '',
        ErrorCause: '',
      }],
    },
    priorWeekIssues: [],
  });
  assert.equal(out[0].variance_dollars, 0, 'Smart-quote stripping should not produce a false match');
});

test('joinAndRank: audit pass-through — first non-empty AuditResults wins among multiple matches', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'V',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: {
      V: [
        { Item: 'Test Item 750ml', ReplacementValue: 10, AuditResults: '', ErrorCause: '' },
        { Item: 'Test Item 750ml', ReplacementValue: 20, AuditResults: 'Count Corrected', ErrorCause: '' },
        { Item: 'Test Item 750ml', ReplacementValue: 30, AuditResults: 'Validated Count', ErrorCause: '' },
      ],
    },
    priorWeekIssues: [],
  });
  assert.equal(out[0].audit_status, 'Count Corrected');
  // Sum should be all three exposures (abs values added)
  assert.equal(out[0].variance_dollars, 60);
});

test('joinAndRank: recurring detection — same (venue, item, issue_type) in priors bumps weeks_flagged', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'V',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: { V: [] },
    priorWeekIssues: [
      { venue: 'V', item_name: 'Test Item 750ml', issue_type: 'Missing' },
      { venue: 'V', item_name: 'Test Item 750ml', issue_type: 'Missing' },
    ],
  });
  assert.equal(out[0].weeks_flagged, 3);
  assert.equal(out[0].recurring, 'Recurring');
});

test('joinAndRank: different venue with same item name does NOT count toward weeks_flagged', () => {
  const out = joinAndRank({
    notableIssues: [{
      venue: 'Venue A',
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
    }],
    varianceByVenue: { 'Venue A': [] },
    priorWeekIssues: [
      { venue: 'Venue B', item_name: 'Test Item 750ml', issue_type: 'Missing' },
      { venue: 'Venue B', item_name: 'Test Item 750ml', issue_type: 'Missing' },
    ],
  });
  assert.equal(out[0].weeks_flagged, 1, 'Different venue priors should not count');
  assert.equal(out[0].recurring, 'New Issue');
});

// -----------------------------------------------------------------------------
// priorWeekIssuesFromTabs
// -----------------------------------------------------------------------------

test('priorWeekIssuesFromTabs: single tab with valid rows returns flattened array', () => {
  const out = priorWeekIssuesFromTabs([
    [
      ['Store', 'Product', 'Issue'],
      ['Venue A', 'Item Alpha 750ml', 'Missing'],
      ['Venue B', 'Item Bravo 750ml', 'Mislabeled'],
    ],
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    venue: 'Venue A',
    item_name: 'Item Alpha 750ml',
    issue_type: 'Missing',
    tabIndex: 0,
  });
  assert.deepEqual(out[1], {
    venue: 'Venue B',
    item_name: 'Item Bravo 750ml',
    issue_type: 'Mislabeled',
    tabIndex: 0,
  });
});

test('priorWeekIssuesFromTabs: multiple tabs are aggregated', () => {
  const out = priorWeekIssuesFromTabs([
    [
      ['Store', 'Product', 'Issue'],
      ['Venue A', 'Item Alpha 750ml', 'Missing'],
    ],
    [
      ['Store', 'Product', 'Issue'],
      ['Venue B', 'Item Bravo 750ml', 'Missing'],
      ['Venue C', 'Item Charlie 750ml', 'Mislabeled'],
    ],
  ]);
  assert.equal(out.length, 3);
});

test('priorWeekIssuesFromTabs: header-only tab returns []', () => {
  const out = priorWeekIssuesFromTabs([
    [['Store', 'Product', 'Issue']],
  ]);
  assert.deepEqual(out, []);
});

test('priorWeekIssuesFromTabs: empty tab array returns []', () => {
  assert.deepEqual(priorWeekIssuesFromTabs([]), []);
});

test('priorWeekIssuesFromTabs: tab missing required columns is skipped silently', () => {
  // No throw, just skipped.
  const out = priorWeekIssuesFromTabs([
    [
      ['Other', 'Columns', 'Here'],
      ['x', 'y', 'z'],
    ],
    [
      ['Store', 'Product', 'Issue'],
      ['Venue A', 'Item Alpha 750ml', 'Missing'],
    ],
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].venue, 'Venue A');
});

test('priorWeekIssuesFromTabs: case-insensitive header detection (STORE vs Store)', () => {
  const out = priorWeekIssuesFromTabs([
    [
      ['STORE', 'PRODUCT', 'ISSUE'],
      ['Venue A', 'Item Alpha 750ml', 'Missing'],
    ],
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].venue, 'Venue A');
});

test('priorWeekIssuesFromTabs: rows with blank Store or Product are skipped', () => {
  const out = priorWeekIssuesFromTabs([
    [
      ['Store', 'Product', 'Issue'],
      ['', 'Item Alpha 750ml', 'Missing'],     // no store
      ['Venue A', '', 'Missing'],              // no product
      ['Venue B', 'Item Bravo 750ml', 'Missing'],
    ],
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].venue, 'Venue B');
});
