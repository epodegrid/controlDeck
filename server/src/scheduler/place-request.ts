import { getPool } from "../db/pool.js";
import type { Replica, ReplicaStatus } from "../types.js";
import type { KedaClient } from "../adapters/keda.js";
import { NoopKedaClient } from "../adapters/keda.js";

export type PlaceRequestOptions = {
  kedaClient?: KedaClient;
};

export type PlaceRequestResult =
  | { ok: true; replica: Replica }
  | { ok: false; needsQueue: true };

type ReplicaRow = {
  id: string;
  model_id: string;
  status: ReplicaStatus;
  in_flight: number;
  load_pct: string | number;
  tokens_per_sec: string | number | null;
  endpoint_url: string;
  old_in_flight: number;
};

function toReplica(row: ReplicaRow): Replica {
  return {
    id: row.id,
    modelId: row.model_id,
    status: row.status,
    inFlight: Number(row.in_flight),
    loadPct: Number(row.load_pct),
    tokensPerSec: row.tokens_per_sec === null ? null : Number(row.tokens_per_sec),
    endpointUrl: row.endpoint_url ?? "",
  };
}

/**
 * Least-loaded placement (PRD §6.4). Picks the ready replica for `modelId`
 * with the lowest in_flight (ties broken by load_pct, then id for
 * determinism), and atomically bumps its in_flight count.
 *
 * Note: we deliberately do NOT flip `status` away from 'ready' on placement.
 * A "ready" replica can serve multiple concurrent in-flight requests (that's
 * exactly what in_flight tracks); status here reflects readiness to receive
 * traffic, not saturation. This keeps every ready replica eligible for
 * least-loaded placement on every call, which is what actually distributes
 * concurrent load across replicas instead of pinning all overflow onto
 * whichever replica got the first request.
 *
 * Saturation is instead bounded by each replica's `max_concurrency`: a replica
 * at its ceiling is not an eligible placement target, and when every ready
 * replica is at its ceiling the request goes to the queue. That is what makes
 * §6.4's "if none are free, route to queue" — and therefore §6.5's queue-wait
 * timeout — reachable at all. It also keeps in_flight an honest reflection of
 * what the backend can actually serve concurrently; without a ceiling the
 * router hands work to slots that don't exist and the backend rejects it.
 *
 * The SELECT ... FOR UPDATE SKIP LOCKED inside the CTE guarantees that under
 * concurrent calls (including from other router instances sharing this same
 * Postgres — the §8 HA requirement) two callers never pick the same replica
 * row: whichever caller's transaction locks the row first "wins" it, and any
 * concurrent caller skips past the locked row to the next-best candidate.
 * Only replicas with status = 'ready' are eligible for new placement.
 */
export async function placeRequest(
  modelId: string,
  options: PlaceRequestOptions = {}
): Promise<PlaceRequestResult> {
  const { kedaClient = new NoopKedaClient() } = options;
  const pool = getPool();

  const { rows } = await pool.query<ReplicaRow>(
    `WITH selected AS (
       SELECT id, in_flight AS old_in_flight
       FROM replicas
       WHERE model_id = $1 AND status = 'ready' AND in_flight < max_concurrency
       ORDER BY in_flight ASC, load_pct ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE replicas r
     SET in_flight = r.in_flight + 1,
         updated_at = now()
     FROM selected s
     WHERE r.id = s.id
     RETURNING r.id, r.model_id, r.status, r.in_flight, r.load_pct, r.tokens_per_sec, r.endpoint_url, s.old_in_flight`,
    [modelId]
  );

  if (rows.length === 0) {
    return { ok: false, needsQueue: true };
  }

  const row = rows[0];
  const replica = toReplica(row);

  // "The moment any replica of a model receives its first request" — i.e.
  // this replica transitioned from idle (in_flight === 0) to serving. We only
  // fire once per idle->busy transition of a given replica, not on every
  // subsequent request that lands on an already-busy replica.
  if (Number(row.old_in_flight) === 0) {
    await kedaClient.requestScaleUp(modelId);
  }

  return { ok: true, replica };
}
