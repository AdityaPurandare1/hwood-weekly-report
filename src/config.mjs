// Configuration — venue mappings, sheet IDs, schedule.
// Sensitive values (tokens, keys) come from environment variables, never from this file.

export const VENUES = [
  'Bird Streets Club',
  'Delilah - LA',
  'Deliliah - Miami',   // matches existing sheet's typo
  'Keys',
  'Poppy',
  'The Nice Guy',
];

// Title patterns to match Pati's variance sheets in your Slack DM.
// First match wins. Case-insensitive substring match on the unfurl title.
export const VENUE_TITLE_PATTERNS = [
  { pattern: /BSC.*Weekly Variance/i,            venue: 'Bird Streets Club' },
  { pattern: /Delilah\s*LA.*Weekly Variance/i,   venue: 'Delilah - LA' },
  { pattern: /Delilah\s*Miami.*Weekly Variance/i,venue: 'Deliliah - Miami' },
  { pattern: /Keys.*Weekly Variance/i,           venue: 'Keys' },
  { pattern: /Nice\s*Guy.*Weekly Variance/i,     venue: 'The Nice Guy' },
  { pattern: /Final Count.*Poppy/i,              venue: 'Poppy' },
];

// Output: the Notable Issues Google Sheet we write a new tab into each week.
export const NOTABLE_ISSUES_SHEET_ID = process.env.NOTABLE_ISSUES_SHEET_ID
  ?? '1uEd9H7eDQc1f7fF3O0RjdgJT9QpWUUnyaajuSOcWCRE';

// Slack channels for venue inventory chatter (mirrors inventory-workflow app).
export const VENUE_SLACK_CHANNELS = {
  'Bird Streets Club':  process.env.SLACK_CHANNEL_BSC,
  'Delilah - LA':       process.env.SLACK_CHANNEL_DELILAH_LA,
  'Deliliah - Miami':   process.env.SLACK_CHANNEL_DELILAH_MIAMI,
  'Keys':               process.env.SLACK_CHANNEL_KEYS,
  'Poppy':              process.env.SLACK_CHANNEL_POPPY,
  'The Nice Guy':       process.env.SLACK_CHANNEL_NICE_GUY,
};

// Pati's Slack user ID (so we read variance links only from her DMs, not anyone else).
// Set this env var with her ID from Slack — get it via /open in DM, then click her name.
export const PATI_SLACK_USER_ID = process.env.PATI_SLACK_USER_ID;

// Email
export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'Hwood Inventory Bot <onboarding@resend.dev>';
// Real values come from GitHub Secrets / .env.local — never hardcoded here.
export const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO ?? '';
export const EMAIL_RECIPIENTS = (process.env.EMAIL_RECIPIENTS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Misc
export const DRY_RUN = process.argv.includes('--dry-run');
