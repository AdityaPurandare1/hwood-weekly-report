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
  TARGET_WEEK,
  SKIP_EMAIL,
} from './config.mjs';
import {
  getSheetMetadata,
  readRange,
  readLatestVarianceWeek,
  readVarianceWeekFor,
  addTab,
  writeValues,
  weekTabTitle,
  mondayOf,
  slackWindowForWeek,
  parseVarianceTabDate,
  findTabByTitle,
  clearTab,
  formatHeaderRow,
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
  if (!NOTABLE_ISSUES_SHEET_ID) {
    throw new Error('Missing NOTABLE_ISSUES_SHEET_ID env var');
  }

  // 1. Timezone guard — only skip if it's still EARLIER than the target hour
  //    locally. We deliberately do NOT cap the late side: GitHub Actions routinely
  //    delays scheduled runs by 1–3h (sometimes more), so a tight ±1h window made
  //    every scheduled run land after the band and skip. Letting late runs through
  //    is safe because the real-run path below is idempotent (tab overwrite) and
  //    emails exactly-once per week (see `shouldEmail`), so a delayed or duplicate
  //    firing won't double-write or double-send.
  // Backfill mode reconstructs a PAST week's tab. Everything downstream keys off
  // `targetMonday` + `slackWindow`; a normal run just uses this week and the
  // plain 7-day lookback, so the two paths stay one code path.
  const isBackfill = TARGET_WEEK !== null;
  const targetMonday = mondayOf(TARGET_WEEK ?? new Date());
  const slackWindow = isBackfill ? slackWindowForWeek(targetMonday) : 7;
  if (isBackfill) {
    console.log(`::notice::Backfill mode — rebuilding week of ${weekTabTitle(targetMonday)}`);
  }

  const isManual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const skipGuard = DRY_RUN || isManual || isBackfill;
  if (!skipGuard) {
    const guardHour = Number(process.env.GUARD_HOUR ?? 10);
    const hour = laHour();
    if (hour < guardHour - 1) {
      console.log('::notice::Skipping — too early locally (before guard hour)');
      return { skipped: true };
    }
  }

  // 2. Discover Pati's variance sheets from her DM.
  //    Backfill widens the DM lookback: the variance SPREADSHEET ids are stable
  //    per venue (Pati adds a tab per week to the same file), so any recent share
  //    resolves the right file — we then pick the target week's tab from inside it.
  const varianceSheets = await logGroupAsync('Discover variance sheets', async () => {
    const map = await findVarianceSheetsFromPati(isBackfill ? 60 : 7);
    const venues = Object.keys(map);
    console.log(`Found ${venues.length} variance sheets from Pati: ${venues.join(', ') || '(none)'}`);
    for (const v of VENUES) {
      if (!map[v]) {
        console.log(`::warning::No variance sheet from Pati ${isBackfill ? 'in the last 60 days' : 'this week'} for: ${v}`);
      }
    }
    return map;
  });

  // 3. Read variance per venue. Skip venues whose sheet isn't shared with us —
  //    one inaccessible venue shouldn't kill the whole run. We log the HTTP
  //    status per venue so a 403 (not shared with our account) is distinguishable
  //    from a 404 (wrong sheet id) when triaging "Pati's report wasn't considered".
  const varianceByVenue = await logGroupAsync('Read variance per venue', async () => {
    const result = {};
    const skippedVenues = [];
    for (const [venue, sheetId] of Object.entries(varianceSheets)) {
      try {
        const { week, rows } = isBackfill
          ? await readVarianceWeekFor(sheetId, targetMonday)
          : await readLatestVarianceWeek(sheetId);
        if (isBackfill && week === null) {
          console.log(`::warning::${venue}: no variance tab for the target week — issues will carry no $ exposure`);
          continue;
        }
        result[venue] = parseVarianceRows(rows);
        console.log(`${venue}: variance read OK (${result[venue].length} rows${isBackfill ? `, tab '${week}'` : ''})`);
      } catch (err) {
        skippedVenues.push(venue);
        const status = String(err?.message || '').match(/->\s*(\d{3})/)?.[1] ?? '???';
        const reason = status === '403' ? 'not shared with our Google account'
          : status === '404' ? 'sheet id not found'
          : `HTTP ${status}`;
        console.log(`::warning::${venue}: variance NOT considered — ${reason} (status ${status})`);
      }
    }
    console.log(`Variance considered for ${Object.keys(result).length}/${Object.keys(varianceSheets).length} venues` +
      (skippedVenues.length ? `; skipped: ${skippedVenues.join(', ')}` : ''));
    return result;
  });

  // 4. Pull venue messages + GPT parse.
  const notableIssues = await logGroupAsync('Pull + parse venue messages', async () => {
    const issues = [];
    let venuesWithIssues = 0;
    for (const venue of VENUES) {
      const messages = await pullVenueMessages(venue, slackWindow);
      if (!messages.length) {
        console.log(`::warning::${venue}: 0 Slack messages in window — nothing to parse (check the channel mapping if unexpected)`);
        continue;
      }
      const parsed = await parseVenueMessages(venue, messages);
      console.log(`${venue}: ${messages.length} messages -> ${parsed.length} parsed issues`);
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
    let datedTabs = meta.tabs.filter(t => /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(t.title));
    // Aging must only look BACKWARDS. On a normal run the newest 4 tabs are the
    // prior weeks by construction, but a backfill runs with later weeks possibly
    // already present, so drop anything at or after the target week. This also
    // makes backfills order-independent and safe to re-run.
    if (isBackfill) {
      datedTabs = datedTabs.filter(t => {
        const d = parseVarianceTabDate(t.title, targetMonday);
        return d && d < targetMonday;
      });
    }
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

  // 9. Real run — write tab + email. If a tab with this title already exists
  //    (e.g. re-running on the same day), clear it and overwrite — never duplicate.
  const finalTitle = weekTabTitle(targetMonday);
  const existing = await findTabByTitle(NOTABLE_ISSUES_SHEET_ID, finalTitle);
  let newSheetId;
  let isNewTab;
  if (existing) {
    newSheetId = existing.id;
    isNewTab = false;
    await clearTab(NOTABLE_ISSUES_SHEET_ID, finalTitle);
  } else {
    // index=0 puts the new tab at the leftmost position — matches the
    // historical Notable Issues sheet convention (newest week on the left).
    // Backfills run oldest-first so this convention still holds afterwards.
    newSheetId = await addTab(NOTABLE_ISSUES_SHEET_ID, finalTitle, 0);
    isNewTab = true;
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
  // Always re-apply formatting — idempotent and keeps re-runs visually identical.
  await formatHeaderRow(NOTABLE_ISSUES_SHEET_ID, newSheetId, header.length);
  console.log(`${isNewTab ? 'Wrote' : 'Updated'} tab '${finalTitle}' with ${ranked.length} rows`);

  // Email exactly-once per week. A scheduled run only emails when it CREATED this
  // week's tab; a redundant/delayed scheduled firing finds the tab already there
  // and overwrites it silently without re-emailing. Manual runs always email so a
  // deliberate re-run after fixing data still notifies recipients.
  // Backfills stay silent unless --email is passed: rebuilding five missed weeks
  // should not fire five "this week's report" notifications at the recipients.
  const shouldEmail = (isNewTab || isManual) && !SKIP_EMAIL;
  const tabUrl = `https://docs.google.com/spreadsheets/d/${NOTABLE_ISSUES_SHEET_ID}/edit#gid=${newSheetId}`;
  if (shouldEmail) {
    const sendResult = await sendReport({
      tabTitle: finalTitle,
      tabUrl,
      rowCount: ranked.length,
      byPriority,
    });
    console.log(`Emailed report to ${sendResult.sentTo} recipient(s)`);
  } else if (SKIP_EMAIL) {
    console.log(`Backfill run — skipped email (pass --email to send)`);
  } else {
    console.log(`Tab already existed this week — skipped email (no duplicate send)`);
  }

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
