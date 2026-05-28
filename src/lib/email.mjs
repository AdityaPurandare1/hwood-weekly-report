// Resend wrapper — sends the weekly report email with a link to the new sheet tab.
// Recipient addresses are NEVER returned, logged, or echoed; only the count is exposed.

import { Resend } from 'resend';
import { EMAIL_FROM, EMAIL_REPLY_TO, EMAIL_RECIPIENTS } from '../config.mjs';

// Returns { id, sentTo: count }. NEVER returns or logs recipient addresses.
export async function sendReport({ tabTitle, tabUrl, rowCount, byPriority }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Missing RESEND_API_KEY env var');

  const p1 = byPriority?.P1 ?? 0;
  const p2 = byPriority?.P2 ?? 0;
  const p3 = byPriority?.P3 ?? 0;
  const total = rowCount ?? (p1 + p2 + p3);

  const subject = `Weekly Notable Issues — ${tabTitle}`;

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
  <p style="margin:0 0 16px;">Hi team,</p>
  <p style="margin:0 0 16px;">The Notable Issues report for the week of <strong>${escapeHtml(tabTitle)}</strong> is ready.</p>
  <table style="border-collapse:collapse;margin:0 0 20px;font-size:14px;">
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Total issues</td><td style="padding:4px 0;font-weight:600;">${total}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#b00020;">P1 (recurring + $50+)</td><td style="padding:4px 0;font-weight:600;">${p1}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#c97a00;">P2</td><td style="padding:4px 0;font-weight:600;">${p2}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#555;">P3</td><td style="padding:4px 0;font-weight:600;">${p3}</td></tr>
  </table>
  <p style="margin:0 0 24px;">
    <a href="${encodeURI(tabUrl)}" style="background:#1a73e8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;display:inline-block;">Open this week's tab</a>
  </p>
  <p style="margin:0 0 4px;color:#666;font-size:13px;">Generated automatically by the Hwood Inventory Bot.</p>
  <p style="margin:0;color:#888;font-size:12px;">Reply-to: ${escapeHtml(EMAIL_REPLY_TO)}</p>
</body></html>`;

  const text = [
    `Weekly Notable Issues — ${tabTitle}`,
    '',
    `Total issues: ${total}`,
    `  P1: ${p1}`,
    `  P2: ${p2}`,
    `  P3: ${p3}`,
    '',
    `Open this week's tab: ${tabUrl}`,
    '',
    '— Hwood Inventory Bot',
  ].join('\n');

  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to: EMAIL_RECIPIENTS,
    replyTo: EMAIL_REPLY_TO,
    subject,
    html,
    text,
  });

  if (result.error) {
    // Strip any address-looking tokens from the upstream error before bubbling.
    const msg = String(result.error.message ?? result.error).replace(/[\w.+-]+@[\w.-]+/g, '[REDACTED]');
    throw new Error(`Resend send failed: ${msg.slice(0, 200)}`);
  }

  return { id: result.data?.id, sentTo: EMAIL_RECIPIENTS.length };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
