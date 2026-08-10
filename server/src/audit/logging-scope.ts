import { getPool } from "../db/pool.js";

export type ScopeType = "global" | "team" | "model" | "key";

export type IsContentLoggingEnabledInput = {
  team?: string;
  modelId?: string;
  apiKey?: string;
};

/**
 * Full prompt/response content logging is opt-in and toggleable at multiple
 * granularities simultaneously (PRD §6.8). Logging is enabled for a request if
 * ANY applicable scope (global / team / model / key) is enabled.
 */
export async function isContentLoggingEnabled({
  team,
  modelId,
  apiKey,
}: IsContentLoggingEnabledInput): Promise<boolean> {
  const pool = getPool();

  const conditions: string[] = [`(scope_type = 'global' AND scope_key = '')`];
  const params: string[] = [];

  if (team) {
    params.push(team);
    conditions.push(`(scope_type = 'team' AND scope_key = $${params.length})`);
  }
  if (modelId) {
    params.push(modelId);
    conditions.push(`(scope_type = 'model' AND scope_key = $${params.length})`);
  }
  if (apiKey) {
    params.push(apiKey);
    conditions.push(`(scope_type = 'key' AND scope_key = $${params.length})`);
  }

  const { rows } = await pool.query(
    `SELECT 1 FROM audit_logging_config WHERE enabled = true AND (${conditions.join(" OR ")}) LIMIT 1`,
    params
  );

  return rows.length > 0;
}

/**
 * Upserts a logging toggle for a given scope.
 *
 * The global scope is keyed by the empty string, and that is enforced here
 * rather than trusted from the caller. There is exactly one global row by
 * definition, but "global" is a natural-looking key and two pages of the
 * dashboard disagreed about it: one wrote ("global", ""), the other
 * ("global", "global"). Only the first is what isContentLoggingEnabled reads,
 * so the second was a switch that moved, persisted, and did nothing — and the
 * two pages then showed different answers for the same setting.
 */
export async function setLoggingScope(
  scopeType: ScopeType,
  scopeKey: string,
  enabled: boolean
): Promise<void> {
  const key = scopeType === "global" ? "" : scopeKey;
  const pool = getPool();
  await pool.query(
    `INSERT INTO audit_logging_config (scope_type, scope_key, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (scope_type, scope_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [scopeType, key, enabled]
  );
}
