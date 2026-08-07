import { getPool } from "../db/pool.js";

export type CostBreakdownGroupBy = "model" | "caller";

export type CostBreakdownEntry = {
  key: string;
  tokens: number;
  requests: number;
  cost: number;
};

export type GetCostBreakdownInput = {
  since: Date;
  until: Date;
  groupBy: CostBreakdownGroupBy;
};

/**
 * Aggregates cost, token counts, and request counts over completed requests in a
 * time window, grouped by model or caller. Dashboard "tokens/sec and cost breakdown
 * by caller and time period" per PRD §6.7.
 */
export async function getCostBreakdown({
  since,
  until,
  groupBy,
}: GetCostBreakdownInput): Promise<CostBreakdownEntry[]> {
  const pool = getPool();
  const groupColumn = groupBy === "model" ? "routed_model" : "caller_oid";

  const { rows } = await pool.query(
    `SELECT
       ${groupColumn} AS key,
       COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
       COUNT(*) AS requests,
       COALESCE(SUM(cost_usd), 0) AS cost
     FROM requests
     WHERE status = 'completed'
       AND arrived_at >= $1
       AND arrived_at <= $2
       AND ${groupColumn} IS NOT NULL
     GROUP BY ${groupColumn}
     ORDER BY cost DESC`,
    [since, until]
  );

  return rows.map((row) => ({
    key: row.key as string,
    tokens: Number(row.tokens),
    requests: Number(row.requests),
    cost: Number(row.cost),
  }));
}
