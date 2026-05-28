// Weekly Notable Issues pipeline entry point.
//
// Sequence: timezone guard -> discover Pati's variance sheets -> read variance ->
// pull venue Slack -> GPT parse -> read prior weekly tabs for aging -> join + rank ->
// (dry-run: summary only) | (real: write tab + email).
//
// Logs are designed to be safe for a PUBLIC GitHub Actions log: no item names, no
// dollar amounts, no recipient addresses, no sheet IDs. Counts only.

import {
  VENUES,
  NOTABLE_ISSUES_SHEET_ID,
  DRY_RUN,
} from './config.mjs';
import {
  getSheetMetadata,
  readRange,
  readLatestVarianceWeek,
  addTab,
  writeValues,
  weekTabTitle,
} from './lib/google-sheets.mjs';
import {
  findVarianceSheetsFromPati,
  pullVenueMessages,
} from './lib/slack.mjs';
import { parseVenueMessages } from './lib/gpt-parse.mjs';
import { joinAndRank, parseVarianceRows, priorWeekIssuesFromTabs } from './lib/join.mjs';
import { sendReport } from './lib/email.mjs';

function logGroup(name, fn) {
  console.log(`::group::${name}`);
  try { return fn(); } finally { console.log('::endgroup::'); }
}

async function logGroupAsync(name, fn) {
  console.log(`::group::${name}`);
  try { return await fn(); } finally { console.log('::endgroup::'); }
}

function laHour(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    hour12: false,
  });
  return Number(fmt.format(date));
}

function scrubMessage(msg) {
  let s = String(msg ?? '').slice(0, 200);
  s = s.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');     // sheet IDs, tokens
  s = s.replace(/[\w.+-]+@[\w.-]+/g, '[REDACTED]');       // emails
  s = s.replace(/\$?\d+\.\d{2}/g, '[REDACTED]');          // dollar amounts
  return s;
}

async function main() {
  // 1. Timezone guard — only run when local LA hour is within ±1 of GUARD_HOUR.
  const skipGuard = DRY_RUN || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  if (!skipGuard) {
    const guardHour = Number(process.env.GUARD_HOUR ?? 10);
    const hour = laHour();
    if (hour < guardHour - 1 || hour > guardHour + 1) {
      console.log('::notice::Skipping — not the right hour locally');
      return { skipped: true };
    }
  }

  // 2. Discover Pati's variance sheets from her DM.
  const varianceSheets = await logGroupAsync('Discover variance sheets', async () => {
    const map = await findVarianceSheetsFromPati(7);
    console.log(`Found ${Object.keys(map).length} variance sheets`);
    return map;
  });

  // 3. Read variance per venue. Skip venues whose sheet isn't shared with us —
  //    one inaccessible venue shouldn't kill the whole run.
  const varianceByVenue = await logGroupAsync('Read variance per venue', async () => {
    const result = {};
    let skipped = 0;
    for (const [venue, sheetId] of Object.entries(varianceSheets)) {
      try {
        const { rows } = await readLatestVarianceWeek(sheetId);
        result[venue] = parseVarianceRows(rows);
      } catch (err) {
        skipped++;
        console.log(`::warning::Variance read skipped for one venue (sheet inaccessible — likely a share-permission issue)`);
      }
    }
    console.log(`Read variance for ${Object.keys(result).length} venues${skipped ? `, skipped ${skipped}` : ''}`);
    return result;
  });

  // 4. Pull venue messages + GPT parse.
  const notableIssues = await logGroupAsync('Pull + parse venue messages', async () => {
    const issues = [];
    let venuesWithIssues = 0;
    for (const venue of VENUES) {
      const messages = await pullVenueMessages(venue, 7);
      if (!messages.length) continue;
      const parsed = await parseVenueMessages(venue, messages);
      if (parsed.length) venuesWithIssues++;
      for (const p of parsed) {
        issues.push({
          venue,
          item_name: p.item_name,
          issue_type: p.issue_type,
          quantity: p.quantity ?? null,
          location: p.location ?? null,
          notes: p.notes ?? '',
        });
      }
    }
    console.log(`Parsed ${issues.length} issues across ${venuesWithIssues} venues`);
    return issues;
  });

  // 5. Read prior 4 weekly tabs for aging.
  const priorWeekIssues = await logGroupAsync('Read prior weekly tabs', async () => {
    const meta = await getSheetMetadata(NOTABLE_ISSUES_SHEET_ID);
    const datedTabs = meta.tabs.filter(t => /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(t.title));
    const priorTabs = datedTabs.slice(0, 4);
    const tabResults = [];
    for (const t of priorTabs) {
      const rows = await readRange(NOTABLE_ISSUES_SHEET_ID, `${t.title}!A1:Z`);
      tabResults.push(rows);
    }
    console.log(`Read ${tabResults.length} prior weekly tabs`);
    return priorWeekIssuesFromTabs(tabResults);
  });

  // 6. Join + rank.
  const ranked = joinAndRank({ notableIssues, varianceByVenue, priorWeekIssues });

  // 7. Summary counts.
  const byPriority = { P1: 0, P2: 0, P3: 0 };
  for (const r of ranked) {
    if (byPriority[r.priority] !== undefined) byPriority[r.priority]++;
  }

  // 8. Dry-run path — summary block only, no write, no email.
  if (DRY_RUN) {
    logGroup('Summary', () => {
      const venuesWithVariance = Object.values(varianceByVenue).filter(v => v.length > 0).length;
      const venuesWithIssues = new Set(notableIssues.map(i => i.venue)).size;
      console.log(`total issues:       ${ranked.length}`);
      console.log(`  P1: ${byPriority.P1}`);
      console.log(`  P2: ${byPriority.P2}`);
      console.log(`  P3: ${byPriority.P3}`);
      console.log(`venues with variance: ${venuesWithVariance}`);
      console.log(`venues with issues:   ${venuesWithIssues}`);
    });
    return { dryRun: true, total: ranked.length, byPriority };
  }

  // 9. Real run — write tab + email.
  const title = weekTabTitle();
  let finalTitle = title;
  let newSheetId;
  try {
    newSheetId = await addTab(NOTABLE_ISSUES_SHEET_ID, finalTitle);
  } catch (err) {
    // Google sometimes rejects '/' in tab titles. Retry with dashes.
    finalTitle = title.replaceAll('/', '-');
    newSheetId = await addTab(NOTABLE_ISSUES_SHEET_ID, finalTitle);
  }

  const header = ['Store','Product','Issue','Location','Recurring','Bottle Count','Description','Weeks Flagged','$ Exposure','Audit Status','Priority'];
  const rows = [header, ...ranked.map(r => [
    r.venue,
    r.product,
    r.issue,
    r.location,
    r.recurring,
    r.bottle_count,
    r.description,
    r.weeks_flagged,
    r.variance_dollars,
    r.audit_status,
    r.priority,
  ])];

  await writeValues(NOTABLE_ISSUES_SHEET_ID, finalTitle, rows);
  console.log(`Wrote tab '${finalTitle}' with ${ranked.length} rows`);

  const tabUrl = `https://docs.google.com/spreadsheets/d/${NOTABLE_ISSUES_SHEET_ID}/edit#gid=${newSheetId}`;
  const sendResult = await sendReport({
    tabTitle: finalTitle,
    tabUrl,
    rowCount: ranked.length,
    byPriority,
  });
  console.log(`Emailed report to ${sendResult.sentTo} recipient(s)`);

  return { total: ranked.length, byPriority, venuesWithIssues: new Set(notableIssues.map(i => i.venue)).size };
}

main()
  .then(result => {
    if (result?.skipped || result?.dryRun) return;
    const total = result?.total ?? 0;
    const v = result?.venuesWithIssues ?? 0;
    console.log(`::notice::Weekly report complete: ${total} issues across ${v} venues`);
  })
  .catch(err => {
    console.log(`::error::Weekly report failed: ${scrubMessage(err.message)}`);
    process.exit(1);
  });
