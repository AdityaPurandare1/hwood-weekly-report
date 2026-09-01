// Slack Web API client — used to:
//  1. Read Pati's DM and find Google Sheets variance links for each venue
//  2. Pull messages from venue inventory channels (for GPT to parse into Notable Issues)
//
// Uses your existing xoxp user token (read-only by intent — no posting).

import { VENUE_TITLE_PATTERNS, VENUE_SLACK_CHANNELS, PATI_DM_CHANNEL_ID } from '../config.mjs';

const SLACK = 'https://slack.com/api';

async function slack(method, params = {}, opts = {}) {
  const token = process.env.SLACK_TOKEN;
  if (!token) throw new Error('Missing SLACK_TOKEN env var');

  const url = opts.body
    ? `${SLACK}/${method}`
    : `${SLACK}/${method}?${new URLSearchParams(params).toString()}`;

  const res = await fetch(url, {
    method: opts.body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`);
  return data;
}

// Resolve a lookback spec into Slack's {oldest, latest} epoch-second bounds.
//
// `window` is either a number of days back from now (the weekly-run case) or an
// explicit { oldest: Date, latest: Date } pair (the backfill case, where we need
// a CLOSED window around a past week rather than everything since a start date).
function historyBounds(window) {
  if (window && typeof window === 'object') {
    return {
      oldest: String(Math.floor(window.oldest.getTime() / 1000)),
      latest: String(Math.floor(window.latest.getTime() / 1000)),
    };
  }
  const daysBack = window ?? 7;
  return { oldest: String(Math.floor((Date.now() - daysBack * 86400_000) / 1000)) };
}

// Pull messages from a channel within the last N days, or within an explicit
// { oldest, latest } Date window.
async function readChannelHistory(channelId, window = 7) {
  const bounds = historyBounds(window);
  const messages = [];
  let cursor;
  for (let i = 0; i < 5; i++) { // hard cap on pagination
    const data = await slack('conversations.history', {
      channel: channelId,
      ...bounds,
      limit: '100',
      ...(cursor ? { cursor } : {}),
    });
    messages.push(...(data.messages ?? []));
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return messages;
}

// Extract a Google Sheets spreadsheet ID from a URL (or return null).
function extractSheetId(url) {
  if (!url) return null;
  const m = url.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// Map a Slack-unfurl attachment title to one of our 6 venues, or null if no match.
function venueFromTitle(title) {
  for (const { pattern, venue } of VENUE_TITLE_PATTERNS) {
    if (pattern.test(title)) return venue;
  }
  return null;
}

// Returns { 'Bird Streets Club': '<sheetId>', 'Delilah - LA': '<sheetId>', ... }
// Only venues Pati posted for THIS week are included.
//
// Pati shares Google Sheets via Drive integration, so they show up in msg.files[]
// as filetype=gsheet, external_type=gdrive. We also fall back to attachment unfurls
// in case she ever pastes a URL directly.
export async function findVarianceSheetsFromPati(window = 7) {
  if (!PATI_DM_CHANNEL_ID) {
    throw new Error('Missing PATI_DM_CHANNEL_ID env var (her DM channel ID, starts with "D")');
  }
  const messages = await readChannelHistory(PATI_DM_CHANNEL_ID, window);

  const result = {};
  // Walk newest-first; first match per venue wins (most recent share).
  for (const msg of messages) {
    // Primary: Drive-integration files
    for (const f of msg.files ?? []) {
      if (f.filetype !== 'gsheet') continue;
      const titleSource = f.name || f.title || '';
      const venue = venueFromTitle(titleSource);
      if (!venue || result[venue]) continue;
      const sheetId = extractSheetId(f.external_url || f.url_private || f.permalink);
      if (sheetId) result[venue] = sheetId;
    }
    // Fallback: pasted-URL unfurl attachments
    for (const att of msg.attachments ?? []) {
      if (att.service_name !== 'Google Sheets') continue;
      const venue = venueFromTitle(att.title ?? '');
      if (!venue || result[venue]) continue;
      const sheetId = extractSheetId(att.title_link ?? att.original_url ?? att.from_url);
      if (sheetId) result[venue] = sheetId;
    }
  }
  return result;
}

// Resolve a channel NAME (like "delilah-la-inventory") to its channel ID.
// We cache via a simple in-memory lookup since this runs once per venue per execution.
const channelIdCache = new Map();
async function resolveChannelId(channelName) {
  if (channelIdCache.has(channelName)) return channelIdCache.get(channelName);

  let cursor;
  for (let i = 0; i < 20; i++) {
    const data = await slack('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '1000',
      ...(cursor ? { cursor } : {}),
    });
    for (const ch of data.channels ?? []) {
      if (ch.name === channelName) {
        channelIdCache.set(channelName, ch.id);
        return ch.id;
      }
    }
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  throw new Error(`Slack channel not found: #${channelName}`);
}

// Pull plain-text messages from a venue's inventory channel.
// Returns array of message strings (no attachments — those are a future enhancement).
export async function pullVenueMessages(venue, window = 7) {
  const channelName = VENUE_SLACK_CHANNELS[venue];
  if (!channelName) return [];
  const channelId = await resolveChannelId(channelName);
  const messages = await readChannelHistory(channelId, window);
  return messages
    .filter(m => m.type === 'message' && !m.subtype && m.text)
    .map(m => m.text);
}
