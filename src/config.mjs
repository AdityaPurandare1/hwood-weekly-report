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
  { pattern: /Poppy.*Weekly Variance/i,          venue: 'Poppy' },
  { pattern: /Final Count.*Poppy/i,              venue: 'Poppy' }, // legacy naming
];

// Output: the Notable Issues Google Sheet we write a new tab into each week.
// Real ID comes from the NOTABLE_ISSUES_SHEET_ID secret. No fallback —
// the orchestrator checks this is set before using it.
export const NOTABLE_ISSUES_SHEET_ID = process.env.NOTABLE_ISSUES_SHEET_ID || '';

// Slack channels for venue inventory chatter (mirrors inventory-workflow app).
export const VENUE_SLACK_CHANNELS = {
  'Bird Streets Club':  process.env.SLACK_CHANNEL_BSC,
  'Delilah - LA':       process.env.SLACK_CHANNEL_DELILAH_LA,
  'Deliliah - Miami':   process.env.SLACK_CHANNEL_DELILAH_MIAMI,
  'Keys':               process.env.SLACK_CHANNEL_KEYS,
  'Poppy':              process.env.SLACK_CHANNEL_POPPY,
  'The Nice Guy':       process.env.SLACK_CHANNEL_NICE_GUY,
};

// Pati's DM channel ID (starts with "D") — read variance links only from her DMs.
// Get it from Slack: open the DM with Pati, click her profile, scroll to "Channel ID".
export const PATI_DM_CHANNEL_ID = process.env.PATI_DM_CHANNEL_ID;

// Email
export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'Hwood Inventory Bot <onboarding@resend.dev>';
// Real values come from GitHub Secrets / .env.local — never hardcoded here.
export const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO ?? '';
export const EMAIL_RECIPIENTS = (process.env.EMAIL_RECIPIENTS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Misc
export const DRY_RUN = process.argv.includes('--dry-run');

// Backfill support — `--week=YYYY-MM-DD` regenerates the tab for a PAST week
// instead of the current one. Used to fill the gap left by a stretch of failed
// runs. The date may be any day in the target week; it is normalised to that
// week's Monday (the count date, which is what tabs are named after).
//
// Parsed from explicit components rather than `new Date(str)` so the week is
// interpreted in the runner's local zone — `new Date('2026-08-03')` is UTC
// midnight, which lands on the previous day (and thus the previous WEEK) for
// any runner behind UTC.
function parseTargetWeek() {
  const arg = process.argv.find(a => a.startsWith('--week='));
  if (!arg) return null;
  const raw = arg.slice('--week='.length).trim();
  const m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) throw new Error(`Invalid --week value '${raw}' — expected YYYY-MM-DD`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid --week date '${raw}'`);
  return d;
}

export const TARGET_WEEK = parseTargetWeek();

// Backfilled weeks don't email by default — regenerating five missed weeks
// should not fire five "this week's report" notifications. `--email` forces it.
export const SKIP_EMAIL = TARGET_WEEK !== null && !process.argv.includes('--email');
