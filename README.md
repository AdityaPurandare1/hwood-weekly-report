# Hwood Weekly Notable Issues Report

Automated weekly pipeline that pulls inventory issues from Slack, joins them
against Pati's weekly variance sheets, writes a new dated tab to the Notable
Issues Google Sheet, and emails a summary to the distribution list.

Runs every Tuesday at 10am Pacific via GitHub Actions, with a manual `Run workflow`
trigger available for ad-hoc executions and dry runs.

## How it works

```
Slack DM (Pati's variance links) ──┐
                                    ├─► join + rank ──► new Sheet tab ──► email
Slack venue channels ──► GPT parse ─┘
       │
       └─► prior 4 weekly tabs (aging / recurrence)
```

1. **Discover variance sheets** — read Pati's Slack DM, look at unfurled Google
   Sheets attachments, match each title against a per-venue regex.
2. **Read variance** — for each venue, pull the most recent dated tab from her
   sheet (Item / Variance / Replacement Value / Audit Results / Error Cause).
3. **Pull venue messages** — read the last 7 days of messages from each venue's
   inventory Slack channel.
4. **GPT parse** — send each venue's messages to `gpt-4o-mini` (via GitHub
   Models) using the same prompt as the live inventory-workflow app. Output is a
   normalized list of issues.
5. **Aging** — pull the last 4 dated tabs from the Notable Issues sheet to count
   how many weeks each `(venue, product, issue_type)` has been flagged.
6. **Join + rank** — match issues to variance rows, compute `$ exposure`, assign
   `P1` / `P2` / `P3`, sort.
7. **Write tab + email** — add a new tab named like `5/27/26` (falls back to
   `5-27-26` if Google rejects the slash), write the ranked rows, send a Resend
   email with the link and counts.

## Required GitHub Secrets

| Name | Where to get it | Example format |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google Cloud Console OAuth client | `*.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console OAuth client | `GOCSPX-...` |
| `GOOGLE_REFRESH_TOKEN` | OAuth playground or local script, scope `spreadsheets` | `1//0g...` |
| `SLACK_TOKEN` | Slack user token (xoxp) with `channels:history`, `groups:history`, `im:history`, `conversations.list` | `xoxp-...` |
| `GH_MODELS_TOKEN` | GitHub PAT with `models:read` scope (re-exposed to the script as `GITHUB_MODELS_TOKEN`) | `ghp_...` |
| `RESEND_API_KEY` | Resend dashboard | `re_...` |
| `PATI_SLACK_USER_ID` | Pati's Slack profile -> More -> Copy member ID | `U01ABC2DEF` |
| `NOTABLE_ISSUES_SHEET_ID` | The `/d/<id>/` segment of the Notable Issues sheet URL | 44-char alphanumeric |
| `EMAIL_RECIPIENTS` | Comma-separated list of recipient addresses | `a@x.com,b@y.com` |

> **Note on `GH_MODELS_TOKEN`** — GitHub forbids secret names with the `GITHUB_`
> prefix, so the secret is named `GH_MODELS_TOKEN` and the workflow maps it onto
> the `GITHUB_MODELS_TOKEN` env var the script expects.

## Required Repository Variables (non-secret config)

Configured under Settings -> Secrets and variables -> Actions -> Variables.

| Name | Purpose | Example |
| --- | --- | --- |
| `EMAIL_FROM` | Sender shown on the email | `Hwood Inventory Bot <bot@yourdomain.com>` |
| `EMAIL_REPLY_TO` | Reply-to header | `you@yourdomain.com` |
| `SLACK_CHANNEL_BSC` | BSC inventory channel name (no `#`) | `bsc-inventory` |
| `SLACK_CHANNEL_DELILAH_LA` | Delilah LA inventory channel | `delilah-la-inventory` |
| `SLACK_CHANNEL_DELILAH_MIAMI` | Delilah Miami inventory channel | `delilah-miami-inventory` |
| `SLACK_CHANNEL_KEYS` | Keys inventory channel | `keys-inventory` |
| `SLACK_CHANNEL_POPPY` | Poppy inventory channel | `poppy-inventory` |
| `SLACK_CHANNEL_NICE_GUY` | Nice Guy inventory channel | `nice-guy-inventory` |

## Running manually

1. Go to the repo's **Actions** tab.
2. Pick **Weekly Notable Issues Report** in the left sidebar.
3. Click **Run workflow**.
4. Optionally tick the `Dry run` checkbox — the pipeline will pull and parse
   everything but skip the sheet write and the email, printing a summary block
   in the Actions log instead.

The timezone guard is skipped for manual runs, so you can trigger at any hour.

## Running locally

Requires Node 20.6+ (for `--env-file`).

```bash
node --env-file=.env.local src/index.mjs --dry-run
```

Sample `.env.local` (put real values in, never commit this file):

```bash
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
GOOGLE_REFRESH_TOKEN=1//0gxxx
SLACK_TOKEN=xoxp-xxx
GITHUB_MODELS_TOKEN=ghp_xxx
RESEND_API_KEY=re_xxx
PATI_SLACK_USER_ID=U01ABC2DEF
NOTABLE_ISSUES_SHEET_ID=<44-char id>
EMAIL_FROM=Hwood Inventory Bot <bot@yourdomain.com>
EMAIL_REPLY_TO=you@yourdomain.com
EMAIL_RECIPIENTS=you@yourdomain.com
SLACK_CHANNEL_BSC=bsc-inventory
SLACK_CHANNEL_DELILAH_LA=delilah-la-inventory
SLACK_CHANNEL_DELILAH_MIAMI=delilah-miami-inventory
SLACK_CHANNEL_KEYS=keys-inventory
SLACK_CHANNEL_POPPY=poppy-inventory
SLACK_CHANNEL_NICE_GUY=nice-guy-inventory
```

Drop the `--dry-run` flag when you're ready to actually write the tab and send
the email — and double-check the recipient list before you do.

## Architecture

- `src/index.mjs` — orchestrator. Timezone guard, sequencing, logging, scrubbing.
- `src/config.mjs` — venue list, regex patterns for Pati's sheet titles, env
  var plumbing, `DRY_RUN` flag.
- `src/lib/google-sheets.mjs` — OAuth refresh-token flow, `getSheetMetadata`,
  `readRange`, `readLatestVarianceWeek`, `addTab`, `writeValues`, `weekTabTitle`.
- `src/lib/slack.mjs` — Slack Web API wrapper. Reads Pati's DM, resolves venue
  channel names to IDs, pulls message history.
- `src/lib/gpt-parse.mjs` — GitHub Models / `gpt-4o-mini` parser. Same system
  prompt and validation as the live inventory-workflow web app.
- `src/lib/join.mjs` — variance match, weeks-flagged aging, priority assignment,
  ranking. No I/O — pure functions.
- `src/lib/email.mjs` — Resend wrapper. Recipient addresses never appear in
  return values or logs; only the count.

## Public repo note

This repo can be left public without leaking business data:

- All sensitive values come from GitHub Secrets, never from source.
- Logs use group blocks with counts only (`Parsed 12 issues across 4 venues`),
  never item names, dollar amounts, recipient emails, or sheet IDs.
- Errors are scrubbed before being printed: long alphanumeric tokens, email
  addresses, and dollar amounts are replaced with `[REDACTED]`.

If extra paranoia is ever needed, the repo can be flipped to private with zero
code changes — Actions, Secrets, and Variables all keep working identically.
