import { getPool, closePool } from "./pool.js";
import { runMigrations } from "./migrate.js";
import { config } from "../config.js";

/**
 * Where each model's backend actually lives. Defaults target the mock-model
 * containers published by docker-compose, so a locally-run router works with
 * no configuration. In-cluster, point these at the llama-swap services —
 * e.g. MODEL_ENDPOINT_ORNITH_35B=http://ornith-35b.llama-swap.svc.cluster.local
 */
function endpointFor(modelId: string, defaultPort: number): string {
  const envKey = `MODEL_ENDPOINT_${modelId.toUpperCase().replace(/-/g, "_")}`;
  return process.env[envKey] ?? `http://localhost:${defaultPort}`;
}

const models = [
  {
    id: "ornith-35b",
    name: "Ornith-1.0 35B",
    class_label: "Large / complex",
    model_class: "large",
    capabilities: ["chat", "tools"],
    min_replicas: 1,
    max_replicas: 6,
    system_prompt:
      "You are a careful, methodical assistant. When answering technical questions, prefer concrete examples and cite trade-offs explicitly.",
    cost_value: 0.0042,
    cost_basis: "per_1k_tokens",
    endpoint_url: endpointFor("ornith-35b", 5001),
  },
  {
    id: "kestrel-9b",
    name: "Kestrel-9B",
    class_label: "Fast / general",
    model_class: "fast",
    capabilities: ["chat", "tools"],
    min_replicas: 2,
    max_replicas: 8,
    system_prompt: "You are a concise assistant. Prefer short, direct answers.",
    cost_value: 0.0011,
    cost_basis: "per_1k_tokens",
    endpoint_url: endpointFor("kestrel-9b", 5002),
  },
  {
    id: "lark-vision",
    name: "Lark-Vision 2B",
    class_label: "Vision",
    model_class: "vision",
    capabilities: ["chat", "vision"],
    min_replicas: 1,
    max_replicas: 4,
    system_prompt: "You can see attached images. Describe what you observe before answering.",
    cost_value: 0.0019,
    cost_basis: "per_1k_tokens",
    endpoint_url: endpointFor("lark-vision", 5003),
  },
  {
    id: "ember-embed",
    name: "Ember-Embed",
    class_label: "Embedding",
    model_class: "embedding",
    capabilities: ["embeddings"],
    min_replicas: 1,
    max_replicas: 3,
    system_prompt: "",
    cost_value: 0.0003,
    cost_basis: "per_compute_second",
    endpoint_url: endpointFor("ember-embed", 5004),
  },
];

// Replicas are deliberately NOT seeded. They are discovered and health-checked
// by the reconciler (src/replicas/reconcile.ts): a replica row exists because
// a backend answered its readiness probe, never because a fixture claimed it
// did. Seeding them produced a permanently "loading" replica that never
// finished and a "busy" one serving nothing.

/**
 * Installs the fictional demo registry (four models plus their audit scopes).
 * Replicas are not part of it — the reconciler discovers those. This is sim-mode data, not production data: a real deployment
 * registers its models through Helm/GitOps per PRD §6.2 and must start empty.
 *
 * Guarded rather than merely documented, because the failure mode is silent
 * and bad — an operator who runs `npm run seed` against production would find
 * four models they don't own in their registry, and requests routing to
 * endpoints that don't exist.
 */
export async function seed(options: { force?: boolean } = {}) {
  if (!config.simMode && !options.force) {
    throw new Error(
      "Refusing to seed: this installs fictional demo models and only belongs in sim mode.\n" +
        "Set SIM_MODE=true for a local/demo environment, or pass --force if you are certain.\n" +
        "In production, register models through the Helm values file (PRD §6.2)."
    );
  }

  await runMigrations();
  const pool = getPool();

  for (const m of models) {
    await pool.query(
      `INSERT INTO model_registry (id, name, class_label, model_class, capabilities, min_replicas, max_replicas, system_prompt, cost_value, cost_basis, endpoint_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, class_label = EXCLUDED.class_label, model_class = EXCLUDED.model_class,
         capabilities = EXCLUDED.capabilities, min_replicas = EXCLUDED.min_replicas, max_replicas = EXCLUDED.max_replicas,
         system_prompt = EXCLUDED.system_prompt, cost_value = EXCLUDED.cost_value, cost_basis = EXCLUDED.cost_basis,
         endpoint_url = EXCLUDED.endpoint_url`,
      [m.id, m.name, m.class_label, m.model_class, m.capabilities, m.min_replicas, m.max_replicas, m.system_prompt, m.cost_value, m.cost_basis, m.endpoint_url]
    );
    await pool.query(
      `INSERT INTO model_cost_config (model_id, cost_value, cost_basis, updated_by)
       VALUES ($1,$2,$3,'seed')
       ON CONFLICT (model_id) DO UPDATE SET cost_value = EXCLUDED.cost_value, cost_basis = EXCLUDED.cost_basis`,
      [m.id, m.cost_value, m.cost_basis]
    );
  }

  await pool.query(
    `INSERT INTO model_registry_overrides (model_id, fields, updated_by)
     VALUES ('kestrel-9b', '{"systemPrompt": "You are a concise assistant. Prefer short, direct answers. Always answer in bullet points when possible."}', 'dashboard-admin')
     ON CONFLICT (model_id) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO model_registry_overrides (model_id, fields, updated_by)
     VALUES ('ember-embed', '{"maxReplicas": 5}', 'dashboard-admin')
     ON CONFLICT (model_id) DO NOTHING`
  );

  await pool.query(
    // Content logging is enabled if ANY applicable scope is on (§6.8), so a
    // global 'true' would swallow every per-team and per-model toggle below
    // and make the Audit page's "what's being logged right now" panel a
    // constant. Global stays off so the granular scopes are observable — a
    // request is logged when its team OR its model is enabled, which means
    // e.g. 'search' traffic is logged on the chat models but not on
    // ember-embed. Making that interaction legible is the Audit page's job.
    `INSERT INTO audit_logging_config (scope_type, scope_key, enabled) VALUES
       ('global', '', false),
       ('team', 'engineering', true), ('team', 'search', true), ('team', 'platform', true),
       ('team', 'ml-ops', true), ('team', 'design', false), ('team', 'support', true), ('team', 'infra', true), ('team', 'external', false),
       ('model', 'ornith-35b', true), ('model', 'kestrel-9b', true), ('model', 'lark-vision', true), ('model', 'ember-embed', false)
     ON CONFLICT (scope_type, scope_key) DO UPDATE SET enabled = EXCLUDED.enabled`
  );

  console.log("seed complete");
}

// Only self-execute when run as a script (`npm run seed`), so the test
// harness can import and call seed() without the process exiting underneath
// it. Mirrors the pattern in migrate.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  seed({ force: process.argv.includes("--force") })
    .then(() => closePool())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
