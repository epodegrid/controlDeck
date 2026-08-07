import { getPool } from "../db/pool.js";

/**
 * Records full prompt/response content for a request. Upsert is no-op-safe:
 * calling it repeatedly for the same request id just overwrites the content.
 */
export async function recordAuditContent(
  requestId: string,
  prompt: string,
  response: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO audit_content (request_id, prompt, response, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (request_id) DO UPDATE SET
       prompt = EXCLUDED.prompt,
       response = EXCLUDED.response,
       created_at = now()`,
    [requestId, prompt, response]
  );
}
