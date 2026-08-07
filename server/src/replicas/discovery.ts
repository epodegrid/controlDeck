import type { ModelConfig } from "../types.js";

/**
 * Works out which concrete backend addresses make up a model's replica fleet.
 *
 * Two sources, in precedence order:
 *
 *   1. `MODEL_REPLICAS_<UPPER_SNAKE_ID>` — an explicit comma-separated list.
 *      This is what docker-compose and any static deployment use.
 *   2. The model's own `endpoint_url` — a single address. In Kubernetes this
 *      is normally a Service, which fronts many pods; the router then sees one
 *      logical replica and kube-proxy does the spreading underneath.
 *
 * A note on the Kubernetes case: to track individual pods as individual
 * replicas the operator should point this at a headless Service and list the
 * pod addresses, or set the env var from the Endpoints list. Watching the
 * Kubernetes API directly would give the router cluster-read permissions it
 * otherwise does not need, so that is left as an explicit opt-in rather than
 * something the router does on its own.
 */
export function replicaEndpointsFor(model: ModelConfig): string[] {
  const envKey = `MODEL_REPLICAS_${model.id.toUpperCase().replace(/-/g, "_")}`;
  const configured = process.env[envKey];

  if (configured) {
    const urls = configured
      .split(",")
      .map((u) => u.trim().replace(/\/+$/, ""))
      .filter(Boolean);
    if (urls.length > 0) return urls;
  }

  const single = model.endpointUrl.trim().replace(/\/+$/, "");
  return single ? [single] : [];
}

/**
 * Stable, human-readable replica id derived from the model and its address.
 *
 * Stability matters: the id is a foreign key on `requests.replica_id`, so a
 * reconcile pass must not rename a replica that has not moved, or historical
 * rows would point at something that no longer exists.
 */
export function replicaIdFor(modelId: string, endpointUrl: string): string {
  let host = endpointUrl;
  try {
    const url = new URL(endpointUrl);
    host = url.port ? `${url.hostname}-${url.port}` : url.hostname;
  } catch {
    // Not a parseable URL; fall back to a sanitized form of the raw string.
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${modelId}-${slug}`;
}
