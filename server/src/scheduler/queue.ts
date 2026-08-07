import { getPool } from "../db/pool.js";
import type { Capability } from "../types.js";

/** PRD §6.5 — queue-wait timeout default: 5 minutes. */
export const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS ?? 300_000);

/** PRD §6.5 — stall/inactivity timeout default: 60 seconds. */
export const STALL_TIMEOUT_MS = Number(process.env.STALL_TIMEOUT_MS ?? 60_000);

export type EnqueueRequestInput = {
  id: string;
  callerOid: string;
  callerName: string;
  team?: string;
  requestedModel?: string;
  capabilities?: Capability[];
};

/**
 * Inserts a new `requests` row in `status = 'queued'` with `arrived_at =
 * now()`. This is the entry point for a request that has no replica
 * assignment yet (PRD §6.5, clock #1: queue-wait timeout).
 */
export async function enqueueRequest(input: EnqueueRequestInput): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO requests (id, caller_oid, caller_name, team, requested_model, capabilities, status, arrived_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued', now())`,
    [
      input.id,
      input.callerOid,
      input.callerName,
      input.team ?? null,
      input.requestedModel ?? null,
      input.capabilities ?? [],
    ]
  );
}

/**
 * Sweeps requests stuck in `status = 'queued'` whose `arrived_at` is older
 * than `timeoutMs` (default `QUEUE_TIMEOUT_MS`, 5 minutes per §6.5), flipping
 * them to `status = 'queue_timeout'` / `error_code = 'queue_timeout'` with
 * `completed_at = now()`. Returns the ids that were swept.
 */
export async function sweepQueueTimeouts(timeoutMs: number = QUEUE_TIMEOUT_MS): Promise<string[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE requests
     SET status = 'queue_timeout',
         error_code = 'queue_timeout',
         completed_at = now()
     WHERE status = 'queued'
       AND arrived_at < now() - ($1 || ' milliseconds')::interval
     RETURNING id`,
    [timeoutMs]
  );
  return rows.map((r) => r.id);
}

/**
 * Times out one specific queued request.
 *
 * Distinct from `sweepQueueTimeouts`, which is the periodic background sweep
 * over everything that has aged out. When a single caller's own wait expires,
 * only that caller's request may be failed — calling the sweep with a zero
 * timeout would flip every queued request across every model to
 * `queue_timeout`, failing other callers who still had time left.
 *
 * Returns whether the row was still queued (and therefore actually timed out);
 * false means it was placed in the meantime and must be left alone.
 */
export async function expireQueuedRequest(requestId: string): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE requests
     SET status = 'queue_timeout',
         error_code = 'queue_timeout',
         completed_at = now()
     WHERE id = $1 AND status = 'queued'`,
    [requestId]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Marks a request as having started streaming from a specific replica:
 * `status = 'streaming'`, `started_at = now()`, `last_token_at = now()`.
 * From this point the stall/inactivity clock (§6.5, clock #2) governs it,
 * not the queue-wait clock.
 */
export async function markStreamStarted(requestId: string, replicaId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE requests
     SET status = 'streaming',
         replica_id = $2,
         started_at = now(),
         last_token_at = now()
     WHERE id = $1`,
    [requestId, replicaId]
  );
}

/**
 * Call on every token emitted during a stream. Bumps `last_token_at`
 * forward — this is what lets a slow-but-progressing generation (e.g. a 35B
 * model at ~15 tok/s) run to completion without ever hitting a fixed
 * wall-clock cap (§6.5's core guarantee).
 */
export async function recordTokenEmitted(requestId: string): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE requests SET last_token_at = now() WHERE id = $1`, [requestId]);
}

/**
 * Sweeps requests in `status = 'streaming'` whose `last_token_at` is older
 * than `thresholdMs` (default `STALL_TIMEOUT_MS`, 60s per §6.5), flipping
 * them to `status = 'stall_timeout'` / `error_code = 'stall_timeout'` with
 * `completed_at = now()`. Only inactivity (time since last token) matters —
 * there is no total-duration cap, so long-but-progressing streams are never
 * swept. Returns the ids that were swept.
 */
export async function sweepStallTimeouts(thresholdMs: number = STALL_TIMEOUT_MS): Promise<string[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE requests
     SET status = 'stall_timeout',
         error_code = 'stall_timeout',
         completed_at = now()
     WHERE status = 'streaming'
       AND last_token_at < now() - ($1 || ' milliseconds')::interval
     RETURNING id`,
    [thresholdMs]
  );
  return rows.map((r) => r.id);
}

export type CompleteRequestInput = {
  outputTokens: number;
  costUsd: number;
};

/**
 * Marks a request completed: `status = 'completed'`, `completed_at =
 * now()`, `duration_ms` computed from `started_at`, and decrements the
 * associated replica's `in_flight` (freeing its slot for the next
 * placement).
 */
export async function completeRequest(requestId: string, input: CompleteRequestInput): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ replica_id: string | null }>(
      `UPDATE requests
       SET status = 'completed',
           completed_at = now(),
           output_tokens = $2,
           cost_usd = $3,
           duration_ms = CASE
             WHEN started_at IS NOT NULL
             THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int
             ELSE 0
           END
       WHERE id = $1
       RETURNING replica_id`,
      [requestId, input.outputTokens, input.costUsd]
    );

    const replicaId = rows[0]?.replica_id ?? null;
    if (replicaId) {
      await client.query(
        `UPDATE replicas SET in_flight = GREATEST(0, in_flight - 1), updated_at = now() WHERE id = $1`,
        [replicaId]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
