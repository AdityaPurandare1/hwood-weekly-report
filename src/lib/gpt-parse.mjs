// Slack-message issue parser via the Google Gemini API (AI Studio free tier).
// Mirrors the prompt + filters used in inventory-workflow/index.html, but server-side.
// Reads no images — text-only parsing for v1. Image parsing can come later if needed.
//
// Previously ran on GitHub Models (gpt-4o-mini). That service was retired in Aug 2026
// (410 github_models_retirement_brownout), which broke every run from 2026-08-04 on.
// Gemini 2.5 Flash is the replacement: free tier, no billing card, 10 RPM / 250 RPD —
// far above this pipeline's ~6 calls per weekly run.

// Free-tier quota is per-model-per-day (GenerateRequestsPerDayPerProjectPerModel),
// and for gemini-2.5-flash that ceiling is only 20 requests — enough for the ~6
// calls of a normal weekly run, but a backfill of several weeks exhausts it.
// Overridable so a quota wall or another model retirement is a variable change,
// not a code change: the GitHub Models retirement that caused the Aug 2026
// outage would have been a one-line fix if this had been configurable.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const ISSUE_TYPES = [
  'Product not scanning',
  'Product not in Craftable',
  'Scans as different item',
  'No Sticker',
  'Missing',
  'Quantity mismatch',
  'Mislabeled',
  'Other',
];

// Gemini structured-output schema (OpenAPI subset). Constrains the model to emit
// exactly the shape joinAndRank expects, so no prose/fence stripping is needed.
// NOTE: this subset supports `enum` but NOT numeric bounds (minimum/maximum) —
// adding those makes the request 400.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    issues: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          item_name: { type: 'STRING' },
          issue_type: { type: 'STRING', enum: ISSUE_TYPES },
          quantity: { type: 'INTEGER', nullable: true },
          location: { type: 'STRING', nullable: true },
          notes: { type: 'STRING', nullable: true },
        },
        required: ['item_name', 'issue_type'],
        propertyOrdering: ['item_name', 'issue_type', 'quantity', 'location', 'notes'],
      },
    },
  },
  required: ['issues'],
};

const SIZE_TOKENS = new Set([
  '750ml','1l','375ml','700ml','1000ml','500ml','200ml','187ml','15l','175l',
  '84oz','84floz','12oz','112floz','16floz','32floz','64oz','05gal','1gal',
  '1each','1pack','8oz','750','375','700','1000','ml','oz','l','fl',
  '720ml','739ml','250ml','360ml',
]);

const JUNK_NAMES = new Set([
  'bottle','bottles','fridge','rack','room','shelf','bar','floor','stickers',
  'sticker','craftable','wine','liquor','champagne','find','non','no','ceramic',
  'small','product','not','scanning','does','scan','doesnt','one','two','three',
  'four','five','six','seven','eight','nine','ten','row','rows','quantity','qty',
  'located','labeled','unlabeled','unmarked','missing','damaged','bev','beverage',
  'inventory','2nd','3rd','1st','4th','to','in','the','and','or','from','with',
  'for','this','that','dont','prep','unknown','item','items','complete','done',
  'wells','low',
]);

function isValidProductName(name) {
  if (!name || typeof name !== 'string' || name.length < 4) return false;
  const words = name.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !SIZE_TOKENS.has(w));
  if (words.length === 0) return false;
  const meaningful = words.filter(w => !JUNK_NAMES.has(w) && !/^\d+$/.test(w));
  return meaningful.length >= 1;
}

function buildSystemPrompt(venue) {
  return `You are an inventory issue parser for "${venue}" (H.Wood Group).

Parse these Slack messages and extract EVERY inventory issue you can find. Be thorough — extract ALL items mentioned by name, even casually. Return a JSON array.

For each issue found:
{ "item_name": "Full product name with size", "sku": null, "issue_type": "(see below)", "quantity": number|null, "location": "where in venue"|null, "notes": "brief description max 120 chars" }

ISSUE TYPE — use the EXACT correct one. These are DIFFERENT issues:
- "Product not scanning" = product EXISTS in Craftable but barcode won't scan. Keywords: "doesn't scan", "barcode did not scan", "not scanning", "entered manually", "won't scan" (when paired with "vintage not in system", prefer "Product not in Craftable" — see below)
- "Product not in Craftable" = product does NOT EXIST in Craftable at all. Keywords: "not in craftable", "not in inventory", "not in system", "missing from system", "missing from craftable", "can't find in system", "can't find in craftable", "vintage not in system", "year not in system", "variant not in system"
- "Scans as different item" = barcode scans but shows wrong product. Keywords: "scans as", "scans in as"
- "No Sticker" = no barcode sticker on the bottle
- "Missing" = product is missing or unaccounted for
- "Quantity mismatch" = count doesn't match expected
- "Mislabeled" = wrong label, misspelled in system, variant issue. Keywords: "should be removed", "misspelled", "wrong variant"
- "Other" = anything else

When both "won't scan" AND "not in system/craftable/inventory" appear in the same message (very common pattern: "won't scan- vintage not in system"), prefer "Product not in Craftable" because the root cause is the missing record, not the barcode.

IMPORTANT — Be aggressive about extraction:
- "Remy Martin 1738 750ml doesnt scan" -> issue_type: "Product not scanning"
- "Red Bull peach 8.4oz not in Craftable" -> issue_type: "Product not in Craftable"
- "Not scanning in Back bar: Patron anejo 750ml" -> issue_type: "Product not scanning"
- "Not in Craftable, storage room: Maestro Dobel 50" -> issue_type: "Product not in Craftable"
- "Variant Moet 'Imperal' should be removed" -> issue_type: "Mislabeled"

H.Wood Group message format — staff often write: "product name, size, location, issue".

GROUPED FORMAT — Staff often list an issue type or location as a header, then products underneath. ALL items under that header inherit the issue_type and location until the next header.

MULTI-LINE FORMAT — When a single message spans multiple lines, the FIRST line is very often the LOCATION (e.g. "Wine tree", "Bar fridges", "Liquor rack", "Stacks", "Service well"), the MIDDLE lines describe the product (name, vintage, size), and the LAST line describes the issue and/or quantity. Example:
  "Wine tree
   Tyler 2023 pinot noir
   Santa barbara county 750ml
   2 bottles not in system"
-> item_name: "Tyler 2023 Pinot Noir Santa Barbara County 750ml", location: "Wine tree", quantity: 2, issue_type: "Product not in Craftable", notes: "not in system"

Combine multi-line product descriptions into one item_name (e.g. "Tyler 2023 pinot noir" + "Santa barbara county 750ml" -> "Tyler 2023 Pinot Noir Santa Barbara County 750ml"). NEVER leave location blank when the first line of a multi-line message looks like a venue area.

ONLY skip a message if it has NO product name at all and just describes a location with a photo reference.

DEFAULT RULE — when there is no explicit issue keyword in a message (no "not scanning", "not in craftable", "no sticker", "scans as", etc.) but the message clearly names a product with a location and/or quantity, classify as "Other". NEVER leave issue_type blank. Do NOT guess at a more specific category when the message doesn't say so — "Other" is the correct answer for unclassified items.

When in doubt, INCLUDE the item. Combine duplicates. Return [] only if truly zero products named.

CRITICAL: Return ONLY a valid JSON array. No explanation, no prose, no markdown. Just the raw JSON array starting with [ and ending with ].`;
}

// Accepts either the schema shape ({ issues: [...] }) or a bare array, so a
// fallback/no-schema response still parses. Fence + prose stripping is retained
// as a belt-and-braces path.
function normalizeIssues(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.issues)) return value.issues;
  return [];
}

function safeJsonExtract(raw) {
  if (!raw) return [];
  // Strip code fences
  const stripped = raw.replace(/```json|```/g, '').trim();
  try { return normalizeIssues(JSON.parse(stripped)); } catch {}
  // Find a bracketed array
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) {
    try { return normalizeIssues(JSON.parse(arr[0])); } catch {}
  }
  // Find a bracketed object
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) {
    try { return normalizeIssues(JSON.parse(obj[0])); } catch {}
  }
  return [];
}

// Gemini answers 503 UNAVAILABLE when the model is momentarily overloaded, and
// 429 when the free tier's per-minute quota is hit. Both clear on their own, but
// unretried they abort the whole weekly run partway through — which is exactly
// how the 8/3 backfill died. 4xx other than 429 are permanent (bad key, bad
// request) and fail fast.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A 429 is a per-MINUTE quota, so exponential backoff starting at 1s just burns
// attempts inside the same window. Google returns the exact wait in a RetryInfo
// detail (`"retryDelay": "27s"`); honour it when present, else back off in
// minute-scale steps.
export function retryDelayMs(status, bodyText, attempt) {
  if (status !== 429) return 1000 * 2 ** (attempt - 1);        // 1s, 2s, 4s
  const hinted = String(bodyText).match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (hinted) return Math.ceil(Number(hinted[1]) * 1000) + 1000; // +1s of slack
  return [15000, 30000, 45000][attempt - 1] ?? 45000;
}

async function postWithRetry(body, token) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': token },
        body,
      });
    } catch (err) {
      lastErr = new Error(`Gemini network error: ${err.message}`);
      if (attempt === MAX_ATTEMPTS) throw lastErr;
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return res.json();

    const t = await res.text();
    lastErr = new Error(`Gemini ${res.status}: ${t.slice(0, 200)}`);
    if (!RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) throw lastErr;
    await sleep(retryDelayMs(res.status, t, attempt));
  }
  throw lastErr;
}

// Parse a batch of Slack message texts for a single venue.
// Returns array of { item_name, issue_type, quantity, location, notes }
export async function parseVenueMessages(venue, messages) {
  if (!messages || messages.length === 0) return [];
  const token = process.env.GEMINI_API_KEY;
  if (!token) throw new Error('Missing GEMINI_API_KEY env var');

  const text = messages.join('\n\n---\n\n');
  const sysPrompt = buildSystemPrompt(venue);

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: sysPrompt }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8000,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      // Extraction, not reasoning — thinking tokens would just eat the output
      // budget and risk a MAX_TOKENS truncation mid-array.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const data = await postWithRetry(body, token);

  // A prompt blocked by safety filters comes back 200 with no candidate.
  const candidate = data?.candidates?.[0];
  const blockReason = data?.promptFeedback?.blockReason;
  if (!candidate && blockReason) {
    throw new Error(`Gemini blocked the prompt: ${blockReason}`);
  }
  if (candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new Error(`Gemini stopped early: ${candidate.finishReason}`);
  }

  const raw = (candidate?.content?.parts ?? [])
    .map(p => p?.text ?? '')
    .join('')
    .trim();
  let parsed = safeJsonExtract(raw);
  if (!Array.isArray(parsed)) parsed = [];
  return parsed
    .filter(i => i && i.item_name && isValidProductName(i.item_name))
    .map(i => ({
      ...i,
      // Safety net: if GPT left issue_type blank/missing, label as "Other"
      // instead of an empty cell.
      issue_type: (i.issue_type && String(i.issue_type).trim()) || 'Other',
    }));
}
