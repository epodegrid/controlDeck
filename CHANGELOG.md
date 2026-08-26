# Changelog

## 0.5.6

Compaction still failing, from the other end: the summary request is the
largest and slowest an agent ever sends, and two gateway defaults were sized
for a chat turn.

### Fixed

- **Requests over 1 MiB were rejected.** Fastify's default `bodyLimit` is one
  megabyte, and nothing overrode it. A compaction request carries the entire
  conversation in one call, so it is the single request most likely to exceed
  that — and it arrived as a raw `FST_ERR_CTP_BODY_TOO_LARGE`, which is not an
  OpenAI error at all, so a client saw an unparseable shape rather than a
  reason. The limit is now 32 MB (`BODY_LIMIT_BYTES`), matching the ingress
  annotation in the worked example, and a body that genuinely is too large
  returns the standard error shape naming the setting to change.

- **The generation timeouts never reached the live request.** §6.5's clocks
  were enforced only by periodic sweeps, which mark database rows and cannot
  touch a connection that is already open. A model stuck in prompt evaluation
  — which is what a near-full context window causes — left the caller waiting
  indefinitely while the row read `stall_timeout`, until the client gave up on
  its own with nothing to explain why.

  Both clocks now abort the upstream request: the caller gets `504` naming
  which clock ran out and what to change, and the audit trail matches what
  actually happened.

- **A failure's recorded status depended on which code path noticed it.** The
  mapping from error code to request status was a chain of ternaries covering
  two codes, so a stall timeout enforced on the live request was filed as
  `error` while the sweep filed the identical failure as `stall_timeout`.

## 0.5.5

Compaction is the agent's job — controlDeck is stateless and holds no
conversation — but two things it reported were wrong in ways that stopped an
agent from doing that job.

### Fixed

- **`usage.prompt_tokens` was invented, not measured.** It was estimated as
  message characters divided by four, which omits tool schemas completely.
  Against an agent-shaped request the gateway reported **272 prompt tokens
  where the model counted 1,822** — an 85% under-report. An agent decides when
  to compact its history from that number, so it believed it had five times the
  headroom it had, never compacted, and ran into a hard context error instead.

  The backend's own counts are now used wherever it reports them
  (`stream_options: {include_usage: true}` is sent upstream, since llama.cpp
  emits no usage while streaming without it), falling back to the estimate only
  for backends that report none. This also corrects cost tracking (§6.7), which
  was understating tool-heavy traffic by the same factor.

- **A context overflow returned a code no agent recognises.** It came back as
  the generic `invalid_request`; OpenAI's `context_length_exceeded` is what
  clients branch on to summarise and retry. Detected from the backend's own
  error — llama.cpp raises `exceed_context_size_error`, vLLM says "maximum
  context length", others differ again — so the caller gets an actionable code
  whichever backend is behind it.

- **Backend errors quoted their JSON envelope.** `Model backend returned 400:
  {"error":{"code":400,"message":"request (40013 tokens) exceeds…` now reads
  `Model backend returned 400: request (40013 tokens) exceeds the available
  context size (32768 tokens)`.

### Added

- **A usage chunk for streaming callers that ask for one.** OpenAI sends a
  final usage-only chunk when `stream_options.include_usage` is set, and an
  agent tracking its context window mid-stream depends on it.

## 0.5.4

### Added

- **`?dry_run=1` on `/v1/chat/completions`.** Returns the exact body the gateway
  would send upstream and calls nothing — no request row, no placement, no
  cost. Built from the same function the real path uses, so it cannot drift
  into describing something the gateway does not send.

  "Is the gateway dropping my system prompt, or is the model ignoring it?" has
  now twice needed a packet capture between the router and the backend to
  answer. The gateway knows, and should simply say. It returns only what the
  caller themselves just sent, plus the platform's own additions.

## 0.5.3

### Added

- **`systemPromptMode: merge`, for chat templates with no system role.** Gemma's
  has none — it knows only user and model turns — so a system message is
  dropped and the model ignores its instructions entirely, while every layer
  above reports success: the gateway forwards it, llama.cpp accepts the
  request, and nothing anywhere reports a fault. `merge` folds the system
  message into the first user turn instead, which is how such templates are
  conventionally fed one.

  Set per model, defaulting to `passthrough`. The worked example turns it on
  for the Gemma-based model only.

  Worth stating plainly: the gateway was **not** dropping the prompt. Running a
  real opencode session through a recording proxy showed 9,537 characters of
  system prompt and all ten tool definitions forwarded intact, which is what
  narrowed the loss to the template. `developer` messages merge too, since
  clients targeting OpenAI's reasoning models send that instead.

## 0.5.2

### Fixed

- **"Log full prompt + response body" wrote a row nothing reads.** The global
  content-logging scope is keyed by the empty string, which is what the gate
  checks — but the audit page sent `"global"` as the key while the settings
  page sent `""`. On a fresh install, with no seeded rows, the audit page's
  switch moved, persisted, and gated nothing, and the two pages then showed
  different answers for the same setting.

  The key is now normalised server-side, so no caller can get it wrong, and a
  migration collapses any stray row onto the real one — keeping it enabled if
  either was, since an operator who turned content logging on should not have
  it silently turn off on upgrade.

## 0.5.1

The NetworkPolicy shipped in 0.5.0 did not work. Tested against a real
default-deny CNI this time, rather than reasoned about.

### Fixed

- **The NetworkPolicy selected no pods.** It matched
  `app.kubernetes.io/part-of: controldeck`, which was on the Deployments but
  never on the pod templates — and a policy matching nothing silently allows
  nothing, which under a default-deny cluster is indistinguishable from having
  written no policy at all. The label is now on every pod the chart creates.

- **The NetworkPolicy covered ingress only.** Where the cluster's deny-all also
  denies egress, the router cannot reach Postgres, its replicas or the
  Kubernetes API; it crash-loops on start-up and the rollout never completes,
  which reads as an image or config fault rather than a network one.
  `networkPolicy.egress.enabled` adds the matching rules.

### Added

- **`docs/networkpolicy-keda.yaml`**, the KEDA side of the same problem.
  Verified end to end on minikube with Calico: with deny-all in both namespaces
  the external-metrics APIService goes `Available=False` and every HPA reads
  `<unknown>`. Four separate hops have to be opened, and each one alone leaves
  the identical symptom — kube-apiserver→metrics apiserver, metrics
  apiserver→operator over gRPC, KEDA→router, and router→its own dependencies.

  Two things that make this hard to get right are documented where they bite:
  Kubernetes evaluates policy *after* DNAT, so allowing egress to the API
  server on 443 does nothing (it has to be the real endpoint address and port),
  and Calico does not tear down established connections — KEDA kept working for
  minutes after deny-all landed and only broke when its pods restarted, so "it
  still works" immediately after an apply proves nothing.

## 0.5.0

Everything an agent client needs, and the means to diagnose autoscaling without
a shell on the cluster. Verified against a real llama-swap container and a real
opencode session.

### Added

- **The dashboard says why a model is not autoscaling.** The router reads the
  ScaledObject and the HPA and reports one of: KEDA has not created an HPA
  (the operator is not processing it — usually `watchNamespace` set elsewhere),
  the HPA cannot read the metric, no ScaledObject exists, or scaling normally
  with the current demand figure. It also shows the URL KEDA was told to poll,
  because KEDA's own HPA condition stops at "encountered error" and never says
  what failed — the address is the one thing an operator can check by eye.

  This exists because diagnosing it otherwise means running kubectl against a
  production cluster, which is not always possible. Read-only; a missing RBAC
  rule reports "unknown" rather than taking the page down. Both failure states
  were verified by reproducing them in a cluster.

- **`networkPolicy.enabled`.** A locked-down cluster commonly default-denies
  between namespaces, and then everything works except KEDA's metrics
  apiserver reaching the router — the HPA shows `<unknown>` and the fleet never
  scales, silently. Off by default, since creating a NetworkPolicy where none
  existed is a restriction rather than a permission.

### Fixed

- **The KEDA preflight guard only looked in three namespaces.** It checked the
  release namespace, `keda` and `kube-system`, so an operator installed
  anywhere else was missed — and missing it is the entire failure the guard
  exists to prevent. It now scans every namespace.

- **CPU, memory and restart count were hardcoded placeholders.** The monitoring
  view showed "—" with "requires K8s metrics API, not wired in this build", and
  two thirds of that was wrong: restart count comes straight off the pod object
  the reconciler already fetches, and CPU/memory need `metrics.k8s.io`, which
  AKS installs by default. All three are now read per replica. Verified in a
  cluster against `kubectl top` (2m / 31Mi) and by killing a container at the
  runtime level to watch the restart count propagate.

  CPU and memory stay null where metrics-server is absent, and the panel says
  so — a zero would read as an idle replica, which is a different claim.

- **The hourly distribution chart rendered nothing.** Every bar carried a
  correct inline `height: 40%` and computed to 0 pixels: a percentage height
  resolves against the parent's height, and the column wrapping the bars had
  none. The data, the query and the styles were all fine and the chart was
  blank. The regression test asserts rendered geometry, because one that checks
  the bars exist passes on a chart nobody can see.

- **"Per model" content logging toggled one arbitrary model.** The summary rows
  were switches bound to `modelScopes[0]` and `teamScopes[0]` while their
  labels implied they governed all of them, and the expandable breakdown was
  read-only and teams-only — so scoping content logging to a single model was
  not possible at all. The summaries are counts now, and every team and model
  has its own switch.

  Per-API-key scoping remains deliberately inert, labelled "Reserved · not yet
  active". The backend accepts the scope; nothing issues platform API keys yet.

- **A model without a `keda:` block crashed `helm install`.** Every field in it
  has a default, so omitting the block is a legitimate declaration — but the
  template read through the missing map and panicked at render time, failing
  the whole install with a message naming a field rather than the model.

- **Tool calls never reached the client.** The router forwarded `tools`
  upstream, the model made the call, and the response path threw it away: the
  adapter read only `content` and `reasoning_content`, and `finish_reason` was
  hardcoded to `"stop"`. Every agent client — opencode, Copilot, anything with
  a tool loop — saw a model that thought out loud and never touched a file, in
  both the streaming and non-streaming paths.

  `tool_calls` deltas are now forwarded verbatim while streaming (arguments
  arrive fragmented, so reassembling them is the client's job), assembled into
  whole calls for a non-streaming response, counted as generated tokens, and
  recorded in the audit trail — a tool call is the whole of some turns.
  `finish_reason` comes from upstream, so `"tool_calls"` reaches the loop that
  branches on it.

  0.2.0 claimed to fix tool calling; it fixed the request direction only. The
  test that let this through asserted that sending `tools` "does not break the
  stream" — true, and worthless.

- **Every upstream error was reported as a capacity failure.** A 400 from the
  model server — a prompt longer than the context window, most often — came
  back as `503 replica_unavailable`, which tells a client to retry. opencode
  re-sent an impossible request nine times with backoff before giving up. A
  4xx is now `400 invalid_request`; 5xx and dropped connections stay
  retryable.

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

### Added

- **An integration suite against a real model container.** `test-model/` packs
  Qwen3-0.6B (409 MB, pinned by digest) behind llama-swap exactly as the
  production fleet is packed — weights baked in, nothing fetched at run time.
  `./scripts/e2e-real-model.sh` runs the adapter against the container and an
  agent loop, driven by the official OpenAI SDK, through the router with tools
  that genuinely read, write and execute in a temp workspace.

  Every bug above needed a real llama-swap to find. Fakes echo the shape you
  already believed in, and these paths broke precisely where that belief was
  wrong.

  Qwen3-0.6B was chosen by measurement, not size: it emits real
  `reasoning_content`, calls tools, and ships a jinja template. Qwen3.5-0.8B
  produced tool calls in 0 of 8 attempts, and gemma-4-26B-A4B does not load at
  all under this llama.cpp build (it needs `ctx_other`).

- **`scripts/e2e-opencode.sh`** drives the real opencode CLI against a running
  gateway and checks it can read a file and write one. Not in CI — it installs
  opencode over the network — but it is what proves the fix from the client's
  side rather than the protocol's.

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
