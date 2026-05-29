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
  const d = new Date(date);
  const day = d.getDay();                  // 0=Sun..6=Sat
  const offset = day === 0 ? 6 : day - 1;  // days since Monday
  d.setDate(d.getDate() - offset);
  const m = d.getMonth() + 1;
  const dd = d.getDate();
  const y = String(d.getFullYear()).slice(-2);
  return `${m}/${dd}/${y}`;
}
