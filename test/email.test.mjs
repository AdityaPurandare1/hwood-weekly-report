// Tests for src/lib/email.mjs — sendReport().
// config.mjs reads EMAIL_RECIPIENTS at import time, so we set env BEFORE importing.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---- env setup (must happen before importing email.mjs) ---------------------

const ORIGINAL_RESEND_KEY = process.env.RESEND_API_KEY;
const ORIGINAL_RECIPIENTS = process.env.EMAIL_RECIPIENTS;
const ORIGINAL_FROM = process.env.EMAIL_FROM;
const ORIGINAL_REPLY_TO = process.env.EMAIL_REPLY_TO;

process.env.RESEND_API_KEY = 'test_key';
process.env.EMAIL_RECIPIENTS = 'test1@example.com,test2@example.com';
process.env.EMAIL_FROM = 'Test Bot <bot@example.com>';
process.env.EMAIL_REPLY_TO = 'replyto@example.com';

// Dynamic imports so env is in place first.
const { sendReport } = await import('../src/lib/email.mjs');
const { EMAIL_RECIPIENTS, EMAIL_REPLY_TO } = await import('../src/config.mjs');
const { Resend } = await import('resend');

// `send` lives on Emails.prototype. Stub it there so we never hit the network.
const EmailsProto = Object.getPrototypeOf(new Resend('test').emails);

function stubSend(impl) {
  return mock.method(EmailsProto, 'send', impl);
}

function restoreAll(spy) {
  if (spy) spy.mock.restore();
}

// ---- tests ------------------------------------------------------------------

test('sendReport: throws "Missing RESEND_API_KEY env var" when key is absent', async () => {
  delete process.env.RESEND_API_KEY;
  try {
    await assert.rejects(
      () => sendReport({ tabTitle: 'Test Week', tabUrl: 'https://example.com', byPriority: { P1: 0, P2: 0, P3: 0 } }),
      /Missing RESEND_API_KEY/,
    );
  } finally {
    process.env.RESEND_API_KEY = 'test_key';
  }
});

test('sendReport: successful send returns { id, sentTo } with sentTo === EMAIL_RECIPIENTS.length', async () => {
  const spy = stubSend(async () => ({ data: { id: 'mock-email-id' }, error: null }));
  try {
    const out = await sendReport({
      tabTitle: 'Test Week',
      tabUrl: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=1',
      rowCount: 3,
      byPriority: { P1: 1, P2: 1, P3: 1 },
    });
    assert.equal(out.id, 'mock-email-id');
    assert.equal(out.sentTo, EMAIL_RECIPIENTS.length);
    assert.equal(out.sentTo, 2);
  } finally {
    restoreAll(spy);
  }
});

test('sendReport: Resend payload includes either replyTo (camelCase) or reply_to (snake_case)', async () => {
  // The SDK v4 expects camelCase `replyTo`. Source currently passes `reply_to`.
  // This test documents which one is actually sent, so the orchestrator can route
  // any mismatch to the debugger.
  let observedPayload = null;
  const spy = stubSend(async (payload) => {
    observedPayload = payload;
    return { data: { id: 'x' }, error: null };
  });
  try {
    await sendReport({
      tabTitle: 'Test Week',
      tabUrl: 'https://example.com',
      rowCount: 0,
      byPriority: { P1: 0, P2: 0, P3: 0 },
    });
    const hasCamel = observedPayload.replyTo === EMAIL_REPLY_TO;
    const hasSnake = observedPayload.reply_to === EMAIL_REPLY_TO;
    assert.ok(
      hasCamel || hasSnake,
      `Resend payload must set replyTo or reply_to. Got: replyTo=${JSON.stringify(observedPayload.replyTo)}, reply_to=${JSON.stringify(observedPayload.reply_to)}`,
    );
    // Document which key the source actually sets (the SDK v4 only honors `replyTo`).
    assert.ok(
      hasCamel,
      'SDK v4 only honors camelCase `replyTo`. Source uses snake_case `reply_to` — the reply-to header will be DROPPED.',
    );
  } finally {
    restoreAll(spy);
  }
});

test('sendReport: returned object does NOT leak recipient addresses', async () => {
  const spy = stubSend(async () => ({ data: { id: 'mock-id' }, error: null }));
  try {
    const out = await sendReport({
      tabTitle: 'Test Week',
      tabUrl: 'https://example.com',
      rowCount: 0,
      byPriority: { P1: 0, P2: 0, P3: 0 },
    });
    const blob = JSON.stringify(out);
    assert.ok(!blob.includes('test1@example.com'), 'return value must not contain recipient address');
    assert.ok(!blob.includes('test2@example.com'), 'return value must not contain recipient address');
  } finally {
    restoreAll(spy);
  }
});

test('sendReport: thrown error message does NOT leak recipient addresses', async () => {
  // Simulate Resend returning an error containing a recipient email — the wrapper
  // should redact it before throwing.
  const spy = stubSend(async () => ({
    data: null,
    error: { message: 'invalid recipient: test1@example.com' },
  }));
  try {
    await assert.rejects(
      () => sendReport({
        tabTitle: 'Test Week',
        tabUrl: 'https://example.com',
        rowCount: 0,
        byPriority: { P1: 0, P2: 0, P3: 0 },
      }),
      (err) => {
        assert.ok(!err.message.includes('test1@example.com'), `error must redact email; got: ${err.message}`);
        return true;
      },
    );
  } finally {
    restoreAll(spy);
  }
});

test('sendReport: HTML body contains a clickable link to tabUrl', async () => {
  let observed = null;
  const spy = stubSend(async (payload) => {
    observed = payload;
    return { data: { id: 'x' }, error: null };
  });
  try {
    const tabUrl = 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=42';
    await sendReport({
      tabTitle: 'Test Week',
      tabUrl,
      rowCount: 0,
      byPriority: { P1: 0, P2: 0, P3: 0 },
    });
    assert.ok(observed.html.includes('<a href="'), 'HTML must contain an anchor tag');
    // encodeURI preserves most URL chars including #, /, ?, =
    assert.ok(observed.html.includes(tabUrl), `HTML must contain the tabUrl. Got: ${observed.html.slice(0, 300)}`);
  } finally {
    restoreAll(spy);
  }
});

test('sendReport: HTML body contains the P1/P2/P3 counts (numbers only, no item names)', async () => {
  let observed = null;
  const spy = stubSend(async (payload) => {
    observed = payload;
    return { data: { id: 'x' }, error: null };
  });
  try {
    await sendReport({
      tabTitle: 'Test Week',
      tabUrl: 'https://example.com',
      rowCount: 7,
      byPriority: { P1: 3, P2: 2, P3: 2 },
    });
    // Counts should be present somewhere in the HTML.
    assert.match(observed.html, /P1/i);
    assert.match(observed.html, /P2/i);
    assert.match(observed.html, /P3/i);
    // The literal numbers should appear too.
    assert.ok(observed.html.includes('>3<'), 'P1 count "3" must appear in HTML');
    assert.ok(observed.html.includes('>2<'), 'P2/P3 count "2" must appear in HTML');
    assert.ok(observed.html.includes('>7<'), 'total "7" must appear in HTML');
    // And no fake item name should leak in.
    assert.ok(!observed.html.includes('Test Item 750ml'));
  } finally {
    restoreAll(spy);
  }
});

test('sendReport: subject contains tabTitle', async () => {
  let observed = null;
  const spy = stubSend(async (payload) => {
    observed = payload;
    return { data: { id: 'x' }, error: null };
  });
  try {
    await sendReport({
      tabTitle: 'Week of 2026-05-25',
      tabUrl: 'https://example.com',
      rowCount: 0,
      byPriority: { P1: 0, P2: 0, P3: 0 },
    });
    assert.ok(observed.subject.includes('Week of 2026-05-25'),
      `subject should contain tabTitle. Got: ${observed.subject}`);
  } finally {
    restoreAll(spy);
  }
});

// ---- restore env after suite ------------------------------------------------

test('teardown: restore env vars', () => {
  if (ORIGINAL_RESEND_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_RESEND_KEY;
  if (ORIGINAL_RECIPIENTS === undefined) delete process.env.EMAIL_RECIPIENTS;
  else process.env.EMAIL_RECIPIENTS = ORIGINAL_RECIPIENTS;
  if (ORIGINAL_FROM === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = ORIGINAL_FROM;
  if (ORIGINAL_REPLY_TO === undefined) delete process.env.EMAIL_REPLY_TO;
  else process.env.EMAIL_REPLY_TO = ORIGINAL_REPLY_TO;
  assert.ok(true);
});
