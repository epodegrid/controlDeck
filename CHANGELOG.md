# Changelog

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
