import { getPool } from "../db/pool.js";
import type { CostBasis } from "../types.js";

export type CostConfig = {
  costValue: number;
  costBasis: CostBasis;
};

/**
 * Reads the admin-configured cost basis/value for a model. Returns null if the
 * model has no cost config set (PRD §6.7 — admins discretionarily set this per model).
 */
export async function getCostConfigForModel(modelId: string): Promise<CostConfig | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT cost_value, cost_basis FROM model_cost_config WHERE model_id = $1`,
    [modelId]
  );
  if (rows.length === 0) {
    return null;
  }
  return {
    costValue: Number(rows[0].cost_value),
    costBasis: rows[0].cost_basis as CostBasis,
  };
}

/**
 * Upserts the cost config for a model.
 */
export async function setCostConfigForModel(
  modelId: string,
  costValue: number,
  costBasis: CostBasis,
  updatedBy: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO model_cost_config (model_id, cost_value, cost_basis, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (model_id) DO UPDATE SET
       cost_value = EXCLUDED.cost_value,
       cost_basis = EXCLUDED.cost_basis,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [modelId, costValue, costBasis, updatedBy]
  );
}
