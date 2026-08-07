import { getPool } from "../db/pool.js";

export type DeleteAuditHistoryResult = {
  deletedRequests: number;
};

/**
 * Manual "delete last X days" dashboard action (PRD §6.8). Deletes requests
 * older than the given number of days; audit_content cascades via FK.
 * No confirmation gating here — that's an SSO/UI concern per the PRD.
 */
export async function deleteAuditHistory(olderThanDays: number): Promise<DeleteAuditHistoryResult> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM requests WHERE arrived_at < now() - ($1 || ' days')::interval`,
    [olderThanDays]
  );
  return { deletedRequests: rowCount ?? 0 };
}
