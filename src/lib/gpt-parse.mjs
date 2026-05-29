// GPT-4o-mini parser via GitHub Models (Azure inference endpoint).
// Mirrors the prompt + filters used in inventory-workflow/index.html, but server-side.
// Reads no images — text-only parsing for v1. Image parsing can come later if needed.

const ENDPOINT = 'https://models.inference.ai.azure.com/chat/completions';
const MODEL = 'gpt-4o-mini';

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
- "Product not scanning" = product EXISTS in Craftable but barcode won't scan. Keywords: "doesn't scan", "barcode did not scan", "not scanning", "entered manually"
- "Product not in Craftable" = product does NOT EXIST in Craftable at all. Keywords: "not in craftable", "not in inventory", "can't find in system"
- "Scans as different item" = barcode scans but shows wrong product. Keywords: "scans as", "scans in as"
- "No Sticker" = no barcode sticker on the bottle
- "Missing" = product is missing or unaccounted for
- "Quantity mismatch" = count doesn't match expected
- "Mislabeled" = wrong label, misspelled in system, variant issue. Keywords: "should be removed", "misspelled", "wrong variant"
- "Other" = anything else

IMPORTANT — Be aggressive about extraction:
- "Remy Martin 1738 750ml doesnt scan" -> issue_type: "Product not scanning"
- "Red Bull peach 8.4oz not in Craftable" -> issue_type: "Product not in Craftable"
- "Not scanning in Back bar: Patron anejo 750ml" -> issue_type: "Product not scanning"
- "Not in Craftable, storage room: Maestro Dobel 50" -> issue_type: "Product not in Craftable"
- "Variant Moet 'Imperal' should be removed" -> issue_type: "Mislabeled"

H.Wood Group message format — staff often write: "product name, size, location, issue".

GROUPED FORMAT — Staff often list an issue type or location as a header, then products underneath. ALL items under that header inherit the issue_type and location until the next header.

ONLY skip a message if it has NO product name at all and just describes a location with a photo reference.

DEFAULT RULE — when there is no explicit issue keyword in a message (no "not scanning", "not in craftable", "no sticker", "scans as", etc.) but the message clearly names a product with a location and/or quantity, classify as "Other". NEVER leave issue_type blank. Do NOT guess at a more specific category when the message doesn't say so — "Other" is the correct answer for unclassified items.

When in doubt, INCLUDE the item. Combine duplicates. Return [] only if truly zero products named.

CRITICAL: Return ONLY a valid JSON array. No explanation, no prose, no markdown. Just the raw JSON array starting with [ and ending with ].`;
}

function safeJsonExtract(raw) {
  if (!raw) return [];
  // Strip code fences
  const stripped = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(stripped); } catch {}
  // Find a bracketed array
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) {
    try { return JSON.parse(arr[0]); } catch {}
  }
  return [];
}

// Parse a batch of Slack message texts for a single venue.
// Returns array of { item_name, issue_type, quantity, location, notes }
export async function parseVenueMessages(venue, messages) {
  if (!messages || messages.length === 0) return [];
  const token = process.env.GITHUB_MODELS_TOKEN;
  if (!token) throw new Error('Missing GITHUB_MODELS_TOKEN env var');

  const text = messages.join('\n\n---\n\n');
  const sysPrompt = buildSystemPrompt(venue);

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user',   content: text },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub Models ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content?.trim() ?? '';
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
