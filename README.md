# controlDeck

A self-hosted, OpenAI-API-compatible LLM gateway for teams running their own models behind corporate identity, in environments with no internet egress.

Entra ID authentication, per-request cost tracking, a full audit trail, capability-aware routing, and dynamic autoscaling — none of it behind a paid tier, and nothing that phones home at runtime.

**License: MIT.**

---

## Why this exists

Every comparable platform gates SSO, JWT auth, or audit logging behind a commercial tier, or assumes network conditions — live license checks, telemetry, public OIDC discovery — that simply don't hold inside a locked-down enterprise network. controlDeck assumes the opposite: after the container images are delivered, it runs entirely offline.

The full product specification lives in [`prd/llm-platform-prd.md`](prd/llm-platform-prd.md). Section references throughout this README and the source (e.g. "§6.4") point back to it.

---

## What it does

| Capability | Summary |
|---|---|
| **OpenAI-compatible API** | `/v1/chat/completions` (streaming + non-streaming, text, vision, tools), `/v1/embeddings`, `/v1/models` |
| **Entra ID auth** | Every request's bearer token is validated against your tenant's JWKS. The platform issues no credentials of its own |
| **Capability routing** | Requests are hard-filtered to models that can actually serve them, then routed by rule-based complexity signals |
| **Load balancing** | Least-loaded placement across ready replicas, coordinated through Postgres so multiple router instances never double-route |
| **Autoscaling** | Preemptive KEDA scale-up: the moment a replica takes its first request, a warm spare is requested |
| **Cost tracking** | Per-model, per-caller, per-period — computed under whichever basis you define (per-token, per-request, or per-compute-second) |
| **Audit trail** | Metadata on every request; full prompt/response content when enabled, toggleable globally or per team, model, or key |
| **Dashboard** | Seven SSO-gated operational views: overview, models, requests, cost, audit, monitoring, settings |

### Deliberately not included

No platform-side RBAC or user table. No budget enforcement or rate limiting. No built-in chat UI. No log aggregation backend. No alerting — controlDeck exports metrics and Grafana owns alerting. See §3 of the PRD for the full list and the reasoning.

---

## Two modes

This is the most important thing to understand before running anything.

### Production (the default)

A fresh install is **completely empty**. No models, no replicas, no requests, no fabricated sample data. Every dashboard view shows a purposeful empty state explaining what's missing and how to populate it. Models arrive only when you register them through Helm; data arrives only from real traffic.

In this mode the router **refuses to start** without `ENTRA_JWKS_URI`, the dev-token endpoint is not registered at all, and both the seed and the traffic simulator refuse to run.

### Sim mode (`SIM_MODE=true`)

For local development, demos, and CI. Mints its own signing key so you can exercise the whole system without an Entra tenant, permits the demo seed, and enables the traffic simulator. The dashboard shows a **Sim mode** badge in the top bar so simulated data can never be mistaken for real data.

Never set `SIM_MODE` in an environment serving real traffic.

---

## Quick start (sim mode)

Requires Docker and Node 20+.

```bash
# 1. Postgres + a fleet of eight mock model replicas
docker compose up -d --build

# 2. Router
cd server
npm install
cp .env.example .env          # already configured for sim mode
npm run seed                  # registers the four demo models
npm run dev                   # http://localhost:4000

# 3. Dashboard (in a second terminal, from the repo root)
npm install
SIM_MODE=true npm run dev     # http://localhost:3000
```

The dashboard is live but quiet — no traffic has flowed yet. Generate some:

```bash
cd server
npm run sim:backfill -- --days=7   # seven days of history, for Cost and Audit
npm run sim:live -- --rate=4       # continuous traffic; ctrl-c to stop
```

Now Overview, Requests, Cost, and Audit all have real data in them, produced by real HTTP requests through the real router.

---

## How the pieces fit

```
  Clients (Open WebUI, scripts, tools)
        │  bearer token from their own Entra flow
        ▼
  ┌──────────────────────────────────────────┐
  │  Router / API tier   (N replicas, HA)    │
  │  JWT validation → capability filter →    │
  │  complexity routing → placement → stream │
  └───────────────┬──────────────────────────┘
                  │                    ▲
    ┌─────────────┼─────────────┐      │ /metrics/keda/:model
    ▼             ▼             ▼      │
 ┌────────┐  ┌────────┐  ┌──────────┐  │   ┌──────┐
 │ 35B    │  │ 9B     │  │ vision / │  └───│ KEDA │
 │replicas│  │replicas│  │ embedding│      └──────┘
 └────────┘  └────────┘  └──────────┘
   llama-swap, one readiness endpoint per replica
                  │
                  ▼
        ┌──────────────────────┐      ┌──────────────┐
        │  Postgres            │      │   Grafana    │
        │  audit · cost ·      │◀─────│  (scrapes    │
        │  shared router state │      │   /metrics)  │
        └──────────┬───────────┘      └──────────────┘
                   ▼
        ┌──────────────────────┐
        │  Dashboard (SSO)     │
        └──────────────────────┘
```

All shared state lives in Postgres, which is what lets the router run multiple replicas without two of them believing the same backend replica is free (§8).

---

## Repository layout

| Path | What it is |
|---|---|
| `server/` | Router / API tier. Fastify + Postgres, no ORM |
| `server/src/routing/` | Capability filter and complexity heuristics (§6.3) |
| `server/src/scheduler/` | Placement, queueing, and the two timeout clocks (§6.4–6.5) |
| `server/src/replicas/` | Backend discovery and readiness reconciliation (§6.4) |
| `server/src/audit/` | Audit entries, content-logging scopes, retention (§6.8) |
| `server/src/cost/` | Cost computation and breakdowns (§6.7) |
| `server/src/sim/` | Traffic simulator — sim mode only |
| `src/` | Dashboard. Next.js App Router, server components |
| `mock-model/` | Dependency-free stand-in for a llama-swap replica |
| `mock-oidc/` | Entra-shaped OIDC provider, for testing sign-in without a tenant |
| `docs/entra-setup.md` | App registration, optional claims, acceptance checklist |
| `helm/controldeck/` | Deployment chart |
| `prd/` | Product requirements |

---

## Configuration

### Router (`server/.env`)

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **Required.** Postgres connection string |
| `PORT` | `4000` | |
| `SIM_MODE` | unset | `true` enables dev tokens, seeding, and the simulator |
| `ENTRA_JWKS_URI` | — | **Required in production.** Your tenant's JWKS endpoint |
| `ENTRA_AUDIENCE` | `api://llm-gateway` | Accepted `aud` values, comma-separated |
| `ENTRA_ISSUER` | — | Expected `iss` claim |
| `ENTRA_TENANT_ID` | — | Optional; pins the token's `tid` claim |
| `TEAM_CLAIM` | `department` | Directory claim carrying the caller's team |
| `ENTRA_JWKS_TIMEOUT_MS` | `5000` | JWKS fetch timeout |
| `ENTRA_JWKS_CACHE_MS` | `600000` | How long a fetched key set is reused |
| `MODEL_BACKEND` | auto | `http` for real backends, `fake` for an in-process stub |
| `MODEL_ENDPOINT_<MODEL_ID>` | — | Base address for a model, e.g. `MODEL_ENDPOINT_ORNITH_35B` |
| `MODEL_REPLICAS_<MODEL_ID>` | — | Comma-separated per-replica addresses; takes precedence |
| `QUEUE_TIMEOUT_MS` | `300000` | Queue-wait clock (§6.5) |
| `STALL_TIMEOUT_MS` | `60000` | Inactivity clock — time since the last token |
| `REPLICA_RECONCILE_INTERVAL_MS` | `5000` | Readiness probe interval |
| `KEDA_ENABLED` | `true` | `false` disables scale-up signalling |

Model ids become env var names by upper-casing and replacing `-` with `_`.

### Dashboard

| Variable | Default | Notes |
|---|---|---|
| `API_BASE_URL` | `http://localhost:4000` | Where the router lives |
| `SIM_MODE` | unset | `true` bypasses SSO with a labelled local session |
| `DASHBOARD_SESSION_SECRET` | — | **Required in production.** ≥32 chars; signs the session cookie |
| `DASHBOARD_ENTRA_TENANT_ID` | — | Required for SSO |
| `DASHBOARD_ENTRA_CLIENT_ID` | — | Required for SSO |
| `DASHBOARD_ENTRA_CLIENT_SECRET` | — | Required for SSO |
| `DASHBOARD_ADMIN_GROUP_ID` | — | If set, membership is required. If unset, any tenant member with network access may sign in |
| `DASHBOARD_APP_URL` | `http://localhost:3000` | Public URL; used to build the OIDC redirect URI |
| `GRAFANA_URL` | — | When set, Monitoring shows a link out to it |

Register the redirect URI `${DASHBOARD_APP_URL}/api/auth/callback` in your Entra app registration, and configure it to emit **group claims** if you're using `DASHBOARD_ADMIN_GROUP_ID`.

### Identity, teams, and testing without a tenant

Full setup — app registrations, the optional claims that decide whether your
audit trail shows names or GUIDs, and a one-page acceptance checklist — is in
**[docs/entra-setup.md](docs/entra-setup.md)**.

Two things worth knowing up front:

- **Caller names and teams come from optional claims.** Entra access tokens omit
  `name` and `department` unless the app registration adds them. The router
  serves those callers regardless (falling back to `preferred_username`, then
  `oid`), but cost-by-team stays empty until `department` is configured.
- **You can test the whole flow without a tenant.** `docker compose up -d mock-oidc`
  starts an Entra-shaped provider with a control endpoint for reproducing
  awkward cases — missing claims, group-claim overage, token-exchange failure.

---

## Deploying

```bash
helm dependency build ./helm/controldeck
helm upgrade --install controldeck ./helm/controldeck \
  --set router.env.ENTRA_JWKS_URI="https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys" \
  --set router.env.ENTRA_ISSUER="https://login.microsoftonline.com/<tenant>/v2.0" \
  --set dashboard.env.DASHBOARD_ENTRA_TENANT_ID="<tenant>" \
  --set dashboard.env.DASHBOARD_ENTRA_CLIENT_ID="<client-id>"
```

Models are registered as config-as-code under `models:` in `values.yaml` (§6.2). Each entry produces a Deployment, a Service, and a KEDA `ScaledObject`.

### Trying it on a cluster without GPUs

`mockModels.enabled=true` swaps the llama-swap image for the mock model across the whole fleet. Useful for validating a chart change, or for a minikube walkthrough:

```bash
eval $(minikube docker-env)
docker build -t controldeck/mock-model:0.1.0 ./mock-model
helm upgrade --install controldeck ./helm/controldeck --set mockModels.enabled=true
```

### Dashboard edits vs. GitOps

Dashboard changes are written to `model_registry_overrides` and merged on top of the Helm base config at read time. A Helm redeploy never clobbers them, and the Models view marks which fields are overridden. Helm wins on genuine field conflicts (§6.2, §11).

---

## The mock model

`mock-model/` is a small dependency-free Node service that speaks enough of the OpenAI surface for the router to treat it as a real backend: SSE chat completions paced at a configurable tokens/sec, embeddings, and a readiness endpoint that stays down through a configurable warm-up.

It exists so the whole system can be exercised end to end without GPUs — and, importantly, so the *production* code path gets exercised. The router talks to it over real HTTP with real streaming, so routing, readiness gating, per-replica load balancing, and stall detection are all genuinely tested rather than stubbed.

Every failure mode in §6.6 is reachable on demand:

```bash
# Force a stall: stop emitting mid-stream while holding the connection open
curl -X POST localhost:5001/_control -d '{"stallProbability":1}'

# Force a cold replica: 30s warm-up, /health returns 503 throughout
curl -X POST localhost:5001/_control -d '{"loadDelayMs":30000}'

# Inspect what a replica has served
curl localhost:5001/_stats
```

Configure via `MODEL_ID`, `CAPABILITIES`, `TOKENS_PER_SEC`, `LOAD_DELAY_MS`, `MAX_CONCURRENCY`, `REPLY_MIN_TOKENS`, `REPLY_MAX_TOKENS`, `EMBEDDING_DIM`.

---

## The traffic simulator

Sim mode only. Twelve synthetic callers across seven teams, each with a behaviour profile — short questions, long analytical prompts, images, embeddings, tool calls, explicit model overrides.

```bash
npm run sim:backfill -- --days=30 --reset   # historical data, written to Postgres
npm run sim:live -- --rate=8 --verbose      # live traffic, through the real router
```

Backfill is the only component that writes request rows directly, and it does so using the router's own cost function and content-logging scope check, so backfilled history is indistinguishable from history the router would have written.

Live mode carries an *expectation* with every request — which model should serve it, or which error code it should produce — and reports mismatches at the end. A routing regression therefore shows up as a failed expectation rather than as traffic that merely looks plausible.

---

## Development

```bash
cd server
npm test           # unit + integration, against a dedicated test database
npm run typecheck
```

The suite provisions and migrates `controldeck_test` automatically, so `npm test` can never pollute the data your dashboard is reading. Override with `TEST_DATABASE_URL`.

```bash
# from the repo root
npx tsc --noEmit   # dashboard typecheck
npm run build      # production build
```

### End-to-end tests

```bash
docker compose up -d     # postgres, mock-oidc, mock model replicas
npm run e2e              # or: npm run e2e:ui
```

These run the dashboard in **production auth mode** — real SSO, real signed
tokens — against the bundled mock Entra provider, on their own ports (router
`:4100`, dashboard `:3100`) so they never disturb a running dev stack. Sim mode
is deliberately not used: it bypasses sign-in, which is most of what these
tests exist to check.

Covered: the full authorization-code + PKCE flow, admin-group enforcement,
sign-out, token-exchange failure, tampered callback state, sign-in when Entra
omits `name`/`department`, group-claim overage, content-logging toggle
persistence, switch geometry, theme persistence, horizontal overflow, and that
no view leaks a raw ISO timestamp.

### Notes on the codebase

- **Postgres is the only shared state.** Anything that must be consistent across router replicas lives there, not in process memory.
- **Ownership of replica rows is split.** The reconciler owns which replicas exist and their reachability; the scheduler owns `in_flight`. Saturation is `in_flight >= max_concurrency`, evaluated at placement time.
- **Two independent timeout clocks.** Queue-wait and stall are separate on purpose: a request that is making progress must always be allowed to finish, however slowly (§6.5).
- **No OIDC discovery calls.** Entra endpoints are derived from the tenant id, because an unconfigured outbound call would violate §8.
- `next/font` downloads Geist at **build** time. Builds therefore need network access; the running container does not.

---

## Open questions

Carried from the PRD, not yet settled:

- The stall timeout default of 60s needs validating against real generation patterns, particularly at the observed ~15 tok/s floor.
- The standardized error `code` set beyond the five defined in §6.6.
- Token audience alignment between Open WebUI's app registration and this platform's expected audience — needs testing against a real tenant.
- Whether `model_registry_overrides` needs conflict-resolution UI, or whether "Helm wins on conflict" is sufficient.
