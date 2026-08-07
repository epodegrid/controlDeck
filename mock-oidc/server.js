// A dependency-free OIDC provider shaped like Microsoft Entra.
//
// It exists so the dashboard's sign-in path — authorization code + PKCE, token
// exchange, id_token validation, group-claim enforcement — can be tested end to
// end without a tenant, in CI, forever. A real tenant proves Entra's quirks
// once; this proves we haven't regressed since.
//
// Route shapes mirror Entra's deliberately, so the configuration used against
// this provider looks like the configuration used against the real one.
//
//   GET  /{tenant}/v2.0/.well-known/openid-configuration
//   GET  /{tenant}/discovery/v2.0/keys
//   GET  /{tenant}/oauth2/v2.0/authorize
//   POST /{tenant}/oauth2/v2.0/token
//   POST /_control         shape the next login's claims
//   GET  /_control         inspect current state
//
// Zero dependencies, same as mock-model: the image stays tiny and builds with
// no registry access.

import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";

const PORT = Number(process.env.PORT ?? 9000);
const TENANT = process.env.TENANT_ID ?? "11111111-2222-3333-4444-555555555555";
const ISSUER_BASE = process.env.ISSUER_BASE ?? `http://localhost:${PORT}`;
const KID = "mock-key-1";

const issuer = () => `${ISSUER_BASE}/${TENANT}/v2.0`;

// One keypair per process. Restarting the container rotates the key, which is
// itself a useful thing to be able to do in a test.
// generateKeyPairSync returns KeyObjects when no encoding is given, so they are
// usable directly — re-wrapping a public KeyObject in createPublicKey throws.
const { publicKey, privateKey: signingKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function signJwt(payload) {
  const header = { alg: "RS256", typ: "JWT", kid: KID };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(input), signingKey);
  return `${input}.${b64url(sig)}`;
}

/**
 * The directory this provider pretends to hold. `department` is the claim the
 * gateway reads for team attribution, so the cast spans several.
 */
const USERS = [
  { oid: "aaaa1111-0000-0000-0000-000000000001", name: "Dana Okonkwo", upn: "dana@example.com", department: "platform", groups: ["group-admins"], roles: ["Admin"] },
  { oid: "aaaa1111-0000-0000-0000-000000000002", name: "Priya Raman", upn: "priya@example.com", department: "engineering", groups: ["group-admins"], roles: ["Admin"] },
  { oid: "aaaa1111-0000-0000-0000-000000000003", name: "Wei Zhang", upn: "wei@example.com", department: "search", groups: [], roles: [] },
];

// Mutable so a test can reproduce a specific tenant's behaviour.
const state = {
  /** Omit `name` from issued tokens — the default for Entra access tokens. */
  omitName: false,
  /** Omit `department`, e.g. a tenant that hasn't configured the optional claim. */
  omitDepartment: false,
  /** Replace `groups` with the Graph pointer Entra sends past ~200 groups. */
  groupOverage: false,
  /** Omit `roles`, e.g. an app registration with no app roles defined. */
  omitRoles: false,
  /** Seconds until issued tokens expire. */
  lifetimeSec: 3600,
  /** Force the token endpoint to fail, to exercise the error path. */
  failTokenExchange: false,
};

const codes = new Map(); // code -> { user, codeChallenge, nonce, clientId, redirectUri }

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function html(res, code, body) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function claimsFor(user, { clientId, nonce }) {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    iss: issuer(),
    aud: clientId,
    sub: `sub-${user.oid}`,
    oid: user.oid,
    tid: TENANT,
    iat: now,
    nbf: now,
    exp: now + state.lifetimeSec,
    preferred_username: user.upn,
    ...(nonce ? { nonce } : {}),
  };
  if (!state.omitName) base.name = user.name;
  if (!state.omitDepartment) base.department = user.department;
  // App roles are scoped to one application, so unlike `groups` they are never
  // replaced by a Graph pointer however many groups the user belongs to.
  if (!state.omitRoles) base.roles = user.roles;

  if (state.groupOverage) {
    // What Entra actually sends when a user is in too many groups: no groups,
    // just a pointer at Graph.
    base._claim_names = { groups: "src1" };
    base._claim_sources = {
      src1: { endpoint: `https://graph.microsoft.com/v1.0/users/${user.oid}/getMemberObjects` },
    };
  } else {
    base.groups = user.groups;
  }
  return base;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "GET" && path === `/${TENANT}/v2.0/.well-known/openid-configuration`) {
    return json(res, 200, {
      issuer: issuer(),
      authorization_endpoint: `${ISSUER_BASE}/${TENANT}/oauth2/v2.0/authorize`,
      token_endpoint: `${ISSUER_BASE}/${TENANT}/oauth2/v2.0/token`,
      jwks_uri: `${ISSUER_BASE}/${TENANT}/discovery/v2.0/keys`,
      response_types_supported: ["code"],
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
  }

  if (req.method === "GET" && path === `/${TENANT}/discovery/v2.0/keys`) {
    return json(res, 200, { keys: [publicJwk] });
  }

  // Authorize: renders a picker so a human can click through, and accepts
  // ?user=<oid|upn> so a scripted test can skip straight past it.
  if (req.method === "GET" && path === `/${TENANT}/oauth2/v2.0/authorize`) {
    const redirectUri = url.searchParams.get("redirect_uri");
    const stateParam = url.searchParams.get("state") ?? "";
    const clientId = url.searchParams.get("client_id") ?? "";
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    const nonce = url.searchParams.get("nonce") ?? "";
    if (!redirectUri) return json(res, 400, { error: "invalid_request", error_description: "redirect_uri required" });

    const requested = url.searchParams.get("user");
    const user = requested
      ? USERS.find((u) => u.oid === requested || u.upn === requested)
      : null;

    if (!user) {
      const rows = USERS.map((u) => {
        const href = `${path}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), user: u.upn })}`;
        return `<li><a href="${href}">${u.name} <small>${u.upn} · ${u.department}</small></a></li>`;
      }).join("");
      return html(
        res,
        200,
        `<!doctype html><meta charset="utf-8"><title>Mock Entra sign-in</title>
         <style>body{font:15px system-ui;margin:60px auto;max-width:32rem}
         li{margin:.6rem 0;list-style:none}a{text-decoration:none;color:#111;display:block;
         padding:.7rem 1rem;border:1px solid #ddd;border-radius:10px}
         a:hover{background:#f5f5f5}small{color:#888;display:block;font-size:12px}</style>
         <h1>Mock Entra</h1><p>Choose an account to sign in as.</p><ul>${rows}</ul>`
      );
    }

    const code = randomUUID();
    codes.set(code, { user, codeChallenge, nonce, clientId, redirectUri });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    if (stateParam) back.searchParams.set("state", stateParam);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  if (req.method === "POST" && path === `/${TENANT}/oauth2/v2.0/token`) {
    if (state.failTokenExchange) {
      return json(res, 400, { error: "invalid_grant", error_description: "Injected token-exchange failure." });
    }
    const params = new URLSearchParams(await readBody(req));
    const code = params.get("code");
    const verifier = params.get("code_verifier");
    const entry = code ? codes.get(code) : null;
    if (!entry) return json(res, 400, { error: "invalid_grant", error_description: "Unknown or reused code." });
    codes.delete(code); // authorization codes are single-use

    // PKCE: the verifier must hash to the challenge presented at authorize.
    if (entry.codeChallenge) {
      const computed = createHash("sha256").update(verifier ?? "").digest("base64url");
      if (computed !== entry.codeChallenge) {
        return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed." });
      }
    }

    const clientId = params.get("client_id") || entry.clientId;
    const claims = claimsFor(entry.user, { clientId, nonce: entry.nonce });
    return json(res, 200, {
      token_type: "Bearer",
      expires_in: state.lifetimeSec,
      scope: "openid profile email",
      id_token: signJwt(claims),
      // Audience differs for the API token: it is minted for the gateway, not
      // for the dashboard client — the distinction the Open WebUI question turns on.
      access_token: signJwt({ ...claims, aud: process.env.API_AUDIENCE ?? "api://llm-gateway" }),
    });
  }

  if (path === "/_control") {
    if (req.method === "GET") return json(res, 200, { tenant: TENANT, issuer: issuer(), state, users: USERS });
    if (req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      for (const k of ["omitName", "omitDepartment", "omitRoles", "groupOverage", "failTokenExchange"]) {
        if (typeof body[k] === "boolean") state[k] = body[k];
      }
      if (typeof body.lifetimeSec === "number") state.lifetimeSec = body.lifetimeSec;
      return json(res, 200, { ok: true, state });
    }
  }

  if (req.method === "GET" && path === "/healthz") return json(res, 200, { status: "ok" });

  json(res, 404, { error: "not_found", error_description: `No route for ${req.method} ${path}` });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mock-oidc] listening on :${PORT}`);
  console.log(`[mock-oidc] issuer   ${issuer()}`);
  console.log(`[mock-oidc] jwks     ${ISSUER_BASE}/${TENANT}/discovery/v2.0/keys`);
});
