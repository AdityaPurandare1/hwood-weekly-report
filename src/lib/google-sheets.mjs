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

async function api(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(SHEETS_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Sheets ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
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

// Add a new tab to a spreadsheet. Returns the new sheetId.
export async function addTab(spreadsheetId, title) {
  const data = await api('POST', `/${spreadsheetId}:batchUpdate`, {
    requests: [{
      addSheet: { properties: { title } },
    }],
  });
  return data.replies[0].addSheet.properties.sheetId;
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
export function weekTabTitle(date = new Date()) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = String(date.getFullYear()).slice(-2);
  return `${m}/${d}/${y}`;
}
