#!/usr/bin/env node
// scripts/mint-google-token.mjs
//
// Re-mint the Google OAuth refresh token for the weekly report and store it in
// the GitHub Actions secret GOOGLE_REFRESH_TOKEN — without ever printing the token.
//
// WHY THIS EXISTS
//   If the Google OAuth consent screen is in "Testing" mode, Google expires every
//   refresh token it issues after 7 days. Symptom: the weekly run fails with
//       Google token refresh failed: {"error":"invalid_grant",
//       "error_description":"Token has been expired or revoked."}
//   PERMANENT FIX (do once): Google Cloud Console -> APIs & Services ->
//   OAuth consent screen -> "Publish app" (Testing -> In production). The
//   `spreadsheets` scope is sensitive (not restricted) for a single internal
//   user, so no Google verification is required. After that, refresh tokens no
//   longer expire on a timer. Then run this script to mint a working token.
//
// USAGE
//   node scripts/mint-google-token.mjs            # mint + set the GitHub secret (token never shown)
//   node scripts/mint-google-token.mjs --print    # mint + print to stdout instead (you set the secret)
//   node scripts/mint-google-token.mjs --repo owner/name --port 4117
//
//   Reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from the environment or a local .env file.
//   Requires the GitHub CLI (`gh`) authenticated for the target repo (unless --print).
//
// NOTE on redirect URI: this uses http://localhost:<port>. If you see
// "redirect_uri_mismatch", either use a Desktop-app OAuth client (loopback works
// on any port automatically) or add http://localhost:4117 to the OAuth client's
// "Authorized redirect URIs" in the Cloud Console.

import http from "node:http";
import { exec, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { URL } from "node:url";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_REPO = "AdityaPurandare1/hwood-weekly-report";
const DEFAULT_PORT = 4117;

function flagValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return fallback;
}
const PRINT_ONLY = process.argv.includes("--print");
const REPO = flagValue("repo", DEFAULT_REPO);
const PORT = Number(flagValue("port", DEFAULT_PORT));

// Load a local .env (no dependency) so the client id/secret can live there.
function loadDotEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
loadDotEnv();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (set them in your environment or a local .env file).");
  process.exit(1);
}

const REDIRECT_URI = `http://localhost:${PORT}`;
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  prompt: "consent", // force a fresh refresh_token on every run
  include_granted_scopes: "true",
}).toString();

function openBrowser(url) {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, () => {}); // best-effort; URL is also printed below
}

async function exchangeCode(code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  return res.json();
}

console.log("\nOpening the Google consent screen in your browser.");
console.log("If it does not open automatically, paste this URL:\n");
console.log("  " + authUrl.toString() + "\n");
console.log(`Waiting for the OAuth redirect on ${REDIRECT_URI} ...`);
openBrowser(authUrl.toString());

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT_URI);
  const code = u.searchParams.get("code");
  const consentError = u.searchParams.get("error");
  if (!code && !consentError) {
    res.writeHead(204).end(); // ignore favicon / stray requests; keep listening
    return;
  }

  const respond = (heading) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
      <h2>${heading}</h2><p>You can close this tab and return to the terminal.</p></body></html>`);
  };

  try {
    if (consentError) throw new Error("Consent was denied or failed: " + consentError);
    const tok = await exchangeCode(code);
    if (!tok.refresh_token) {
      throw new Error(
        "No refresh_token in the response: " + JSON.stringify(tok) +
        "\nThis usually means consent was not fully granted. The script already sends prompt=consent, so retry and click Allow."
      );
    }
    const refreshToken = tok.refresh_token; // never logged

    if (PRINT_ONLY) {
      respond("Token minted — copy it from your terminal.");
      console.log("\n=== GOOGLE_REFRESH_TOKEN (set this as the GitHub secret) ===\n");
      console.log(refreshToken + "\n");
    } else {
      // Set the secret directly. Passed via argv on your own machine; NO trailing
      // newline (the `gh secret set --body -`/stdin path is what adds stray newlines).
      execFileSync("gh", ["secret", "set", "GOOGLE_REFRESH_TOKEN", "--repo", REPO, "--body", refreshToken], { stdio: "inherit" });
      respond("Token minted and saved to the GitHub secret. Done!");
      console.log(`\nGOOGLE_REFRESH_TOKEN updated on ${REPO} (the token was never printed).`);
      console.log(`Re-run the workflow to confirm:\n  gh workflow run "Weekly Notable Issues Report" --repo ${REPO}\n`);
    }
  } catch (e) {
    respond("Something went wrong — check the terminal.");
    console.error("\nERROR: " + (e?.message || e) + "\n");
    process.exitCode = 1;
  } finally {
    server.close();
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
});

server.on("error", (e) => {
  console.error(`\nCould not start the loopback server on ${REDIRECT_URI}: ${e.message}`);
  console.error("If the port is busy, pass a different one with --port <n> (and register it on the OAuth client if it's a Web-type client).\n");
  process.exit(1);
});
server.listen(PORT);
