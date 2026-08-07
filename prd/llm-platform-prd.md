# PRD: Self-Hosted LLM Gateway Platform

**Status:** Draft for build
**License:** MIT
**Audience for this document:** an engineering agent/team building the platform from scratch. Every requirement below reflects a decision already made — where a decision was deferred, it's called out explicitly under Open Questions.

---

## 1. Problem Statement

Teams running self-hosted LLMs behind corporate identity providers (Entra ID) in locked-down environments (no internet egress, Private Link Endpoint-only networking, no privileged containers) currently have no clean open-source option. Every comparable platform (LiteLLM, Portkey, Langfuse-adjacent tooling) gates SSO, JWT auth, or audit logging behind a paid tier, or assumes network conditions (live license checks, telemetry, public OIDC discovery) that don't hold in an air-gapped enterprise environment.

This platform is a self-hosted, OpenAI-API-compatible LLM gateway that provides Entra ID authentication (SSO for humans, JWT/JWKS for API callers), cost tracking, audit logging, dynamic autoscaling, and a dashboard — as free, open-source software, deployable entirely offline after initial image delivery.

## 2. Goals

- One OpenAI-compatible endpoint in front of multiple self-hosted models (chat, vision, tool-calling, embeddings), each independently autoscaled.
- Entra ID as the sole identity provider — no platform-issued credentials, no platform-side RBAC.
- Full visibility into cost, usage, and request-level audit trail, without gating any of it behind a license.
- Runs with zero external network dependency at runtime (no phone-home, no license servers, no unconfigured live discovery calls).
- Deployable by any team with a Kubernetes cluster, Entra tenant, and a way to get container images in (registry pull-through, GHCR, or direct pull) — not tied to Azure-specific services beyond what's already assumed (AKS, Entra).

## 3. Non-Goals (v1)

Explicitly out of scope. Do not build these unless a future revision changes this document.

- **No platform-side RBAC or roles.** Admin/dashboard access is gated entirely by Entra SSO group membership; API access is gated entirely by Entra JWT validity. The platform has no internal user/role table.
- **No budget or quota enforcement.** Cost and usage are tracked and displayed, never used to block a request. No rate limiting per caller.
- **No auto-escalation on routing misclassification.** If the auto-router sends a request to the wrong model, recovery is manual (caller re-sends with an explicit model override).
- **No built-in chat UI.** This is an API + admin platform. Chat UIs (e.g. Open WebUI) are clients that call the OpenAI-compatible endpoint.
- **No log aggregation/search backend.** Pod logs are live-tailed only; nothing is indexed or searchable after a pod is gone.
- **No built-in alerting.** The platform exports metrics; Grafana (already running in this environment) owns alerting.
- **No platform-issued tokens or credentials.** Entra is the only identity/token source, for both humans and API callers.
- **No confirmation gating on destructive dashboard actions** (e.g. deleting audit history) beyond normal Entra-gated access — this is treated as a personnel-trust boundary, not a platform control.
- **No vision-only or embeddings-only deployments assumed** — the model set is heterogeneous by design (see §6.2).

## 4. Personas

| Persona | Needs |
|---|---|
| **API caller** (a script, an internal tool, Open WebUI on a user's behalf) | Send OpenAI-compatible requests with a valid Entra bearer token; get a response or a clear standardized error. |
| **Platform admin** (member of the designated Entra admin group) | Log into the dashboard via SSO; see cost, audit, replica health, queue state; configure per-model settings; register new models via GitOps. |
| **End user** (via a separate chat client like Open WebUI) | Never interacts with this platform directly — their own Entra token is forwarded by their client on every request, giving them full audit attribution without them needing to know this platform exists. |

## 5. High-Level Architecture

```
                         ┌─────────────────────┐
 Entra ID  ──validates──▶│   Router / API tier  │──(multiple replicas, HA)
 (JWKS)                  │  - JWT validation     │
                          │  - capability filter  │
                          │  - complexity routing │
                          │  - load balancing     │
                          │  - queue management   │
                          └──────────┬────────────┘
                                     │
                 ┌───────────────────┼───────────────────┐
                 ▼                   ▼                   ▼
          ┌─────────────┐    ┌─────────────┐     ┌─────────────┐
          │ 35B model    │    │ 9B model     │ ... │ Vision /     │
          │ replicas     │    │ replicas     │     │ Embedding    │
          │ (KEDA-scaled)│    │ (KEDA-scaled)│     │ replicas     │
          └─────────────┘    └─────────────┘     └─────────────┘
                 │ (ik_llama.cpp / llama-swap — readiness endpoint per replica)
                 ▼
        ┌──────────────────────┐
        │  Postgres (self-hosted│  ← audit, cost/usage history,
        │  in-cluster)          │    shared router state (in-flight/queue)
        └──────────────────────┘
                 │
                 ▼
        ┌──────────────────────┐        ┌──────────────┐
        │  Metrics API          │───────▶│   Grafana     │ (existing, alerting lives here)
        └──────────────────────┘        └──────────────┘
                 ▲
        ┌──────────────────────┐
        │  Platform Dashboard   │ (admin/ops UI, SSO-gated)
        └──────────────────────┘

Clients (Open WebUI, scripts, tools) → call the router directly with their own Entra bearer token.
```

## 6. Functional Requirements

### 6.1 Authentication & Authorization

- The router validates every incoming API request's bearer token against Entra's JWKS endpoint (signature, expiry, issuer, audience).
- **No platform-issued credentials.** The router never mints, stores, or rotates its own tokens or API keys.
- **Authorization is binary.** A valid Entra token grants access to every model, with no per-user/team quota or budget ceiling. There is no platform-side mapping table between Entra identity and permissions.
- **Dashboard/admin access** is separately gated by Entra SSO group membership (standard OIDC login flow for the dashboard app), independent of the API's JWT validation path.
- Clients are expected to acquire their own Entra token through whatever flow fits them (interactive login for humans/UIs, client credentials for service-to-service). The router is agnostic to how the token was obtained, only that it validates.
- **Reference client integration:** Open WebUI should be configured with `auth_type: oauth` on its connection to this platform (not a static API key), so it forwards the individual logged-in user's own Entra access token on every request. This preserves per-user audit attribution even when users interact via a chat UI rather than calling the API directly. Confirm token audience alignment between Open WebUI's own Entra app registration and what this platform's JWKS validator expects.

### 6.2 Model Registry & Capabilities

The platform serves multiple heterogeneous models simultaneously, each declaring its own capabilities:

| Model class | Example | Capabilities |
|---|---|---|
| Large/complex | 35B (Ornith-1.0, GGUF Q4_K_M) | `chat`, `tools` |
| Fast/general | 9B-class | `chat`, `tools` |
| Vision | small HF vision model (TBD) | `chat`, `vision` |
| Embedding | dedicated embedding model | `embeddings` |

- Every registered model exposes a capability set (`chat`, `vision`, `tools`, `embeddings`, and future additions) consumable by the router and displayed on the dashboard.
- Models are served via ik_llama.cpp through llama-swap, which exposes a readiness endpoint per model/replica.
- **Registration path:** primary is config-as-code — a model is defined in a Helm values file / Kubernetes CRD and deployed through the existing GitOps pipeline (Bicep for infra, Helm via Azure Pipelines for app/model deploys). A secondary path allows dashboard-based live edits for operational agility.
  - **Design requirement:** dashboard-made changes must not be silently clobbered by the next Helm deploy. Implement dashboard edits as an override layer stored in Postgres, merged on top of the Helm-deployed base config at read time — never mutate the same resource Helm manages directly.

### 6.3 Request Routing

Two selection mechanisms, in this precedence order:

1. **Explicit override.** Caller sets a model header/field naming the exact model. If that model lacks a capability the request needs (e.g. an image is attached but the named model has no `vision` capability), **hard-reject with a standardized error** — never silently strip or best-effort the request.
2. **Auto-routing** (when no explicit model is named):
   - **Step 1 — Capability filter (hard filter).** Inspect the request: does it contain an image (→ requires `vision`)? A `tools` array (→ requires `tools`)? Is it hitting `/v1/embeddings` (→ requires `embeddings`)? Filter the candidate model set down to only models with the required capabilities.
   - **Step 2 — Complexity-based selection** among the remaining candidates. Rule-based signals only (no classifier model, no self-assessment round-trip): prompt length, keyword/pattern matching, presence of complex-reasoning markers. Route to the smallest/fastest capable model unless signals indicate the large model is warranted.
3. **No auto-escalation.** If an auto-routed request produces a poor result because it was misclassified, the platform does not detect or retry this automatically. The caller must re-issue the request with an explicit model override.

### 6.4 Load Balancing & Scaling

- The router tracks in-flight and queued request counts **per replica**, in shared state (see §6.8 — this must work correctly across multiple router instances).
- **New request placement:** route to the least-loaded ready replica of the target model. If none are free, route to queue (see §6.5).
- **Preemptive scaling:** the moment *any* replica of a model receives its first request (even with zero backlog), trigger KEDA to spin up an additional replica in parallel — the platform always tries to keep one warm spare ahead of demand, rather than waiting for saturation.
  - This is intentionally aggressive. Rationale: on this environment's cost model (Azure bills per VM, not per pod; an idle replica only costs RAM, which is abundant; CPU is idle when not serving), the cost of over-provisioning a spare is negligible compared to the latency cost of under-provisioning.
- **Underlying node scaling** (AKS cluster autoscaler) is not managed directly by this platform — KEDA scales pod/replica count per model, and the cluster autoscaler handles provisioning the VM capacity underneath automatically.
- **Max replica count is user-configurable per model** (exposed on the dashboard, mechanically a KEDA `ScaledObject.maxReplicaCount` setting).
- **Readiness gating:** a newly spun replica must not receive traffic until its llama-swap readiness endpoint reports ready (model weights fully loaded). The router polls this before adding a replica to the eligible pool.

### 6.5 Queueing & Timeouts

Two independent clocks, not one:

1. **Queue-wait timeout — 5 minutes.** Starts when a request arrives with no free replica and no assignment yet. If still unassigned after 5 minutes, fail the request with a standardized `queue_timeout` error. Shown on the dashboard as **"unprocessed," highlighted yellow**, for the duration it's waiting.
2. **Stall/inactivity timeout — once a replica has been assigned and generation has started.** There is **no fixed wall-clock cap** on generation time. Instead, track time since the last token was emitted; if that exceeds a configurable inactivity threshold (default suggestion: 60 seconds), kill the request with a `stall_timeout` error. This allows slow-but-progressing generations (e.g. the 35B model running at its observed floor of ~15 tokens/sec under load) to run to completion, while still catching genuinely hung replicas quickly.

This split is a deliberate, confirmed design decision: **requests that are making progress must always be allowed to finish.**

### 6.6 Streaming & Error Handling

- `stream: true` (SSE) is a required capability of the OpenAI-compatible endpoint, not optional.
- A replica serving a stream is considered "busy" (occupying its slot in the in-flight tracking) for the full duration of the stream, not just until first token.
- **Standardized errors, modeled on the OpenAI error object shape** (`type`, `code`, `message`). Define and document a fixed set of `code` values at minimum: `queue_timeout`, `stall_timeout`, `replica_unavailable`, `capability_mismatch`, `auth_invalid`.
- **Mid-stream failures must send a proper SSE error event before closing the connection** — never just drop the connection and leave the client to infer what happened. This lets clients distinguish "retry immediately" from "this request fundamentally can't succeed."

### 6.7 Cost Tracking

- Cost reflects **actual infrastructure reality**, not vendor-style per-token billing, since there is no external invoice for a self-hosted model.
- Every request is logged with enough raw data to compute cost under any of three bases after the fact: input/output token counts, wall-clock duration occupying a replica, and a per-request record.
- **Admins set a discretionary cost value per model** (their own $/1K-token, $/request, or $/compute-second figure) — the platform doesn't prescribe what "cost" means, only captures the data needed to compute it however the admin defines it.
- Dashboard surfaces tokens/sec broken down **by caller and by time period**, in addition to cost breakdowns.
- **No enforcement.** This is purely observational — see Non-Goals.

### 6.8 Audit Trail

- **Metadata logged by default** on every request: caller identity (from JWT), timestamp, model used, token counts, latency, computed cost.
- **Full prompt + response content logging is opt-in**, toggleable at multiple granularities simultaneously supported: global, per-team, per-model, per-API-key.
- **No restricted "audit viewer" role.** Anyone with valid platform SSO access can view logged audit content — access control here is entirely delegated to Entra group membership, consistent with §6.1.
- **Retention:** indefinite by default. Dashboard exposes a manual "delete last X days" action. No automatic purge/archival job. Deletion of audit history is treated as a personnel-trust matter, not something the platform needs to gate with extra confirmation beyond normal SSO-gated access.

### 6.9 Dashboard & Monitoring

- The dashboard is an **admin/ops surface**, not a chat interface. It shows replica status, queue state, cost, audit, and tokens/sec — it does not replace Open WebUI or any other chat client.
- It runs **alongside Grafana**, not in place of it. Deep infra metrics (CPU/RAM/node health) stay in Grafana.
- The platform exposes a **metrics API** so Grafana/Prometheus can scrape the same underlying data the dashboard shows — single source of truth, two consumers, so the two views can never disagree.
- **Alerting is entirely Grafana's responsibility.** This platform does not send notifications on its own.

### 6.10 Logs

- Dashboard shows **live-tailed pod stdout** (via the Kubernetes API) per replica — startup errors, crash traces, model-load failures.
- **No log aggregation backend** (e.g. Loki) in v1. Logs are only visible while a pod is running; nothing is indexed or searchable historically. (Structured, queryable request-level history already exists via the audit trail — this isn't duplicated here.)

### 6.11 System Prompt Injection

- Each model has a **default system prompt, configured per model** by an admin.
- **Callers can override or append their own system prompt** in the request — the platform-injected prompt is a default, not silently authoritative over what the caller sends.

### 6.12 API Surface

- `/v1/chat/completions` — streaming and non-streaming, text and vision inputs, tool/function calling (pass-through of llama-swap's existing tool-calling handling).
- `/v1/embeddings` — served by a dedicated embedding model, distinct from the chat/vision models.
- `/v1/models` — lists registered models along with their capability flags, so clients and the dashboard can introspect what's available.
- No rate limiting on any endpoint in v1 (intentional non-goal, see §3).

## 7. Data Model (Postgres)

All persistent state — audit records, cost/usage history, and shared router state — lives in a single self-hosted-in-AKS Postgres instance. Indicative tables (not exhaustive, refine during implementation):

- `requests` — one row per request: id, caller identity (oid claim), model used, capability flags matched, input/output token counts, start/end timestamps, duration, status (completed/queue_timeout/stall_timeout/error), replica id.
- `audit_content` — optional full prompt/response body, foreign-keyed to `requests`, only populated when the relevant logging toggle is on for that request's scope.
- `model_cost_config` — per-model admin-set cost values (per-token, per-request, per-compute-second).
- `router_state` — live in-flight/queued counts per replica, used for cross-instance coordination between multiple router replicas (HA requirement, §8).
- `model_registry_overrides` — dashboard-made model config edits, merged on top of the Helm-deployed base config at read time (see §6.2).

## 8. Non-Functional Requirements

- **Router/API tier runs as multiple replicas for HA.** In-flight/queue state must therefore live in shared Postgres state, not per-instance memory — otherwise two router replicas could both believe the same target replica is free and double-route to it.
- **Zero external runtime network dependency.** No telemetry, no license-check phone-home, no OIDC discovery call to an endpoint that isn't explicitly configured by the operator. This is a hard requirement driven by the target deployment environment (no internet egress).
- **Packaging is delivery-format-flexible**, not tied to a specific registry: must be deployable via a Docker Hub/GHCR-sourced image pulled through a registry pull-through proxy (e.g. Nexus), or pulled directly from GHCR — whichever an operator's environment supports.
- **License: MIT.**

## 9. Deployment & Packaging

- Ships as a set of container images (router/API tier, dashboard, metrics API) plus a Helm chart for deployment onto any Kubernetes cluster.
- Model serving (ik_llama.cpp/llama-swap per model) is deployed and scaled independently via its own Helm-managed KEDA `ScaledObject`.
- Postgres is deployed self-hosted in-cluster via Helm, consistent with this project's existing infra pattern.
- No assumption of Azure-specific managed services beyond what the deploying org already has (this specific deployment uses AKS + Entra; the platform itself should not hard-code Azure-only APIs where a generic Kubernetes/OIDC equivalent exists).

## 10. UI / Dashboard Design Brief

*This section is input for the visual design pass (Claude Design), not a pixel spec. It defines the required views, their purpose, and the information hierarchy each needs — visual treatment is a separate exercise.*

### Design principles
- This is an **operations dashboard**, not a consumer product — prioritize information density and scanability over decoration.
- **Status color coding** should be consistent platform-wide: green = ready/healthy, yellow = queued/scaling/in-progress, red = failed/down.
- Assume admins will have this open on a second monitor during incidents — real-time state (replica status, queue depth) should be glanceable without clicking in.
- Dark-mode-friendly, consistent with typical ops tooling conventions (Grafana, Kubernetes dashboards) this will sit alongside.

### Required views

**1. Overview / Home**
System health at a glance on login: per-model replica status (count running/scaling/idle), current queue depth with count of requests in "unprocessed" (yellow) state, recent request volume (sparkline or simple time series), quick stats (requests/min, average latency, tokens/sec, active replica count across all models).

**2. Models**
List of all registered models. Per model: capability badges (`chat`/`vision`/`tools`/`embeddings`), current/min/max replica counts, per-replica status (ready/loading/busy/idle) with the readiness state visible, system prompt (editable), admin-set cost value (editable, per whichever basis — token/request/compute-time), source of config (GitOps-managed vs dashboard-overridden, with a clear indicator when the two might diverge on next deploy).

**3. Requests / Queue**
Live view of in-flight and queued requests. Queued requests shown highlighted yellow ("unprocessed") with elapsed wait time visible. Per-request: caller identity, target model, status (queued → routed → streaming → completed/failed), which replica handled it, and — if it failed — which error code.

**4. Cost**
Cost breakdown by model, by team/caller, and by time period, computed under whichever basis is configured per model. Include raw token/request/compute-time figures alongside the derived cost, not just the dollar figure, so the underlying numbers are auditable.

**5. Audit**
Searchable/filterable log: caller, timestamp, model, tokens, latency, cost, and full content when logging is enabled for that request's scope. Controls for the content-logging toggle at each granularity (global/team/model/key), with a clear visual indication of what's currently enabled where — this is sensitive enough that "what's being logged right now" should never require digging. Includes the "delete last X days" action.

**6. Monitoring / Logs**
Live pod log tail per replica (raw stdout). Basic replica health indicators. Clear outbound links to the corresponding Grafana dashboards for deeper infra metrics, rather than duplicating them here.

**7. Settings / Admin**
Model registration status (shows GitOps-managed base config plus any dashboard overrides, with the override-vs-source-of-truth relationship made explicit). Global defaults where applicable. KEDA max-replica configuration per model.

### Navigation shape
Left sidebar with the seven sections above. Top bar shows the logged-in admin's identity (from Entra) and a single overall system health indicator (green/yellow/red) that's visible from every screen.

## 11. Open Questions

Carried forward, not yet resolved — flag these during implementation rather than assuming an answer:

- Exact inactivity-timeout duration for the stall timeout (default suggested: 60s — needs validation against real generation patterns, especially at the observed 15 tps floor).
- Full enumeration of standardized error `code` values beyond the five listed in §6.6.
- Token audience alignment specifics between Open WebUI's Entra app registration and this platform's expected JWT audience — needs to be tested against the actual tenant, not assumed.
- Whether `model_registry_overrides` needs conflict-resolution UI (what happens when a Helm redeploy changes a field that was also dashboard-overridden) or whether "Helm always wins on conflict, override layer only fills gaps" is sufficient.
