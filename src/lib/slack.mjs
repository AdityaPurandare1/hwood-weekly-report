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

// Pull messages from a channel within the last N days.
async function readChannelHistory(channelId, daysBack = 7) {
  const oldest = Math.floor((Date.now() - daysBack * 86400_000) / 1000);
  const messages = [];
  let cursor;
  for (let i = 0; i < 5; i++) { // hard cap on pagination
    const data = await slack('conversations.history', {
      channel: channelId,
      oldest: String(oldest),
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
export async function findVarianceSheetsFromPati(daysBack = 7) {
  if (!PATI_DM_CHANNEL_ID) {
    throw new Error('Missing PATI_DM_CHANNEL_ID env var (her DM channel ID, starts with "D")');
  }
  const messages = await readChannelHistory(PATI_DM_CHANNEL_ID, daysBack);

  const result = {};
  // Walk newest-first; first match per venue wins (most recent share).
  for (const msg of messages) {
    for (const att of msg.attachments ?? []) {
      if (att.service_name !== 'Google Sheets') continue;
      const venue = venueFromTitle(att.title ?? '');
      if (!venue) continue;
      if (result[venue]) continue; // already have a newer one
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
export async function pullVenueMessages(venue, daysBack = 7) {
  const channelName = VENUE_SLACK_CHANNELS[venue];
  if (!channelName) return [];
  const channelId = await resolveChannelId(channelName);
  const messages = await readChannelHistory(channelId, daysBack);
  return messages
    .filter(m => m.type === 'message' && !m.subtype && m.text)
    .map(m => m.text);
}
