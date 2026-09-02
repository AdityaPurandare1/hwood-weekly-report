// Tests for src/lib/gpt-parse.mjs
// parseVenueMessages calls fetch — we stub globalThis.fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseVenueMessages, retryDelayMs } from '../src/lib/gpt-parse.mjs';

// ---- helpers ----------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TOKEN = process.env.GEMINI_API_KEY;

function setTokenForTest() {
  process.env.GEMINI_API_KEY = 'test-token';
}

function restoreEnv() {
  if (ORIGINAL_TOKEN === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_TOKEN;
}

function restoreFetch() {
  globalThis.fetch = ORIGINAL_FETCH;
}

// Helper to build a stub fetch that returns a fake Gemini response carrying the
// given raw model output string.
function stubGptResponse(rawContent, { ok = true, status = 200, finishReason = 'STOP' } = {}) {
  globalThis.fetch = async () => ({
    ok,
    status,
    async json() {
      return {
        candidates: [{ finishReason, content: { parts: [{ text: rawContent }] } }],
      };
    },
    async text() {
      return rawContent;
    },
  });
}

// Stub for responses with no candidate (e.g. prompt blocked by safety filters).
function stubGeminiBlocked(blockReason) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { promptFeedback: { blockReason } };
    },
    async text() {
      return '';
    },
  });
}

// ---- tests ------------------------------------------------------------------

test('parseVenueMessages: empty messages array returns [] without calling fetch', async () => {
  setTokenForTest();
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    const out = await parseVenueMessages('Test Venue', []);
    assert.deepEqual(out, []);
    assert.equal(fetchCalled, false, 'fetch must NOT be called when messages are empty');
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: throws when GEMINI_API_KEY is missing', async () => {
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      () => parseVenueMessages('Test Venue', ['something']),
      /Missing GEMINI_API_KEY/,
    );
  } finally {
    restoreEnv();
  }
});

test('parseVenueMessages: plain JSON array response is parsed', async () => {
  setTokenForTest();
  stubGptResponse(JSON.stringify([
    {
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
      quantity: 1,
      location: 'Bar',
      notes: 'test',
    },
  ]));
  try {
    const out = await parseVenueMessages('Test Venue', ['msg1']);
    assert.equal(out.length, 1);
    assert.equal(out[0].item_name, 'Test Item 750ml');
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: ```json fenced block is stripped and parsed', async () => {
  setTokenForTest();
  const arr = [
    {
      item_name: 'Test Item 750ml',
      issue_type: 'Missing',
      quantity: 1,
      location: 'Bar',
      notes: 'test',
    },
  ];
  stubGptResponse('```json\n' + JSON.stringify(arr) + '\n```');
  try {
    const out = await parseVenueMessages('Test Venue', ['msg1']);
    assert.equal(out.length, 1);
    assert.equal(out[0].item_name, 'Test Item 750ml');
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: extracts JSON array embedded in prose', async () => {
  setTokenForTest();
  const arr = [
    { item_name: 'Test Item 750ml', issue_type: 'Missing' },
  ];
  stubGptResponse(`Here is what I found:\n${JSON.stringify(arr)}\nThat is all.`);
  try {
    const out = await parseVenueMessages('Test Venue', ['msg1']);
    assert.equal(out.length, 1);
    assert.equal(out[0].item_name, 'Test Item 750ml');
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: malformed JSON returns []', async () => {
  setTokenForTest();
  stubGptResponse('this is not JSON at all { broken');
  try {
    const out = await parseVenueMessages('Test Venue', ['msg1']);
    assert.deepEqual(out, []);
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: non-2xx response throws with status code', async () => {
  setTokenForTest();
  stubGptResponse('Unauthorized', { ok: false, status: 401 });
  try {
    await assert.rejects(
      () => parseVenueMessages('Test Venue', ['msg1']),
      /401/,
    );
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: filters junk names (isValidProductName) — keeps "Test Item 750ml", drops "missing bottles"', async () => {
  setTokenForTest();
  stubGptResponse(JSON.stringify([
    { item_name: 'Test Item 750ml', issue_type: 'Missing' },
    { item_name: 'missing bottles', issue_type: 'Missing' },   // both words in JUNK_NAMES
  ]));
  try {
    const out = await parseVenueMessages('Test Venue', ['msg1']);
    assert.equal(out.length, 1, 'only valid item should survive');
    assert.equal(out[0].item_name, 'Test Item 750ml');
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: items with no item_name field are filtered out', async () => {
  setTokenForTest();
  stubGptResponse(JSON.stringify([
    { item_name: 'Test Item 750ml', issue_type: 'Missing' },
    { item_name: '', issue_type: 'Missing' },
    { issue_type: 'Missing' },                  // missing entirely
    null,                                       // null entry
  ]));
  try {
    const out = await parseVenueMessages('Test Venue', ['msg1']);
    assert.equal(out.length, 1);
    assert.equal(out[0].item_name, 'Test Item 750ml');
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: when GPT returns a non-array (object), returns []', async () => {
  setTokenForTest();
  stubGptResponse(JSON.stringify({ items: [] }));   // object, not array
  try {
    const out = await parseVenueMessages('Test Venue', ['msg1']);
    assert.deepEqual(out, []);
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: schema-shaped { issues: [...] } response is unwrapped', async () => {
  setTokenForTest();
  stubGptResponse(JSON.stringify({
    issues: [
      { item_name: 'Test Item 750ml', issue_type: 'Missing', quantity: 2, location: 'Bar', notes: 'x' },
    ],
  }));
  try {
    const out = await parseVenueMessages('Test Venue', ['msg1']);
    assert.equal(out.length, 1);
    assert.equal(out[0].item_name, 'Test Item 750ml');
    assert.equal(out[0].quantity, 2);
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: multi-part response text is concatenated before parsing', async () => {
  setTokenForTest();
  const payload = JSON.stringify({ issues: [{ item_name: 'Test Item 750ml', issue_type: 'Missing' }] });
  const mid = Math.floor(payload.length / 2);
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: payload.slice(0, mid) }, { text: payload.slice(mid) }] },
        }],
      };
    },
    async text() { return payload; },
  });
  try {
    const out = await parseVenueMessages('Test Venue', ['msg1']);
    assert.equal(out.length, 1);
    assert.equal(out[0].item_name, 'Test Item 750ml');
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: blank issue_type defaults to "Other"', async () => {
  setTokenForTest();
  stubGptResponse(JSON.stringify({
    issues: [{ item_name: 'Test Item 750ml', issue_type: '  ' }],
  }));
  try {
    const out = await parseVenueMessages('Test Venue', ['msg1']);
    assert.equal(out.length, 1);
    assert.equal(out[0].issue_type, 'Other');
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: safety-blocked prompt throws with the block reason', async () => {
  setTokenForTest();
  stubGeminiBlocked('SAFETY');
  try {
    await assert.rejects(
      () => parseVenueMessages('Test Venue', ['msg1']),
      /Gemini blocked the prompt: SAFETY/,
    );
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: abnormal finishReason throws', async () => {
  setTokenForTest();
  stubGptResponse('', { finishReason: 'RECITATION' });
  try {
    await assert.rejects(
      () => parseVenueMessages('Test Venue', ['msg1']),
      /Gemini stopped early: RECITATION/,
    );
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

// ---- transient-failure retry ------------------------------------------------

// Build a stub that fails with `status` for the first `failures` calls, then
// succeeds. Returns a counter so tests can assert the number of attempts.
function stubFlaky(failures, status, payload) {
  const state = { calls: 0 };
  globalThis.fetch = async () => {
    state.calls++;
    if (state.calls <= failures) {
      return {
        ok: false,
        status,
        async json() { return {}; },
        async text() { return `{"error":{"code":${status}}}`; },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: payload }] } }] };
      },
      async text() { return payload; },
    };
  };
  return state;
}

test('parseVenueMessages: retries a 503 and succeeds on the next attempt', async () => {
  setTokenForTest();
  const payload = JSON.stringify({ issues: [{ item_name: 'Test Item 750ml', issue_type: 'Missing' }] });
  const state = stubFlaky(1, 503, payload);
  try {
    const out = await parseVenueMessages('Test Venue', ['msg1']);
    assert.equal(state.calls, 2, 'should have retried exactly once');
    assert.equal(out.length, 1);
    assert.equal(out[0].item_name, 'Test Item 750ml');
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: retries a 429 rate-limit response', async () => {
  setTokenForTest();
  const payload = JSON.stringify({ issues: [] });
  const state = stubFlaky(1, 429, payload);
  try {
    await parseVenueMessages('Test Venue', ['msg1']);
    assert.equal(state.calls, 2);
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: does NOT retry a permanent 400', async () => {
  setTokenForTest();
  const state = stubFlaky(99, 400, '');
  try {
    await assert.rejects(() => parseVenueMessages('Test Venue', ['msg1']), /Gemini 400/);
    assert.equal(state.calls, 1, 'a 400 must fail fast, not burn retries');
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('parseVenueMessages: does NOT retry a permanent 403 (bad key)', async () => {
  setTokenForTest();
  const state = stubFlaky(99, 403, '');
  try {
    await assert.rejects(() => parseVenueMessages('Test Venue', ['msg1']), /Gemini 403/);
    assert.equal(state.calls, 1);
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

// ---- 429 backoff sizing -----------------------------------------------------

test('retryDelayMs: non-429 statuses use fast exponential backoff', () => {
  assert.equal(retryDelayMs(503, '', 1), 1000);
  assert.equal(retryDelayMs(503, '', 2), 2000);
  assert.equal(retryDelayMs(503, '', 3), 4000);
});

test('retryDelayMs: a 429 without a hint backs off on a minute scale', () => {
  // A sub-second retry inside a per-minute quota window just burns an attempt.
  assert.ok(retryDelayMs(429, '', 1) >= 15000);
  assert.ok(retryDelayMs(429, '', 2) >= 30000);
});

test("retryDelayMs: Google's retryDelay hint is honoured", () => {
  const body = '{"error":{"details":[{"@type":"...RetryInfo","retryDelay":"27s"}]}}';
  assert.equal(retryDelayMs(429, body, 1), 28000);   // hint + 1s slack
});

test('retryDelayMs: fractional retryDelay hint rounds up', () => {
  const body = '{"retryDelay":"1.5s"}';
  assert.equal(retryDelayMs(429, body, 1), 2500);
});
