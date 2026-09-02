// Google Sheets API client — refresh-token OAuth flow.
// Reads Pati's variance sheets; writes a new weekly tab to the Notable Issues sheet.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

let cachedAccessToken = null;
let cachedExpiry = 0;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiry - 60_000) return cachedAccessToken;

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Missing Google env vars: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Google token refresh failed: ' + JSON.stringify(data));

  cachedAccessToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in * 1000);
  return cachedAccessToken;
}

// Google Sheets intermittently answers 503 (and 429 under rate limit) on reads
// that succeed moments later. Untreated, one blip silently drops a whole venue's
// $ exposure from the report, so retry the transient classes with backoff.
// 4xx other than 429 are permanent (403 = not shared, 404 = bad id) — fail fast.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = await getAccessToken();
    let res;
    try {
      res = await fetch(SHEETS_BASE + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network-level failure (DNS, socket reset) — also worth retrying.
      lastErr = new Error(`Google Sheets ${method} ${path} -> network: ${err.message}`);
      if (attempt === MAX_ATTEMPTS) throw lastErr;
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return res.json();

    const text = await res.text();
    lastErr = new Error(`Google Sheets ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    if (!RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) throw lastErr;
    await sleep(500 * 2 ** (attempt - 1));   // 0.5s, 1s, 2s
  }
  throw lastErr;
}

// Get metadata: title + list of tab names with their sheetIds.
export async function getSheetMetadata(spreadsheetId) {
  const data = await api('GET', `/${spreadsheetId}?fields=properties.title,sheets(properties(sheetId,title))`);
  return {
    title: data.properties.title,
    tabs: data.sheets.map(s => ({ id: s.properties.sheetId, title: s.properties.title })),
  };
}

// Read a range. range is "TabName!A1:N" or just "TabName" for the full tab.
export async function readRange(spreadsheetId, range) {
  const data = await api('GET', `/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  return data.values ?? [];
}

// Read the most recent dated tab from Pati's variance sheets.
// Pati's tabs are dated like "05/25", "5/18", "5/11" — most recent week is the FIRST tab.
export async function readLatestVarianceWeek(spreadsheetId) {
  const meta = await getSheetMetadata(spreadsheetId);
  const datedTabs = meta.tabs.filter(t => /^\d{1,2}\/\d{1,2}/.test(t.title));
  if (datedTabs.length === 0) return { week: null, rows: [] };
  const latest = datedTabs[0];
  const rows = await readRange(spreadsheetId, `${latest.title}!A1:Z`);
  return { week: latest.title, rows, sheetTitle: meta.title };
}

// Add a new tab to a spreadsheet. Pass index=0 to insert at the leftmost
// position (matches the historical Notable Issues convention: newest first).
export async function addTab(spreadsheetId, title, index) {
  const properties = { title };
  if (index !== undefined) properties.index = index;
  const data = await api('POST', `/${spreadsheetId}:batchUpdate`, {
    requests: [{ addSheet: { properties } }],
  });
  return data.replies[0].addSheet.properties.sheetId;
}

// Clear all cell values in a tab (keeps the tab + its formatting).
export async function clearTab(spreadsheetId, tabTitle) {
  await api('POST', `/${spreadsheetId}/values/${encodeURIComponent(tabTitle)}!A:Z:clear`);
}

// Dropdown values — ORDER MATTERS for Sheets' auto-assigned chip colors.
// Mirrors the original Notable Issues sheet so historical and new tabs look identical.
const STORE_OPTIONS = ['Poppy','Delilah - LA','Deliliah - Miami','The Nice Guy','Keys','Bird Streets Club'];
const ISSUE_OPTIONS = [
  'Product not in Craftable','Duplicate products in Craftable','Product not assigned to section',
  'Scans as different item','Product not scanning','Sticker not scanning','No Sticker',
  'Unknown variance','Issue','Missing','Quantity mismatch','Mislabeled','Other',
];
const RECURRING_OPTIONS = ['New Issue','Recurring'];

function dropdownRule(values) {
  return {
    condition: {
      type: 'ONE_OF_LIST',
      values: values.map(userEnteredValue => ({ userEnteredValue })),
    },
    strict: true,         // matches the original sheet — required for chip coloring
    showCustomUi: true,   // render as colored chip
  };
}

// Apply the canonical formatting to a tab: bold/grey/frozen header, colored
// dropdowns on Store/Issue/Recurring, basic filter across the data range.
export async function formatHeaderRow(spreadsheetId, sheetId, numColumns, numRows = 1000) {
  await api('POST', `/${spreadsheetId}:batchUpdate`, {
    requests: [
      // 1. Bold + grey background on header row
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numColumns },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 },
              textFormat: { bold: true },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      },
      // 2. Freeze the header row
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
      // 3. Store column dropdown (col A = index 0)
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: 1 },
          rule: dropdownRule(STORE_OPTIONS),
        },
      },
      // 4. Issue column dropdown (col C = index 2)
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: numRows, startColumnIndex: 2, endColumnIndex: 3 },
          rule: dropdownRule(ISSUE_OPTIONS),
        },
      },
      // 5. Recurring column dropdown (col E = index 4)
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: numRows, startColumnIndex: 4, endColumnIndex: 5 },
          rule: dropdownRule(RECURRING_OPTIONS),
        },
      },
      // 6. Basic filter over the whole data range
      {
        setBasicFilter: {
          filter: {
            range: { sheetId, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: numColumns },
          },
        },
      },
    ],
  });
}

// Write 2D array of values starting at A1 of the given tab.
export async function writeValues(spreadsheetId, tabTitle, values) {
  if (!values || values.length === 0) return;
  await api('PUT',
    `/${spreadsheetId}/values/${encodeURIComponent(tabTitle)}!A1?valueInputOption=USER_ENTERED`,
    { values });
}

// Find an existing tab by exact title; returns null if not found.
export async function findTabByTitle(spreadsheetId, title) {
  const meta = await getSheetMetadata(spreadsheetId);
  return meta.tabs.find(t => t.title === title) ?? null;
}

// Build the canonical weekly-tab title from a JS Date. Mirrors existing Notable
// Issues sheet naming: "5/26/26" style (M/D/YY) for the post-2026 tabs.
// Tab title = the MONDAY of this week (when the count + Slack conversations
// happen). The workflow runs Tuesday but the data is from Monday, so we name
// the tab with the count date, not the report date. Mirrors the existing
// historical naming convention (all weekly tabs are dated to Mondays).
export function weekTabTitle(date = new Date()) {
  const d = mondayOf(date);
  const m = d.getMonth() + 1;
  const dd = d.getDate();
  const y = String(d.getFullYear()).slice(-2);
  return `${m}/${dd}/${y}`;
}

// Normalise any date to the Monday of its week (midnight, local).
export function mondayOf(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();                  // 0=Sun..6=Sat
  const offset = day === 0 ? 6 : day - 1;  // days since Monday
  d.setDate(d.getDate() - offset);
  d.setHours(0, 0, 0, 0);
  return d;
}

// The Slack history window a live run for `monday`'s week WOULD have used.
//
// A live run fires Tuesday ~17:00 UTC and looks back 7 days, so it captures
// [prev Tue 17:00, this Tue 17:00]. Reproducing that window exactly is what
// makes a backfilled tab match what the real run would have produced, rather
// than an arbitrary Mon-to-Mon slice that could double-count or drop messages
// at the boundary.
export function slackWindowForWeek(monday) {
  const latest = new Date(monday);
  latest.setDate(latest.getDate() + 1);    // Tuesday, the run day
  latest.setHours(17, 0, 0, 0);
  const oldest = new Date(latest);
  oldest.setDate(oldest.getDate() - 7);
  return { oldest, latest };
}

// Parse a variance tab title like "8/3", "08/03" or "8/3/26" into a Date,
// inferring the year from `nearDate` when the title omits it (Pati's tabs
// mostly don't carry one). Returns null when the title isn't a date.
export function parseVarianceTabDate(title, nearDate) {
  const m = String(title).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!m) return null;
  const month = Number(m[1]) - 1;
  const day = Number(m[2]);
  if (m[3]) {
    const y = Number(m[3]);
    return new Date(y < 100 ? 2000 + y : y, month, day);
  }
  // No year in the title: try the reference year and its neighbours, keeping
  // whichever lands closest to the target week. This is what makes a January
  // backfill not silently match a December tab from the wrong year.
  const baseYear = nearDate.getFullYear();
  let best = null;
  for (const y of [baseYear - 1, baseYear, baseYear + 1]) {
    const cand = new Date(y, month, day);
    if (!best || Math.abs(cand - nearDate) < Math.abs(best - nearDate)) best = cand;
  }
  return best;
}

// Read the variance week matching `monday` (within +/- toleranceDays), rather
// than whatever the newest tab happens to be. Backfilling a past week must not
// staple THIS week's dollar figures onto a month-old issue list.
//
// Returns { week: null, rows: [] } when the sheet has no tab for that week.
export async function readVarianceWeekFor(spreadsheetId, monday, toleranceDays = 4) {
  const meta = await getSheetMetadata(spreadsheetId);
  const tolerance = toleranceDays * 86400_000;
  let match = null;
  let matchDelta = Infinity;
  for (const t of meta.tabs) {
    const d = parseVarianceTabDate(t.title, monday);
    if (!d) continue;
    const delta = Math.abs(d - monday);
    if (delta <= tolerance && delta < matchDelta) {
      match = t;
      matchDelta = delta;
    }
  }
  if (!match) return { week: null, rows: [], sheetTitle: meta.title };
  const rows = await readRange(spreadsheetId, `${match.title}!A1:Z`);
  return { week: match.title, rows, sheetTitle: meta.title };
}
