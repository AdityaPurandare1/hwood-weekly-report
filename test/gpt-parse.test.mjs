// Tests for src/lib/gpt-parse.mjs
// parseVenueMessages calls fetch — we stub globalThis.fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseVenueMessages } from '../src/lib/gpt-parse.mjs';

// ---- helpers ----------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TOKEN = process.env.GITHUB_MODELS_TOKEN;

function setTokenForTest() {
  process.env.GITHUB_MODELS_TOKEN = 'test-token';
}

function restoreEnv() {
  if (ORIGINAL_TOKEN === undefined) delete process.env.GITHUB_MODELS_TOKEN;
  else process.env.GITHUB_MODELS_TOKEN = ORIGINAL_TOKEN;
}

function restoreFetch() {
  globalThis.fetch = ORIGINAL_FETCH;
}

// Helper to build a stub fetch that returns a fake GPT response with the given
// raw assistant content string.
function stubGptResponse(rawContent, { ok = true, status = 200 } = {}) {
  globalThis.fetch = async () => ({
    ok,
    status,
    async json() {
      return {
        choices: [{ message: { content: rawContent } }],
      };
    },
    async text() {
      return rawContent;
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

test('parseVenueMessages: throws when GITHUB_MODELS_TOKEN is missing', async () => {
  delete process.env.GITHUB_MODELS_TOKEN;
  try {
    await assert.rejects(
      () => parseVenueMessages('Test Venue', ['something']),
      /Missing GITHUB_MODELS_TOKEN/,
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
