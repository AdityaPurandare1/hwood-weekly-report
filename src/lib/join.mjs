// Join notable issues against variance + compute age + rank.
//
// Inputs:
//   notableIssues:   [{ venue, item_name, issue_type, location, quantity, notes }]
//   varianceByVenue: { [venue]: [{ Item, Variance, ReplacementValue, AuditResults, ErrorCause, ... }] }
//   priorWeekIssues: [{ venue, item_name, issue_type, weeks_flagged }]  ← from prior tabs
//
// Output:
//   [{ venue, product, issue, location, recurring, bottle_count, description,
//      weeks_flagged, variance_dollars, audit_status, priority }]

import { VENUES } from '../config.mjs';

const PRIORITY_DOLLAR_THRESHOLD = 50;   // P1 needs $50+ exposure to count
const P2_DOLLAR_THRESHOLD = 200;        // a single-week item with $200+ jumps to P2

// Normalize a product name for matching.
function normalize(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')   // smart and straight quotes
    .replace(/[^\w\s]/g, ' ')                        // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns true if the two normalized names refer to the same product (or a close match).
// Bidirectional substring containment + length sanity check.
function namesMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Require at least 6 chars of overlap to avoid false positives like "Coke" vs "Cokes"
  if (na.length < 6 || nb.length < 6) return false;
  return na.includes(nb) || nb.includes(na);
}

// Like namesMatch but tuned for venue names. Short canonical venues ("Keys", "Poppy")
// fail the 6-char length guard, so for short names we require an exact normalized match.
function venueMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length < 6 || nb.length < 6) return false;
  return na.includes(nb) || nb.includes(na);
}

// Map a raw venue string from a prior tab to a canonical name in VENUES.
// Falls back to the raw input if no canonical match — better stale data than dropped data.
function canonicalVenue(raw) {
  if (!raw) return raw;
  for (const v of VENUES) {
    if (venueMatch(raw, v)) return v;
  }
  return raw;
}

// For one notable issue, find all matching rows in this venue's variance data
// and return the summed $ exposure + most informative audit status.
function exposureFor(issue, varianceRows) {
  if (!varianceRows || varianceRows.length === 0) {
    return { dollars: 0, audit: null, errorCause: null };
  }
  let dollars = 0;
  let audit = null;
  let errorCause = null;
  for (const row of varianceRows) {
    if (!namesMatch(issue.item_name, row.Item)) continue;
    const dollarVal = Number(row.ReplacementValue) || 0;
    dollars += Math.abs(dollarVal);
    // Prefer "Count Corrected" > "Validated Count" > blank, since CC is recoverable signal
    if (row.AuditResults && !audit) audit = row.AuditResults;
    if (row.ErrorCause && !errorCause) errorCause = row.ErrorCause;
  }
  return { dollars: Math.round(dollars * 100) / 100, audit, errorCause };
}

// Compute weeks_flagged by looking up this (venue, item, issue_type) in prior weekly tabs.
// Counts DISTINCT tabs the issue appeared in — a duplicated row inside one tab
// (e.g. from a hand-edited sheet) only counts once.
function weeksFlaggedFor(issue, priorWeekIssues) {
  if (!priorWeekIssues || priorWeekIssues.length === 0) return 1;
  const tabs = new Set();
  for (const prior of priorWeekIssues) {
    if (prior.venue !== issue.venue) continue;
    if (prior.issue_type !== issue.issue_type) continue;
    if (!namesMatch(prior.item_name, issue.item_name)) continue;
    // Older callers without tabIndex still get a per-entry count (back-compat with tests).
    tabs.add(prior.tabIndex ?? `__row_${tabs.size}`);
  }
  return tabs.size + 1; // +1 for this week
}

function priorityFor(weeksFlagged, dollars) {
  if (weeksFlagged >= 2 && dollars >= PRIORITY_DOLLAR_THRESHOLD) return 'P1';
  if (weeksFlagged >= 2) return 'P2';
  if (dollars >= P2_DOLLAR_THRESHOLD) return 'P2';
  return 'P3';
}

// Main entry — produces ranked, joined rows ready to write to the new weekly tab.
export function joinAndRank({ notableIssues, varianceByVenue, priorWeekIssues }) {
  const enriched = notableIssues.map(issue => {
    const variance = varianceByVenue[issue.venue] ?? [];
    const { dollars, audit, errorCause } = exposureFor(issue, variance);
    const weeks = weeksFlaggedFor(issue, priorWeekIssues);
    return {
      venue: issue.venue,
      product: issue.item_name,
      issue: issue.issue_type,
      location: issue.location ?? '',
      recurring: weeks > 1 ? 'Recurring' : 'New Issue',
      bottle_count: issue.quantity ?? '',
      description: [issue.notes, errorCause ? `variance cause: ${errorCause}` : null]
        .filter(Boolean).join(' | '),
      weeks_flagged: weeks,
      variance_dollars: dollars,
      audit_status: audit ?? '',
      priority: priorityFor(weeks, dollars),
    };
  });

  // Sort: P1 first, then P2, P3 — within each, descending by $ exposure, then by weeks flagged.
  const priorityOrder = { P1: 0, P2: 1, P3: 2 };
  enriched.sort((a, b) => {
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }
    if (a.variance_dollars !== b.variance_dollars) return b.variance_dollars - a.variance_dollars;
    return b.weeks_flagged - a.weeks_flagged;
  });

  return enriched;
}

// Convert variance rows (raw 2D array from Sheets API) into objects keyed by column name.
// Header row is row 0. Returns array of {Item, Category, Variance, ReplacementValue, AuditResults, ...}.
export function parseVarianceRows(rows) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0].map(h => String(h || '').trim());

  // Normalize column names — different tabs use slightly different headers
  const colIndex = (...candidates) => {
    for (const c of candidates) {
      const i = header.findIndex(h => h.toLowerCase() === c.toLowerCase());
      if (i !== -1) return i;
    }
    return -1;
  };

  const iItem = colIndex('Item');
  const iCategory = colIndex('Category');
  const iVariance = colIndex('Variance', 'Final Variance', 'Updated Variance');
  const iReplacement = colIndex('Replacement Value', 'Final Replacement Value', 'Updated Replacement Value');
  const iAudit = colIndex('Audit Results');
  const iCause = colIndex('Error Cause');
  const iCounter = colIndex('Counter Initials', 'Counters Initials for Recount');

  return rows.slice(1)
    .filter(r => r && r[iItem] && String(r[iItem]).trim())
    .map(r => ({
      Item: String(r[iItem] ?? '').trim(),
      Category: iCategory > -1 ? String(r[iCategory] ?? '').trim() : '',
      Variance: iVariance > -1 ? Number(r[iVariance]) || 0 : 0,
      ReplacementValue: iReplacement > -1 ? parseMoney(r[iReplacement]) : 0,
      AuditResults: iAudit > -1 ? String(r[iAudit] ?? '').trim() : '',
      ErrorCause: iCause > -1 ? String(r[iCause] ?? '').trim() : '',
      CounterInitials: iCounter > -1 ? String(r[iCounter] ?? '').trim() : '',
    }));
}

function parseMoney(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const cleaned = String(v).replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

// Read the prior 4 weekly tabs from the Notable Issues sheet and flatten to a single array
// of { venue, item_name, issue_type, tabIndex } so weeksFlaggedFor() can count recurrence
// by distinct tab. Venue names are canonicalized against VENUES so spelling variations from
// hand-edited rows still match the current week's canonical venue.
export function priorWeekIssuesFromTabs(tabResults) {
  const out = [];
  for (let i = 0; i < tabResults.length; i++) {
    const rows = tabResults[i];
    if (!rows || rows.length < 2) continue;
    const header = rows[0].map(h => String(h || '').toLowerCase());
    const iStore = header.indexOf('store');
    const iProduct = header.indexOf('product');
    const iIssue = header.indexOf('issue');
    if (iStore === -1 || iProduct === -1 || iIssue === -1) continue;
    const seen = new Set(); // dedupe within this tab
    for (const r of rows.slice(1)) {
      if (!r[iStore] || !r[iProduct]) continue;
      const venue = canonicalVenue(String(r[iStore]).trim());
      const item_name = String(r[iProduct]).trim();
      const issue_type = String(r[iIssue] ?? '').trim();
      const key = `${venue}${normalize(item_name)}${issue_type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ venue, item_name, issue_type, tabIndex: i });
    }
  }
  return out;
}
