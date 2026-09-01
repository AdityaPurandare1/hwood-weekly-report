// Tests for the pure date/week helpers in google-sheets.mjs.
// These drive backfill targeting, so an off-by-one here silently writes a whole
// week's issues onto the wrong tab.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  weekTabTitle,
  mondayOf,
  slackWindowForWeek,
  parseVarianceTabDate,
} from '../src/lib/google-sheets.mjs';

// 2026-08-03 is a Monday; 08-04 Tue ... 08-09 Sun.
const MON = new Date(2026, 7, 3);

test('mondayOf: a Monday maps to itself', () => {
  assert.equal(mondayOf(MON).getTime(), MON.getTime());
});

test('mondayOf: every day of that week maps back to the same Monday', () => {
  for (let i = 0; i < 7; i++) {
    const d = new Date(2026, 7, 3 + i);
    assert.equal(mondayOf(d).getTime(), MON.getTime(), `day offset ${i}`);
  }
});

test('mondayOf: Sunday belongs to the week that started 6 days earlier', () => {
  const sunday = new Date(2026, 7, 9);
  assert.equal(sunday.getDay(), 0);
  assert.equal(mondayOf(sunday).getTime(), MON.getTime());
});

test('mondayOf: zeroes the time component', () => {
  const d = mondayOf(new Date(2026, 7, 5, 13, 45, 30, 500));
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
  assert.equal(d.getMilliseconds(), 0);
});

test('mondayOf: crosses a month boundary correctly', () => {
  // 2026-09-01 is a Tuesday; its Monday is 2026-08-31.
  const d = mondayOf(new Date(2026, 8, 1));
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 31);
});

test('weekTabTitle: formats the Monday as M/D/YY', () => {
  assert.equal(weekTabTitle(MON), '8/3/26');
});

test('weekTabTitle: a Tuesday run names the tab after Monday, not the run day', () => {
  assert.equal(weekTabTitle(new Date(2026, 8, 1)), '8/31/26');
});

test('weekTabTitle: no leading zeros on month or day', () => {
  assert.equal(weekTabTitle(new Date(2026, 0, 5)), '1/5/26');
});

test('slackWindowForWeek: window ends Tuesday 17:00 and spans exactly 7 days', () => {
  const { oldest, latest } = slackWindowForWeek(MON);
  assert.equal(latest.getDay(), 2, 'latest is a Tuesday');
  assert.equal(latest.getDate(), 4);
  assert.equal(latest.getHours(), 17);
  assert.equal(latest - oldest, 7 * 86400_000);
});

test('slackWindowForWeek: consecutive weeks abut without gap or overlap', () => {
  const a = slackWindowForWeek(MON);
  const b = slackWindowForWeek(new Date(2026, 7, 10));
  assert.equal(a.latest.getTime(), b.oldest.getTime());
});

test('parseVarianceTabDate: explicit 2-digit year is honoured', () => {
  const d = parseVarianceTabDate('8/3/26', MON);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 3);
});

test('parseVarianceTabDate: explicit 4-digit year is honoured', () => {
  const d = parseVarianceTabDate('8/3/2026', MON);
  assert.equal(d.getFullYear(), 2026);
});

test('parseVarianceTabDate: bare M/D infers the reference year', () => {
  const d = parseVarianceTabDate('8/3', MON);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
});

test('parseVarianceTabDate: zero-padded M/D parses', () => {
  const d = parseVarianceTabDate('08/03', MON);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 3);
});

test('parseVarianceTabDate: a December tab near a January week resolves to the PRIOR year', () => {
  const jan = new Date(2026, 0, 4);           // week of Jan 2026
  const d = parseVarianceTabDate('12/29', jan);
  assert.equal(d.getFullYear(), 2025, 'should not snap to Dec 2026');
  assert.equal(d.getMonth(), 11);
});

test('parseVarianceTabDate: a January tab near a December week resolves to the NEXT year', () => {
  const dec = new Date(2025, 11, 29);
  const d = parseVarianceTabDate('1/5', dec);
  assert.equal(d.getFullYear(), 2026);
});

test('parseVarianceTabDate: non-date titles return null', () => {
  for (const title of ['Summary', '', 'Sheet1', 'Notes 8/3']) {
    assert.equal(parseVarianceTabDate(title, MON), null, `title: ${title}`);
  }
});

test('parseVarianceTabDate: trailing text after the date is tolerated', () => {
  const d = parseVarianceTabDate('8/3 final', MON);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 3);
});
