# Connecting clients, and never seeing "token expired" again

controlDeck issues no credentials of its own. Every caller presents a Microsoft
Entra ID access token, and those live **60–90 minutes** (a random value
averaging 75, to spread renewal load across the tenant).

That is the whole of the problem. This document is how each kind of client
holds a *renewable* credential so the hour never runs out mid-task.

Architecture and sequence diagrams: [architecture.md](architecture.md).

---

## First, the thing that is not broken

**An expiring token never interrupts a request that is already running.**

Authentication is a Fastify `preHandler` — it runs once, when the request
arrives ([`server/src/auth/verify.ts`](../server/src/auth/verify.ts)). A
40-minute generation that began with a valid token streams to completion even
if the token expired at minute twelve. Expiry only decides whether the *next*
request is admitted.

So "token expired after an hour of coding" is never a half-finished answer. It
is the next request being refused, and the fix is a client that renews.

---

## Why the obvious fixes do not work

### Pasting an access token

It works for 60–90 minutes and then stops, in the middle of whatever you were
doing. This is almost certainly what you are hitting.

### Raising the token lifetime

You *can*: `AccessTokenLifetime` in a Custom Token Lifetime Policy accepts
`00:10:00` to `23:59:59`. It is the wrong lever. A 24-hour access token cannot
be withdrawn — revoking a session does not reach a token already issued — so
you have traded a daily interruption for a day-long window in which a leaked
token still works. It also only moves the problem: the token still expires
mid-session, just less often.

Two footnotes if you go there anyway: policies are Graph-API only (no portal
UI), and an **organisation-level policy overrides an application-level one**,
which is the usual reason an app-level policy appears to do nothing.

### Rotating a key file or environment variable under the client

This is the one worth testing rather than assuming, because opencode does
support `"apiKey": "{file:~/.secrets/key}"` and `"apiKey": "env:VAR"`, and a
background refresher writing that file looks like an elegant answer.

**It does not work.** Measured against opencode 1.18.15: the key is resolved
once at start-up and reused for the whole session. Rotating the file mid-run
changed nothing — a request nine seconds later, well after the file changed,
still carried the original value:

```
19:42:25.391  KEY-VERSION-ONE
19:42:25.673  KEY-VERSION-ONE
19:42:34.765  KEY-VERSION-ONE   <- file had already been rewritten
```

opencode has no OAuth or refresh support for custom OpenAI-compatible
providers; those exist only for its first-class providers. So the credential
the client holds must be a **placeholder**, and the real token has to be
attached downstream, per request.

That is exactly what the broker below does — and it works precisely because
opencode *does* honour an arbitrary `baseURL`.

---

## Class A — tools on your laptop (opencode, Copilot, curl)

A small local process holds the refresh token, mints a fresh access token
before each request, and proxies to the gateway. The tool is pointed at
`127.0.0.1` with any placeholder key and never learns OAuth happened.

### 1. Register a public client, once, in Entra

| Setting | Value |
|---|---|
| Application type | Public client (mobile & desktop) |
| Allow public client flows | **Yes** — device code will not work without it |
| Redirect URI | none needed for device code |
| API permission | your controlDeck API → delegated, e.g. `user_impersonation` |
| Grant admin consent | recommended, so each developer is not prompted |

Device code is the right flow: it is the only interactive one that survives an
SSH session or a machine with no browser.

### 2. Run the broker

```bash
export CONTROLDECK_TENANT_ID=<tenant guid>
export CONTROLDECK_CLIENT_ID=<the public client's app id>
export CONTROLDECK_GATEWAY=https://controldeck.internal.example
export CONTROLDECK_SCOPE="api://llm-gateway/.default offline_access"

node tools/token-broker/controldeck-token-broker.mjs login   # once
node tools/token-broker/controldeck-token-broker.mjs serve   # leave running
```

`offline_access` is what makes Entra return a refresh token. Without it every
access token is a dead end and the broker cannot do its job — it says so
rather than failing an hour later.

The refresh token is written to `~/.controldeck/token.json` with mode `0600`.
It is a 90-day credential for your account; treat it as one.

### 3. Point the tool at it

opencode (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "controldeck": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "controlDeck",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "unused-the-broker-attaches-the-real-one"
      },
      "models": { "eve": { "name": "Ornith 35B" }, "wall-e": { "name": "Gemma 4 12B" } }
    }
  },
  "model": "controldeck/eve"
}
```

Anything else that speaks OpenAI works the same way — set the base URL to
`http://127.0.0.1:8787/v1` and put any string in the key field.

### How long it lasts

Refresh tokens last **90 days** and rotate on every use, so a broker used at
least once every 90 days keeps working indefinitely without another sign-in.
It refreshes when the access token is within five minutes of expiry, rather
than reacting to a 401 — reacting means one request has already failed, which
is the thing being fixed. Concurrent requests share a single refresh, because
rotation means two simultaneous refreshes race to invalidate each other.

You will be asked to sign in again only if the refresh token is revoked:
password change, admin revocation, or 90 days of not using it.

---

## Class B — a multi-user platform (LibreChat)

LibreChat has its own users, and the audit trail should name them rather than
naming LibreChat. Use **On-Behalf-Of**: the user signs in to LibreChat with
Entra, and LibreChat exchanges that token for one addressed to controlDeck.

```
POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
  grant_type          = urn:ietf:params:oauth:grant-type:jwt-bearer
  client_id           = <librechat app id>
  client_secret       = <secret, or a federated assertion>
  assertion           = <the user's access token for LibreChat>
  scope               = api://llm-gateway/.default
  requested_token_use = on_behalf_of
```

The result carries the user's `oid`, `name` and `department`, so per-team cost
(§6.7) and per-team content-logging scopes (§6.8) attribute correctly.

Register LibreChat as a **confidential** client with a delegated permission on
the controlDeck API, and grant admin consent. Cache per user and refresh on the
same five-minute rule; a confidential client's refresh tokens also last 90 days
and rotate.

**If you use client credentials instead**, every request in the system is
attributed to LibreChat's service principal. Cost by team becomes one bar, and
audit answers "LibreChat did it" for every prompt. That is a real loss of the
thing this platform exists to provide, so take it deliberately or not at all.

---

## Class C — headless workloads (Coder agents)

Coder workspaces run in the cluster, so they should hold **no secret at all**.
Use workload identity federation: the pod's projected Kubernetes service-account
token is exchanged for an Entra token, with trust established once between the
cluster's OIDC issuer and the app registration.

```bash
az ad app federated-credential create --id <app id> --parameters '{
  "name": "coder-agents",
  "issuer": "<AKS OIDC issuer URL>",
  "subject": "system:serviceaccount:coder:coder-agent",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

Annotate the ServiceAccount, and MSAL in the workspace picks up
`AZURE_FEDERATED_TOKEN_FILE` automatically. There is no refresh token in this
flow and none is needed — the library acquires a new access token when the old
one ages out, and no credential exists to leak or expire.

**Identity caveat, same as Class B.** An app-only token attributes every
request to the service principal. Where a human drives the agent and you want
their name in the audit trail, carry the user's token into the workspace and
use the Class B exchange instead.

---

## Reference: what expires, and what you can change

| Thing | Default | Configurable? |
|---|---|---|
| Access token | 60–90 min (random, ~75 avg) | Yes — `AccessTokenLifetime`, 10 min to 23:59:59 |
| Access token with CAE | up to 24–28 h | Only if both client and resource are CAE-aware. controlDeck is not |
| Refresh token | 90 days (24 h for single-page apps) | **No** — not since January 2021 |
| Refresh token rotation | every use | No |
| Sign-in frequency | tenant policy | Conditional Access, not token lifetime policy |

Continuous Access Evaluation is the one mechanism that gives genuinely
long-lived tokens *without* the revocation trade-off — tokens live 24–28 hours
but are revoked in near real time on critical events. It requires the resource
to understand claims challenges, which controlDeck does not implement today. If
that becomes interesting, it is a change to the gateway, not to your clients.

---

## Troubleshooting

**"Token has expired."** The client is holding a static token. Nothing renews
it. Move to a broker (Class A) or OBO (Class B).

**"Token is missing the required `oid` claim."** Usually an ID token being sent
instead of an access token — check that the scope is the API's
(`api://.../.default`), not `openid profile`.

**"Token claim validation failed: aud."** The token was issued for a different
resource. Graph tokens are the common mistake; so is the bare client id when
the gateway expects `api://llm-gateway`. `ENTRA_AUDIENCE` accepts a
comma-separated list, which is how you migrate between the two without
downtime.

**Everything is attributed to one caller in Cost and Audit.** A client-credentials
token, or a missing team claim. Add `department` (or whatever your tenant uses)
as an optional claim on the app registration and set `TEAM_CLAIM` to match.

**Sign-in works, but the broker says no refresh token.** `offline_access` is
missing from the scope.

**Is it the gateway or my client?** Send the request with `?dry_run=1` — the
gateway returns the exact body it would forward upstream without calling the
model. See the README.
