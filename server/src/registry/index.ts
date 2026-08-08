import { getPool } from "../db/pool.js";
import { mergeModelConfig, type ModelRegistryRow, type OverrideFields } from "./merge.js";
import type { ModelConfig } from "../types.js";

export { mergeModelConfig } from "./merge.js";
export type { OverrideFields } from "./merge.js";

async function fetchOverride(modelId: string): Promise<OverrideFields | null> {
  const pool = getPool();
  const res = await pool.query<{ fields: OverrideFields }>(
    `SELECT fields FROM model_registry_overrides WHERE model_id = $1`,
    [modelId]
  );
  return res.rows[0]?.fields ?? null;
}

export async function listModels(): Promise<ModelConfig[]> {
  const pool = getPool();
  const [bases, overrides] = await Promise.all([
    pool.query<ModelRegistryRow>(`SELECT * FROM model_registry ORDER BY id`),
    pool.query<{ model_id: string; fields: OverrideFields }>(`SELECT model_id, fields FROM model_registry_overrides`),
  ]);
  const overrideMap = new Map(overrides.rows.map((r) => [r.model_id, r.fields]));
  return bases.rows.map((row) => mergeModelConfig(row, overrideMap.get(row.id) ?? null));
}

export async function getModel(modelId: string): Promise<ModelConfig | null> {
  const pool = getPool();
  const res = await pool.query<ModelRegistryRow>(`SELECT * FROM model_registry WHERE id = $1`, [modelId]);
  if (res.rows.length === 0) return null;
  const override = await fetchOverride(modelId);
  return mergeModelConfig(res.rows[0], override);
}

export async function setModelOverride(
  modelId: string,
  fields: OverrideFields,
  updatedBy: string
): Promise<ModelConfig | null> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO model_registry_overrides (model_id, fields, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (model_id) DO UPDATE SET fields = model_registry_overrides.fields || $2, updated_by = $3, updated_at = now()`,
    [modelId, JSON.stringify(fields), updatedBy]
  );
  return getModel(modelId);
}

/**
 * Replicas serving a registry entry.
 *
 * Resolves through `backend_model_id` first: an entry that is an alias over
 * another model's container has no replicas of its own, and showing it as
 * having none would misrepresent a model that is in fact running and serving
 * traffic. Aliases of the same workload therefore show the same pods, which is
 * the truth — they are the same pods.
 */
export async function listReplicasForModel(modelId: string) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT r.id, r.model_id AS "modelId", r.status, r.in_flight AS "inFlight",
       r.load_pct::float8 AS "loadPct", r.tokens_per_sec::float8 AS "tokensPerSec"
     FROM replicas r
     WHERE r.model_id = COALESCE(
       (SELECT COALESCE(backend_model_id, id) FROM model_registry WHERE id = $1),
       $1
     )
     ORDER BY r.id`,
    [modelId]
  );
  return res.rows;
}
