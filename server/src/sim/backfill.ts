import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";
import { listModels } from "../registry/index.js";
import { getCostConfigForModel } from "../cost/index.js";
import { computeCost } from "../cost/compute.js";
import { isContentLoggingEnabled } from "../audit/index.js";
import { PERSONAS, pickBehaviour, pickPersona } from "./personas.js";
import { buildRequest } from "./build-request.js";
import { ANALYTICAL_PROMPTS, EMBEDDING_INPUTS, QUICK_PROMPTS, VISION_PROMPTS, pick } from "./prompts.js";

/**
 * Historical traffic generator.
 *
 * Live mode can only ever produce "now" — but the Cost and Audit views are
 * about trends over days, and an empty chart teaches nothing. Backfill writes
 * completed request rows with backdated timestamps directly to Postgres.
 *
 * This is the one place the simulator bypasses the router, and it does so
 * carefully: every row is built with the same cost function
 * (`computeCost`) and the same content-logging scope check
 * (`isContentLoggingEnabled`) the router itself uses, so backfilled history is
 * indistinguishable from history the router would have written. If the cost
 * rules change, this changes with them.
 */

export type BackfillOptions = {
  /** How many days of history to synthesize. */
  days: number;
  /** Approximate requests per day at peak; off-hours scale down from this. */
  requestsPerDay: number;
  /** Wipe previously backfilled rows before writing. */
  reset: boolean;
};

export const DEFAULT_BACKFILL_OPTIONS: BackfillOptions = {
  days: 7,
  requestsPerDay: 900,
  reset: false,
};

/**
 * Relative request volume by hour of day. Models a working day: quiet
 * overnight, ramp from 08:00, dip at lunch, peak mid-afternoon, taper after
 * 18:00. Without this the time-series charts are a flat uninformative band.
 */
const HOURLY_WEIGHTS = [
  0.05, 0.03, 0.02, 0.02, 0.03, 0.05, 0.12, 0.35, // 00–07
  0.70, 0.95, 1.00, 0.92, 0.65, 0.88, 1.00, 0.97, // 08–15
  0.85, 0.70, 0.45, 0.30, 0.22, 0.18, 0.12, 0.08, // 16–23
];

/**
 * Terminal statuses and how often each occurs. Weighted so the happy path
 * dominates but every error code in §6.6 has enough rows to be visible and
 * filterable on the dashboard.
 */
const STATUS_MIX: { status: string; errorCode: string | null; weight: number }[] = [
  { status: "completed", errorCode: null, weight: 92 },
  { status: "queue_timeout", errorCode: "queue_timeout", weight: 2.5 },
  { status: "stall_timeout", errorCode: "stall_timeout", weight: 2 },
  { status: "capability_mismatch", errorCode: "capability_mismatch", weight: 2 },
  { status: "replica_unavailable", errorCode: "replica_unavailable", weight: 1 },
  { status: "error", errorCode: "invalid_request", weight: 0.5 },
];
const STATUS_TOTAL = STATUS_MIX.reduce((acc, s) => acc + s.weight, 0);

function pickStatus(): { status: string; errorCode: string | null } {
  let roll = Math.random() * STATUS_TOTAL;
  for (const s of STATUS_MIX) {
    roll -= s.weight;
    if (roll <= 0) return { status: s.status, errorCode: s.errorCode };
  }
  return { status: "completed", errorCode: null };
}

const randBetween = (min: number, max: number) => min + Math.random() * (max - min);

/** Approximate token count the same way the router does (§ chars/4). */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export async function runBackfill(options: Partial<BackfillOptions> = {}): Promise<void> {
  const opts = { ...DEFAULT_BACKFILL_OPTIONS, ...options };
  const pool = getPool();

  const models = await listModels();
  if (models.length === 0) {
    throw new Error("No models registered. Run `npm run seed` before backfilling.");
  }

  const { rows: replicaRows } = await pool.query<{ id: string; model_id: string }>(
    `SELECT id, model_id FROM replicas`
  );
  const replicasByModel = new Map<string, string[]>();
  for (const r of replicaRows) {
    if (!replicasByModel.has(r.model_id)) replicasByModel.set(r.model_id, []);
    replicasByModel.get(r.model_id)!.push(r.id);
  }

  // Cost + logging config are resolved once per model rather than per request:
  // both are scope-level settings, and per-request lookups would turn a
  // backfill into thousands of redundant round-trips.
  const costByModel = new Map<string, { costValue: number; costBasis: string }>();
  for (const m of models) {
    const cfg = (await getCostConfigForModel(m.id)) ?? { costValue: m.costValue, costBasis: m.costBasis };
    costByModel.set(m.id, cfg as { costValue: number; costBasis: string });
  }
  const loggingByScope = new Map<string, boolean>();
  for (const persona of PERSONAS) {
    for (const m of models) {
      loggingByScope.set(
        `${persona.team}|${m.id}`,
        await isContentLoggingEnabled({ team: persona.team, modelId: m.id })
      );
    }
  }

  if (opts.reset) {
    // audit_content cascades from requests.
    const { rowCount } = await pool.query(`DELETE FROM requests WHERE caller_oid = ANY($1)`, [
      PERSONAS.map((p) => p.oid),
    ]);
    console.log(`[backfill] cleared ${rowCount ?? 0} previously simulated request(s)`);
  }

  const now = Date.now();
  const requestRows: unknown[][] = [];
  const contentRows: unknown[][] = [];

  for (let dayOffset = opts.days - 1; dayOffset >= 0; dayOffset--) {
    for (let hour = 0; hour < 24; hour++) {
      const dayStart = new Date(now - dayOffset * 86_400_000);
      dayStart.setHours(hour, 0, 0, 0);

      // Skip hours that fall in the future on the current day.
      if (dayStart.getTime() > now) continue;

      const isWeekend = dayStart.getDay() === 0 || dayStart.getDay() === 6;
      const weekendFactor = isWeekend ? 0.25 : 1;
      const expected = (opts.requestsPerDay / 24) * HOURLY_WEIGHTS[hour] * weekendFactor * randBetween(0.75, 1.25);
      const count = Math.round(expected);

      for (let i = 0; i < count; i++) {
        const persona = pickPersona();
        const behaviour = pickBehaviour(persona);
        const spec = buildRequest(persona, behaviour);

        const model = models.find((m) => m.id === spec.expectedModel) ?? models[0];
        const { status, errorCode } = pickStatus();

        const arrivedAt = new Date(dayStart.getTime() + Math.random() * 3_600_000);
        if (arrivedAt.getTime() > now) continue;

        const promptText =
          behaviour === "embedding"
            ? pick(EMBEDDING_INPUTS)
            : behaviour === "analytical"
              ? pick(ANALYTICAL_PROMPTS)
              : behaviour === "vision"
                ? pick(VISION_PROMPTS)
                : pick(QUICK_PROMPTS);

        const inputTokens = estimateTokens(promptText);
        const id = randomUUID();
        const replicas = replicasByModel.get(model.id) ?? [];
        const replicaId = replicas.length ? replicas[Math.floor(Math.random() * replicas.length)] : null;

        // Failure modes have distinct timing signatures, and the dashboard's
        // latency figures are only trustworthy if they reflect that.
        if (status === "queue_timeout") {
          // Waited the full queue window, never got a replica: no tokens, no cost.
          const queueMs = 300_000;
          requestRows.push([
            id, persona.oid, persona.name, persona.team, spec.body.model ?? null, model.id,
            model.capabilities, status, errorCode, null, inputTokens, 0,
            arrivedAt, null, new Date(arrivedAt.getTime() + queueMs), null, queueMs, 0,
          ]);
          continue;
        }

        const waitMs = randBetween(5, 900);
        const startedAt = new Date(arrivedAt.getTime() + waitMs);

        if (status === "capability_mismatch" || status === "error") {
          // Rejected before any replica was engaged.
          requestRows.push([
            id, persona.oid, persona.name, persona.team, spec.body.model ?? null, model.id,
            model.capabilities, status, errorCode, null, inputTokens, 0,
            arrivedAt, null, startedAt, null, Math.round(waitMs), 0,
          ]);
          continue;
        }

        const tps = model.modelClass === "large" ? randBetween(13, 19) : randBetween(35, 55);
        const targetOutput = model.modelClass === "large" ? randBetween(180, 700) : randBetween(40, 260);

        // A stall produces partial output and dies one inactivity window later.
        const outputTokens = status === "stall_timeout" ? Math.round(targetOutput * randBetween(0.1, 0.5))
          : status === "replica_unavailable" ? 0
          : Math.round(targetOutput);

        const genMs = (outputTokens / tps) * 1000;
        const durationMs = Math.round(
          waitMs + genMs + (status === "stall_timeout" ? 60_000 : 0)
        );
        const completedAt = new Date(arrivedAt.getTime() + durationMs);
        if (completedAt.getTime() > now) continue;

        const lastTokenAt = outputTokens > 0 ? new Date(startedAt.getTime() + genMs) : null;
        const cfg = costByModel.get(model.id)!;
        const costUsd = computeCost({
          costBasis: cfg.costBasis as never,
          costValue: Number(cfg.costValue),
          inputTokens,
          outputTokens,
          durationMs: Math.round(genMs),
        });

        requestRows.push([
          id, persona.oid, persona.name, persona.team, spec.body.model ?? null, model.id,
          model.capabilities, status, errorCode, replicaId, inputTokens, outputTokens,
          arrivedAt, startedAt, completedAt, lastTokenAt, durationMs, costUsd,
        ]);

        // Content is captured only where the scope allows it, exactly as the
        // router decides at request time (§6.8).
        if (status === "completed" && loggingByScope.get(`${persona.team}|${model.id}`)) {
          contentRows.push([
            id,
            promptText,
            `Hello world from ${model.id}. This is synthetic output produced by the mock model replica for routing and audit verification.`,
            completedAt,
          ]);
        }
      }
    }
  }

  console.log(`[backfill] inserting ${requestRows.length} requests, ${contentRows.length} audit content rows…`);
  await insertBatched(
    `INSERT INTO requests (id, caller_oid, caller_name, team, requested_model, routed_model, capabilities,
       status, error_code, replica_id, input_tokens, output_tokens, arrived_at, started_at, completed_at,
       last_token_at, duration_ms, cost_usd)`,
    18,
    requestRows
  );
  await insertBatched(`INSERT INTO audit_content (request_id, prompt, response, created_at)`, 4, contentRows);

  console.log(`[backfill] done — ${opts.days} day(s) of history across ${PERSONAS.length} callers`);
}

/**
 * Multi-row inserts in chunks. Postgres caps a statement at 65535 bound
 * parameters, so the chunk size is derived from the column count rather than
 * fixed.
 */
async function insertBatched(prefix: string, columns: number, rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const pool = getPool();
  const perChunk = Math.floor(65_000 / columns);

  for (let offset = 0; offset < rows.length; offset += perChunk) {
    const chunk = rows.slice(offset, offset + perChunk);
    const values: unknown[] = [];
    const tuples = chunk.map((row, r) => {
      const placeholders = row.map((_, c) => `$${r * columns + c + 1}`);
      values.push(...row);
      return `(${placeholders.join(",")})`;
    });
    await pool.query(`${prefix} VALUES ${tuples.join(",")} ON CONFLICT DO NOTHING`, values);
  }
}
