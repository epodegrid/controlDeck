#!/usr/bin/env node
/**
 * A local token broker for tools that only accept a static API key.
 *
 * opencode, GitHub Copilot's custom-endpoint mode, and most OpenAI-compatible
 * clients take one fixed `apiKey` string and send it forever. Entra access
 * tokens live 60–90 minutes. Pasting one in works until lunchtime and then
 * fails in the middle of something.
 *
 * This sits on localhost, holds the *refresh* token, and mints a fresh access
 * token before each request needs one. The tool is pointed at
 * http://127.0.0.1:8787/v1 with any placeholder key and never learns that
 * OAuth happened.
 *
 *   node controldeck-token-broker.mjs login    # once, interactively
 *   node controldeck-token-broker.mjs serve    # then leave running
 *
 * No dependencies: Node 20+ only.
 */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const CONFIG = {
  tenantId: process.env.CONTROLDECK_TENANT_ID ?? "",
  clientId: process.env.CONTROLDECK_CLIENT_ID ?? "",
  /** The API's Application ID URI. `.default` asks for everything consented. */
  scope:
    process.env.CONTROLDECK_SCOPE ??
    "api://llm-gateway/.default offline_access",
  gateway: process.env.CONTROLDECK_GATEWAY ?? "",
  port: Number(process.env.CONTROLDECK_BROKER_PORT ?? 8787),
  /** Override for testing against a stub identity provider. */
  authority:
    process.env.CONTROLDECK_AUTHORITY ??
    `https://login.microsoftonline.com/${process.env.CONTROLDECK_TENANT_ID ?? ""}`,
  statePath:
    process.env.CONTROLDECK_STATE ?? join(homedir(), ".controldeck", "token.json"),
};

/**
 * Refresh this long before expiry rather than on failure.
 *
 * Reacting to a 401 means one request has already failed, and for a streaming
 * client that failure is visible mid-task — which is the entire problem this
 * exists to solve. Five minutes also covers a request that takes a while to
 * start: the token is checked when the request is admitted, not when it ends.
 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function requireConfig(...keys) {
  const missing = keys.filter((k) => !CONFIG[k]);
  if (missing.length > 0) {
    die(
      `Missing configuration: ${missing.map((k) => `CONTROLDECK_${k.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}`).join(", ")}\n` +
        `See docs/client-authentication.md.`
    );
  }
}

async function loadState() {
  try {
    return JSON.parse(await readFile(CONFIG.statePath, "utf8"));
  } catch {
    return null;
  }
}

async function saveState(state) {
  await mkdir(dirname(CONFIG.statePath), { recursive: true });
  await writeFile(CONFIG.statePath, JSON.stringify(state, null, 2));
  // The refresh token is a 90-day credential for this user. It should not be
  // world-readable on a shared machine.
  await chmod(CONFIG.statePath, 0o600);
}

async function tokenRequest(form) {
  const res = await fetch(`${CONFIG.authority}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** Device code flow: the only interactive flow that works over SSH. */
async function login() {
  requireConfig("tenantId", "clientId");

  const res = await fetch(`${CONFIG.authority}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CONFIG.clientId, scope: CONFIG.scope }),
  });
  const start = await res.json();
  if (!res.ok) {
    die(`Could not start device login: ${start.error_description ?? JSON.stringify(start)}`);
  }

  console.log(`\n${start.message ?? `Go to ${start.verification_uri} and enter ${start.user_code}`}\n`);

  const deadline = Date.now() + (start.expires_in ?? 900) * 1000;
  let interval = (start.interval ?? 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const poll = await tokenRequest({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: CONFIG.clientId,
      device_code: start.device_code,
    });

    if (poll.ok) {
      await persist(poll.body);
      console.log("Signed in. Refresh token stored at", CONFIG.statePath);
      return;
    }
    // Expected while the user is still typing their password.
    if (poll.body.error === "authorization_pending") continue;
    // Entra asks us to back off rather than refusing outright.
    if (poll.body.error === "slow_down") {
      interval += 5000;
      continue;
    }
    die(`Sign-in failed: ${poll.body.error_description ?? poll.body.error}`);
  }
  die("Sign-in timed out.");
}

async function persist(token) {
  if (!token.refresh_token) {
    die(
      "Entra returned no refresh token. Add `offline_access` to CONTROLDECK_SCOPE — " +
        "without it every access token is a dead end and this broker cannot do its job."
    );
  }
  await saveState({
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    // expires_in is seconds from now; store the absolute moment instead so a
    // restart does not treat an old token as fresh.
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
  });
}

let inFlight = null;

/**
 * A valid access token, refreshed if it is close to expiry.
 *
 * Concurrent callers share one refresh: refresh tokens rotate on use, so two
 * simultaneous refreshes race to invalidate each other's replacement.
 */
async function currentToken() {
  const state = await loadState();
  if (!state) die("Not signed in. Run: controldeck-token-broker login");

  if (state.accessToken && state.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return state.accessToken;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const res = await tokenRequest({
      grant_type: "refresh_token",
      client_id: CONFIG.clientId,
      refresh_token: state.refreshToken,
      scope: CONFIG.scope,
    });
    if (!res.ok) {
      // A revoked or expired refresh token is the one case needing a human.
      throw new Error(
        `Refresh failed (${res.status}): ${res.body.error_description ?? res.body.error}. ` +
          `Run: controldeck-token-broker login`
      );
    }
    await persist(res.body);
    return res.body.access_token;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Headers that must not be copied onto a proxied request. */
const STRIPPED = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "authorization",
]);

async function serve() {
  requireConfig("tenantId", "clientId", "gateway");
  await currentToken(); // fail fast if the stored credential is unusable

  createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let token;
      try {
        token = await currentToken();
      } catch (err) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err.message ?? err) } }));
        return;
      }

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (!STRIPPED.has(k.toLowerCase()) && typeof v === "string") headers.set(k, v);
      }
      headers.set("authorization", `Bearer ${token}`);

      const body = Buffer.concat(chunks);
      let upstream;
      try {
        upstream = await fetch(`${CONFIG.gateway}${req.url}`, {
          method: req.method,
          headers,
          ...(body.length > 0 ? { body } : {}),
          // The caller going away should stop the generation, not orphan it.
          signal: AbortSignal.timeout(60 * 60 * 1000),
        });
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `Could not reach ${CONFIG.gateway}: ${String(err.message ?? err)}` },
          })
        );
        return;
      }

      const out = new Headers(upstream.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      res.writeHead(upstream.status, Object.fromEntries(out));

      // Streamed, not buffered: these responses are SSE and can run for many
      // minutes. Awaiting the whole body would defeat streaming entirely.
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
    });
  }).listen(CONFIG.port, "127.0.0.1", () => {
    console.log(`controlDeck token broker on http://127.0.0.1:${CONFIG.port}`);
    console.log(`  forwarding to ${CONFIG.gateway}`);
    console.log(`  point your tool's baseURL at http://127.0.0.1:${CONFIG.port}/v1`);
  });
}

const command = process.argv[2];
if (command === "login") await login();
else if (command === "serve") await serve();
else {
  console.log("usage: controldeck-token-broker <login|serve>");
  process.exit(2);
}
