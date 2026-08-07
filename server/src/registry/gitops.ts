import { readFile } from "node:fs/promises";
import { getPool } from "../db/pool.js";
import type { Capability, CostBasis, ModelClass } from "../types.js";

/**
 * Loads the Helm-defined model registry (PRD §6.2, the primary registration
 * path: "a model is defined in a Helm values file / Kubernetes CRD and
 * deployed through the existing GitOps pipeline").
 *
 * This was the missing half of that requirement. The chart rendered a
 * Deployment, a Service and a ScaledObject per model, but nothing ever wrote
 * the model into `model_registry` — so a production install came up with an
 * empty registry, `/v1/models` returned nothing, and every request was
 * rejected as `capability_mismatch`. The platform was unusable on a fresh
 * deploy and the only way to get models in was the demo seed, which is
 * explicitly not production data.
 *
 * Helm owns the base config; the dashboard's edits live in
 * `model_registry_overrides` and are merged on top at read time. This writes
 * only the base, so a redeploy can never clobber an override — the guarantee
 * §6.2 asks for.
 */

export type GitOpsModel = {
  id: string;
  name?: string;
  classLabel?: string;
  modelClass: ModelClass;
  capabilities: Capability[];
  minReplicas?: number;
  maxReplicas?: number;
  systemPrompt?: string;
  costValue?: number;
  costBasis?: CostBasis;
  /** Falls back to the in-cluster Service for the model's id. */
  endpointUrl?: string;
};

export type SyncResult = { upserted: number; removed: string[] };

const CONFIG_PATH = process.env.MODELS_CONFIG_PATH ?? "/etc/controldeck/models.json";

function defaultEndpoint(id: string): string {
  const namespace = process.env.POD_NAMESPACE;
  return namespace ? `http://${id}.${namespace}.svc.cluster.local` : `http://${id}`;
}

/** Reads the mounted config, or null when none is provided. */
export async function readModelsConfig(path = CONFIG_PATH): Promise<GitOpsModel[] | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null; // not deployed with a models ConfigMap
  }

  const parsed = JSON.parse(raw) as { models?: GitOpsModel[] } | GitOpsModel[];
  const models = Array.isArray(parsed) ? parsed : (parsed.models ?? []);

  for (const model of models) {
    if (!model.id) throw new Error("every model in the config needs an id");
    if (!Array.isArray(model.capabilities) || model.capabilities.length === 0) {
      throw new Error(`model "${model.id}" declares no capabilities, so nothing could route to it`);
    }
  }
  return models;
}

/**
 * Makes `model_registry` match the config.
 *
 * Models absent from the config are removed: Helm is the source of truth for
 * which models exist, and leaving a deleted one behind would let the router
 * keep routing to a backend the deploy has taken away. Request history is
 * unaffected — `requests.routed_model` is plain text, not a foreign key, so
 * past traffic keeps naming the model that served it.
 */
export async function syncModelsFromConfig(models: GitOpsModel[]): Promise<SyncResult> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const model of models) {
      await client.query(
        `INSERT INTO model_registry
           (id, name, class_label, model_class, capabilities, min_replicas, max_replicas,
            system_prompt, cost_value, cost_basis, endpoint_url, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           class_label = EXCLUDED.class_label,
           model_class = EXCLUDED.model_class,
           capabilities = EXCLUDED.capabilities,
           min_replicas = EXCLUDED.min_replicas,
           max_replicas = EXCLUDED.max_replicas,
           system_prompt = EXCLUDED.system_prompt,
           cost_value = EXCLUDED.cost_value,
           cost_basis = EXCLUDED.cost_basis,
           endpoint_url = EXCLUDED.endpoint_url,
           updated_at = now()`,
        [
          model.id,
          model.name ?? model.id,
          model.classLabel ?? model.modelClass,
          model.modelClass,
          model.capabilities,
          model.minReplicas ?? 1,
          model.maxReplicas ?? 1,
          model.systemPrompt ?? "",
          model.costValue ?? 0,
          model.costBasis ?? "per_1k_tokens",
          model.endpointUrl ?? defaultEndpoint(model.id),
        ]
      );
    }

    const ids = models.map((m) => m.id);
    const { rows } = await client.query<{ id: string }>(
      ids.length > 0
        ? `DELETE FROM model_registry WHERE NOT (id = ANY($1)) RETURNING id`
        : `DELETE FROM model_registry RETURNING id`,
      ids.length > 0 ? [ids] : []
    );

    await client.query("COMMIT");
    return { upserted: models.length, removed: rows.map((r) => r.id) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Startup hook. Absent config is normal — local development registers models
 * through the seed instead — so this reports what it did rather than failing.
 */
export async function syncModelsFromConfigFile(path = CONFIG_PATH): Promise<SyncResult | null> {
  const models = await readModelsConfig(path);
  if (!models) return null;
  return syncModelsFromConfig(models);
}
