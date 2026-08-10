import { getPool } from "../db/pool.js";
import { listModels } from "../registry/index.js";
import { replicaEndpointsFor, replicaIdFor } from "./discovery.js";
import { inCluster, listModelPods, listPodMetrics } from "./kubernetes.js";
import {
  listUpstreamNames,
  checkUpstreamName,
  recordUpstreamCheck,
} from "../registry/verify-upstream.js";

/**
 * Keeps the `replicas` table in step with what the model backends are actually
 * reporting (PRD §6.4 readiness gating).
 *
 * Before this existed, replica rows were fixtures written by the seed: the
 * dashboard showed a "loading" replica that would never finish loading and a
 * "busy" one that was serving nothing. Now a replica exists because an
 * endpoint answered, and its status reflects that endpoint's last probe.
 *
 * Ownership is split deliberately and must stay that way:
 *
 *   reconciler owns — which replicas exist, `status` (reachability),
 *                     `max_concurrency`, `endpoint_url`, `last_seen_at`
 *   scheduler owns  — `in_flight`
 *
 * So `status` answers "can this replica take work at all", while saturation is
 * `in_flight >= max_concurrency`, evaluated at placement time. If the
 * reconciler also flipped rows to 'busy' it would race the scheduler and pin
 * replicas out of the eligible pool until the next pass.
 */

/** How long a probe may take before the replica is treated as unreachable. */
const PROBE_TIMEOUT_MS = Number(process.env.REPLICA_PROBE_TIMEOUT_MS ?? 2000);

export type ProbeResult = {
  status: "ready" | "loading" | "error";
  maxConcurrency: number | null;
};

/**
 * Probes one backend's readiness endpoint.
 *
 * The contract matches llama-swap's (and the mock model's): 200 means weights
 * are loaded and traffic is welcome; 503 means still warming; anything else,
 * or no answer at all, means do not route here.
 */
export async function probeReplica(endpointUrl: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(`${endpointUrl}/health`, { signal: controller.signal });

    let maxConcurrency: number | null = null;
    try {
      const body = (await res.json()) as { maxConcurrency?: unknown };
      if (typeof body?.maxConcurrency === "number" && body.maxConcurrency >= 1) {
        maxConcurrency = Math.floor(body.maxConcurrency);
      }
    } catch {
      // A bare 200 with no JSON body is a valid readiness signal.
    }

    if (res.ok) return { status: "ready", maxConcurrency };
    if (res.status === 503) return { status: "loading", maxConcurrency };
    return { status: "error", maxConcurrency };
  } catch {
    // Timeout, DNS failure, connection refused — all "not routable".
    return { status: "error", maxConcurrency: null };
  } finally {
    clearTimeout(timer);
  }
}

export type ReconcileSummary = {
  models: number;
  ready: number;
  loading: number;
  error: number;
  removed: number;
};

export async function reconcileReplicas(): Promise<ReconcileSummary> {
  const pool = getPool();
  const models = await listModels();
  const summary: ReconcileSummary = { models: models.length, ready: 0, loading: 0, error: 0, removed: 0 };

  const seenIds: string[] = [];

  // Probe backends, not registry entries. Several entries can share one
  // workload — llama-swap aliases over the same loaded weights — and a replica
  // is a property of the pod, not of the name. Probing per entry would have
  // each alias rediscover the same pods and overwrite one another's rows (the
  // pod name is the replica id), and would multiply the probe traffic by the
  // number of aliases for no new information.
  const backends = new Map<string, (typeof models)[number]>();
  for (const model of models) {
    if (!backends.has(model.backendModelId)) {
      // Prefer the owning entry's own config where it exists, since that is
      // the one carrying the workload's port and endpoint.
      backends.set(model.backendModelId, models.find((m) => m.id === model.backendModelId) ?? model);
    }
  }

  for (const model of backends.values()) {
    // In-cluster, a replica is a pod: addressed by its own IP and named so the
    // log tail can ask the Kubernetes API for it. Everywhere else, the
    // configured endpoint list. Falling back to the model's Service address
    // would make every replica the same address and per-replica placement
    // meaningless.
    let candidates: Array<{ id: string; endpointUrl: string; restartCount?: number }>;
    // Per-pod CPU and memory, when the cluster has metrics-server. One call
    // for the whole model rather than one per pod.
    let metrics: Map<string, { cpuMillicores: number; memoryBytes: number }> | null = null;
    if (inCluster()) {
      try {
        const pods = await listModelPods(model.backendModelId, model.port);
        candidates = pods.map((pod) => ({
          id: pod.name,
          endpointUrl: pod.endpointUrl,
          restartCount: pod.restartCount,
        }));
        const sampled = await listPodMetrics(model.backendModelId);
        if (sampled) metrics = new Map(sampled.map((m) => [m.name, m]));
      } catch (err) {
        // A denied or failing pod list must not wipe the fleet from the
        // dashboard; keep the previous view and let the next pass retry.
        console.error(
          `[reconcile] pod discovery failed for ${model.backendModelId}: ${err instanceof Error ? err.message : err}`
        );
        const { rows } = await pool.query<{ id: string; endpoint_url: string }>(
          `SELECT id, endpoint_url FROM replicas WHERE model_id = $1`,
          [model.backendModelId]
        );
        candidates = rows.map((r) => ({ id: r.id, endpointUrl: r.endpoint_url }));
      }
    } else {
      candidates = replicaEndpointsFor(model).map((endpointUrl) => ({
        id: replicaIdFor(model.backendModelId, endpointUrl),
        endpointUrl,
      }));
    }

    // Probe a model's replicas together — a slow backend shouldn't delay the
    // rest of the fleet's status from refreshing.
    const probes = await Promise.all(
      candidates.map(async (candidate) => ({
        ...candidate,
        ...(await probeReplica(candidate.endpointUrl)),
      }))
    );

    // Verify the configured upstream names against what the backend actually
    // serves, using any replica that answered. The names live in the container
    // image's own config, so this is the only place the two can be compared —
    // and a mismatch otherwise surfaces only as a failed request.
    const reachable = probes.find((p) => p.status === "ready");
    if (reachable) {
      const available = await listUpstreamNames(reachable.endpointUrl);
      for (const entry of models) {
        if (entry.backendModelId !== model.backendModelId) continue;
        recordUpstreamCheck(entry.id, checkUpstreamName(entry, available));
      }
    }

    for (const probe of probes) {
      seenIds.push(probe.id);
      summary[probe.status] += 1;

      const sample = metrics?.get(probe.id) ?? null;
      await pool.query(
        `INSERT INTO replicas (id, model_id, status, in_flight, load_pct, endpoint_url, max_concurrency,
                               cpu_millicores, memory_bytes, restart_count, last_seen_at)
         VALUES ($1, $2, $3, 0, 0, $4, COALESCE($5, 1), $6, $7, COALESCE($8, 0), now())
         ON CONFLICT (id) DO UPDATE SET
           model_id = EXCLUDED.model_id,
           status = EXCLUDED.status,
           endpoint_url = EXCLUDED.endpoint_url,
           -- Keep the last known figures when a pass has none, so a cluster
           -- without metrics-server shows nothing rather than flickering, and
           -- one momentary API failure does not blank a working panel.
           cpu_millicores = COALESCE($6, replicas.cpu_millicores),
           memory_bytes = COALESCE($7, replicas.memory_bytes),
           restart_count = COALESCE($8, replicas.restart_count),
           -- Only adopt a reported ceiling; never reset a working value to the
           -- default because one probe came back without a body.
           max_concurrency = COALESCE($5, replicas.max_concurrency),
           last_seen_at = now(),
           load_pct = CASE
             WHEN COALESCE($5, replicas.max_concurrency) > 0
             THEN LEAST(100, (replicas.in_flight::numeric / COALESCE($5, replicas.max_concurrency)) * 100)
             ELSE 0
           END,
           updated_at = now()`,
        [
          probe.id,
          model.backendModelId,
          probe.status,
          probe.endpointUrl,
          probe.maxConcurrency,
          sample ? sample.cpuMillicores : null,
          sample ? Math.round(sample.memoryBytes) : null,
          probe.restartCount ?? null,
        ]
      );
    }
  }

  // Drop replicas that no longer appear in any model's fleet — a scaled-down
  // pod, or a model removed from the registry. `requests.replica_id` has no FK
  // constraint, so historical rows keep their (now dangling) id as a record of
  // where the request actually ran.
  const { rowCount } = await pool.query(
    seenIds.length > 0
      ? `DELETE FROM replicas WHERE NOT (id = ANY($1))`
      : `DELETE FROM replicas`,
    seenIds.length > 0 ? [seenIds] : []
  );
  summary.removed = rowCount ?? 0;

  return summary;
}
