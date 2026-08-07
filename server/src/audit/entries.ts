import { getPool } from "../db/pool.js";

export type GetAuditEntriesInput = {
  caller?: string;
  model?: string;
  team?: string;
  status?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
};

export type AuditEntry = {
  id: string;
  callerOid: string;
  callerName: string;
  team: string | null;
  requestedModel: string | null;
  routedModel: string | null;
  status: string;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  arrivedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  costUsd: number | null;
  logged: boolean;
};

const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;

/**
 * Returns request metadata rows joined with whether full content was actually
 * captured (audit_content exists) — the `logged` flag surfaced to the dashboard
 * per PRD §6.8.
 */
export async function getAuditEntries({
  caller,
  model,
  team,
  status,
  since,
  until,
  limit = DEFAULT_LIMIT,
  offset = DEFAULT_OFFSET,
}: GetAuditEntriesInput): Promise<AuditEntry[]> {
  const pool = getPool();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (caller) {
    params.push(caller);
    conditions.push(`r.caller_oid = $${params.length}`);
  }
  if (model) {
    params.push(model);
    conditions.push(`r.routed_model = $${params.length}`);
  }
  if (team) {
    params.push(team);
    conditions.push(`r.team = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`r.status = $${params.length}`);
  }
  if (since) {
    params.push(since);
    conditions.push(`r.arrived_at >= $${params.length}`);
  }
  if (until) {
    params.push(until);
    conditions.push(`r.arrived_at <= $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  params.push(limit);
  const limitParamIdx = params.length;
  params.push(offset);
  const offsetParamIdx = params.length;

  const { rows } = await pool.query(
    `SELECT
       r.id, r.caller_oid, r.caller_name, r.team, r.requested_model, r.routed_model,
       r.status, r.error_code, r.input_tokens, r.output_tokens, r.arrived_at,
       r.started_at, r.completed_at, r.duration_ms, r.cost_usd,
       EXISTS (SELECT 1 FROM audit_content ac WHERE ac.request_id = r.id) AS logged
     FROM requests r
     ${whereClause}
     ORDER BY r.arrived_at DESC
     LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
    params
  );

  return rows.map((row) => ({
    id: row.id,
    callerOid: row.caller_oid,
    callerName: row.caller_name,
    team: row.team,
    requestedModel: row.requested_model,
    routedModel: row.routed_model,
    status: row.status,
    errorCode: row.error_code,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    arrivedAt: row.arrived_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    logged: row.logged,
  }));
}
