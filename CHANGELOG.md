# Changelog

## Unreleased

### Fixed

- **Every client-side dashboard call went to `localhost:4000`.** Next inlines
  `NEXT_PUBLIC_*` into the client bundle at *build* time, so the value the Helm
  chart sets at run time never reached the browser and the published image
  shipped the build-time fallback baked in. The log tail, the content-logging
  toggles, the delete-history button and the model-override form were all
  pointed at a port nothing listens on in a cluster, while server-rendered
  pages — which use the run-time `API_BASE_URL` — worked perfectly, so the
  dashboard looked healthy.

  The browser now calls its own origin and the dashboard forwards
  (`/gateway/[...path]`), which needs no ingress rule and works unchanged under
  `kubectl port-forward` and in local development. Routing the browser straight
  at the router was the wrong fix: `/api/*` is deliberately unauthenticated —
  the dashboard's session guards it — so publishing it would hand anyone who
  could reach the host the ability to edit the registry and delete audit
  history.

  The e2e suite passed throughout because it set `NEXT_PUBLIC_API_BASE_URL`,
  reproducing a configuration no deployment can have. It no longer does.

- **The preemptive scale-up signal was per-process.** §6.4's warm spare was
  recorded in a `Map`, while KEDA polls the router *Service* — so with the two
  router replicas §8 asks for, the poll reached the pod holding the signal
  about half the time and the spare was requested by coin flip. It lives in
  Postgres now. Demand-based scaling was unaffected: `in_flight` and `queued`
  always came from shared state, so the flag only decided the case where demand
  is still zero, which is the one preemptive scaling exists for.

- **A write cancelled by navigation was silently lost.** The dashboard toggles
  move optimistically; clicking one and immediately navigating showed the
  change applied and never made it. Those requests are `keepalive` now.

## 0.4.1

### Fixed

- **A `developer` message did not suppress the platform's system prompt.** It is
  what clients targeting OpenAI's reasoning models send in place of `system`, so
  such a caller got the operator's default injected alongside its own
  instructions — two competing sets, with the platform's first and therefore
  dominant in most chat templates. It now counts as a system message, in
  injection and in the prefix-cache affinity key alike.
- **An empty system message suppressed the default.** A client sending
  `{role: "system", content: ""}` as a placeholder silently lost the operator's
  configured prompt. Whitespace-only content no longer counts as a caller
  prompt.

## 0.4.0

### Added

- **KEDA can be installed by this chart.** Vendored as a subchart
  (`charts/keda-*.tgz`, committed) so `helm install` needs no chart repository,
  which an air-gapped cluster cannot reach. One release now brings up the
  gateway, its database, its models and the autoscaler.

  Off by default. KEDA is cluster-scoped: two operators reconcile the same
  ScaledObjects and fight, and `helm uninstall` would remove it from every
  other workload using it. With it on, the chart refuses to install over a
  KEDA it does not own rather than quietly creating a second one — Helm skips
  CRDs that already exist, so that case fails silently at install and
  confusingly later.

  KEDA ships its CRDs in `templates/`, which cannot work here: Helm resolves
  every manifest's kind before applying anything, so the install failed with
  "no matches for kind ScaledObject" before KEDA's own CRD existed. The CRDs
  are therefore vendored into this chart's `crds/` (installed ahead of all
  templates) and the subchart's copies disabled, since two Helm-managed copies
  of one CRD fail on ownership. `refresh-keda-crd.sh` re-vendors both together.

  Verified on a cluster with KEDA removed entirely: a single `helm install`
  brought up the operator and the fleet scaled 1 → 3 → 1 under load.

### Fixed

- **CI fetched a chart repository it no longer needed.** The Bitnami repo and
  `helm dependency build` were left over from when Postgres was a subchart.
  Both are gone: CI now lints, renders and packages with no chart repositories
  configured, which is the closest thing it has to the air-gapped cluster this
  installs on — so un-vendoring the subchart fails there rather than on a
  customer's cluster. It also renders the two paths a default template never
  reaches: `keda.enabled=true`, and the full worked example.

## 0.3.1

Found while matching the example values to the real `epodegrid/model-containers`
images, and verified against a live llama-swap.

### Fixed

- **A thinking model's reasoning was dropped entirely.** llama.cpp carries it
  as `reasoning_content`, not `content`, and the adapter read only the latter —
  so a variant like `ornith:thinking-coding` streamed nothing to the caller for
  the whole of its thinking phase, and the reasoning was absent from the audit
  trail and uncounted for cost. It is now forwarded as `reasoning_content` on
  the delta (and on the non-streaming message), counted as generated tokens,
  and logged under the same §6.8 scopes as the answer.
- **llama-swap's loading banner would have been streamed as model output.**
  With `sendLoadingState: true` — set in every model config in that fleet — it
  emits a progress banner as `reasoning_content` deltas while it loads weights.
  Those frames carry no `id`, `object` or `model`, because no model produced
  them; they are now suppressed, so the banner is never billed as tokens or
  recorded as content. A real 25-second cold load went from 105 raw frames to
  8 clean ones with no leakage.

- **`ingress.enabled` did nothing.** The value was documented and read by
  nobody — there was no Ingress template — so a chart configured for external
  access silently produced none. Now rendered, with per-path selection between
  the router and the dashboard so both can share one host and the browser can
  call the API same-origin.
- **KEDA warned on every apply.** `pollingInterval` and `cooldownPeriod` apply
  only to the scale-to-zero path; they are now emitted only when a model
  actually scales to zero, so the manifest states what is in effect.

### Added

- **`imagePullSecrets`**, applied to every pod the chart creates. An air-gapped
  install pulls from an internal mirror, which normally needs credentials.
- **`postgresql.auth.existingSecret`.** A password in values is rendered into
  the release manifest stored in the cluster; with this set the chart renders
  no password at all and the router assembles its connection string at run
  time from the Secret you manage.
- **`postgresql.persistence.storageClass`** and **`postgresql.host`** — the
  cluster default class is rarely what you want under a database, and an
  external managed Postgres needs an address.
- **`ingress.tls`**, passed through as given.
- **A complete, deployment-ready example** in
  `examples/values-model-containers.yaml`: router, dashboard, Postgres,
  ingress, and the whole model fleet, with every environment-specific value
  marked. Verified with `kubectl apply --dry-run=server` against a live API
  server with the KEDA CRDs present.

## 0.3.0

Compatibility with real llama-swap model containers. Verified against a live
llama-swap running `llama-server`, and on minikube with KEDA for the cluster
paths.

### Fixed

- **The `model` field was never sent upstream.** llama-swap selects which model
  process to proxy to entirely from it; without it every request came back
  `{"error":"no model id could be identified"}`. Confirmed against a real
  container, not inferred.
- **A cold start was killed as a stall.** Weights load on demand, on the first
  request naming a model, and the connection is held open in silence while
  they do — minutes for a large GGUF. The 60s inactivity clock swept exactly
  those requests. PRD §6.5 scopes that clock to "once generation has started",
  so the wait for a first token is now its own, far longer allowance
  (`firstTokenTimeoutMs`, default 10 minutes). A 90-second silent load now
  completes; previously it failed at 60 seconds, on every scale-up.
- **The backend port was hardcoded to 8080**, making a service on any other
  port unreachable. It is per-model now, in pod discovery, the Service
  target and the container port alike.
- **Readiness gating on llama-swap's `/health` was a no-op.** It reports the
  proxy, not the model, and answers 200 "OK" with nothing loaded. The chart
  says so where the probe is defined, and the first-token allowance covers the
  load instead.
- **A non-default port was declared but never configured.** The chart set the
  container port, Service target and probe from a model's `port`, while the
  mock container went on listening on 8080 — so a model on any other port never
  passed readiness. Found on minikube, not by reading the template.
- **Log noise.** Successful health probes are dropped (kubelet polls every few
  seconds per pod), and llama-swap's connection retries during a model load are
  warnings rather than errors — a cold start no longer paints the panel red.

### Added

- **`upstreamModel`**, so the model name callers see is decoupled from the name
  the container answers to. A fleet's variant aliases (`eve:thinking-coding`)
  can be pointed at without exposing them as separate models.
- **`backendRef`: several registry entries can share one container.** One image
  commonly answers to several names over the same loaded weights. Each now gets
  its own entry — own prompt, cost, advertised capabilities — while only the
  referenced model gets a Deployment, a Service and a ScaledObject. Replicas,
  in-flight accounting, cache affinity and the scaling metric are all keyed by
  the backend, so aliases share pods and one HPA reads their combined queue
  instead of two competing for the same capacity.
- **Upstream names are verified against the backend.** They live in the
  container image's own config rather than in the values file, so a rebuild can
  rename one and leave the deployment green while every request to it fails.
  The reconciler checks each `upstreamModel` against the backend's `/v1/models`
  (llama-swap lists its aliases there, without loading weights) and the Models
  page names the mismatch and what the container does serve. A backend with no
  usable listing reports "unverifiable", never "wrong".
- **`nodeSelector` / `tolerations` / `runtimeClassName` per model.** Model
  images are commonly built per micro-architecture; a mismatched build dies
  with an illegal instruction rather than a graceful error.
- **`helm/controldeck/examples/values-model-containers.yaml`** — a worked
  example for a llama-swap fleet, including a non-llama-swap embedding service
  on a different port.

## 0.2.0

The release that makes a Kubernetes deployment actually work. Verified against
minikube with KEDA and a real `llama.cpp` server; the OpenAI surface is verified
with the official SDK.

### Breaking

- **Postgres is no longer a Bitnami subchart.** Bitnami withdrew their public
  Docker Hub images, so `helm install` failed at the image pull and the chart
  could not be installed at all. It is now a StatefulSet on the official
  `postgres` image, which also removes an external chart repository from the
  deployment path — a poor fit for a platform meant to run without outbound
  access. Values move accordingly:

  ```diff
   postgresql:
  -  primary:
  -    persistence:
  -      enabled: true
  -      size: 20Gi
  +  persistence:
  +    enabled: true
  +    size: 20Gi
  +  image: postgres:16-alpine
  +  auth:
  +    password: <set this>
  ```

  There is no migration path for existing data: point the new StatefulSet at
  the old PersistentVolume, or dump and restore.

- **An unknown model now returns `404 model_not_found`** instead of
  `422 capability_mismatch`. Clients branching on the old status need updating.
  The two cases are genuinely different — a typo in the model name calls for a
  different fix than a request the model cannot serve.

- **`dashboard.env.NEXT_PUBLIC_API_BASE_URL` now defaults to empty.** The
  server-side address is derived from the release name automatically. Set this
  only where the browser calls the API on a different origin.

- **Models must be declared under `models:` in values.** They are reconciled
  into the registry at router start-up. Previously nothing loaded them, so this
  is new behaviour rather than a changed contract — but a chart deployed
  without `models:` will now register none.

### Fixed

- **KEDA never scaled.** The trigger URL used a bare Service name, which the
  operator — running in its own namespace — could not resolve. The metric was
  also a 0/1 flag against a target of 1, so `ceil(1/1)` capped every deployment
  at one replica regardless of `maxReplicaCount`.
- **Models were never registered from Helm.** A fresh install came up with an
  empty registry, so `/v1/models` returned nothing and every request failed.
- **Replicas were not pods.** In-cluster discovery fell back to the Service
  address, so every replica shared one address and per-replica placement,
  throughput and log tailing were all fiction.
- **The router had no RBAC**, so pod discovery and pod logs both failed.
- **Scale-down failed in-flight requests.** A terminating pod keeps its IP and
  answers `/health`, so the router kept placing on it.
- **Tool calls did not work.** `tools[]` was never forwarded, and an assistant
  message with null content — the shape of every multi-turn tool exchange —
  crashed the router with a 500.
- **Sampling parameters were dropped.** `temperature`, `top_p`, `max_tokens`,
  `stop`, `seed` and the penalties never reached the model.
- **Responses omitted `created`**, which the OpenAI schema requires, and
  streams never opened with the assistant role delta.
- **Log streaming was fabricated.** The panel showed lines generated from
  database state; it now streams real container stdout.
- **SSE responses carried no CORS headers**, so log streaming and streaming
  chat completions both failed in a browser while working under curl.

### Added

- **Prefix-cache affinity.** Later turns of a conversation are routed back to
  the replica holding its KV cache, as a preference that never overrides
  least-loaded placement.
- **Throughput-aware placement.** Observed tokens/sec per replica breaks ties,
  with measurements expiring so a replica that had one slow period is not
  starved permanently.
- **Prompt redaction in the log panel.** Model servers print prompts at higher
  verbosity, which would otherwise bypass the content-logging scopes of §6.8.
- **App-role support** for dashboard admin access, avoiding the group-claim
  overage that silently locks out users in many groups.
- **A conformance suite** driven by the official OpenAI SDK.

## 0.1.0

First release: router, dashboard, Helm chart, and the mock model and OIDC
services used to exercise them.
