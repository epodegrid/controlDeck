import type { ModelConfig } from "../types.js";

export type ModelRegistryRow = {
  id: string;
  name: string;
  class_label: string;
  model_class: ModelConfig["modelClass"];
  capabilities: ModelConfig["capabilities"];
  min_replicas: number;
  max_replicas: number;
  system_prompt: string;
  cost_value: string | number;
  cost_basis: ModelConfig["costBasis"];
  endpoint_url: string;
  upstream_model: string | null;
  system_prompt_mode: "passthrough" | "merge" | null;
  backend_model_id: string | null;
  port: number | null;
  first_token_timeout_ms: number | null;
};

export type OverrideFields = Partial<{
  name: string;
  classLabel: string;
  minReplicas: number;
  maxReplicas: number;
  systemPrompt: string;
  costValue: number;
  costBasis: ModelConfig["costBasis"];
}>;

/**
 * Dashboard overrides are merged on top of the GitOps/Helm base row at read
 * time — the base row itself is never mutated by a dashboard edit (PRD §6.2).
 */
export function mergeModelConfig(base: ModelRegistryRow, override: OverrideFields | null): ModelConfig {
  const hasOverride = !!override && Object.keys(override).length > 0;
  return {
    id: base.id,
    name: override?.name ?? base.name,
    classLabel: override?.classLabel ?? base.class_label,
    modelClass: base.model_class,
    capabilities: base.capabilities,
    minReplicas: override?.minReplicas ?? base.min_replicas,
    maxReplicas: override?.maxReplicas ?? base.max_replicas,
    systemPrompt: override?.systemPrompt ?? base.system_prompt,
    costValue: override?.costValue ?? Number(base.cost_value),
    costBasis: override?.costBasis ?? base.cost_basis,
    endpointUrl: base.endpoint_url,
    // The backend's own name for the model; the platform id is only the
    // default, since a container may answer to something else entirely.
    upstreamModel: base.upstream_model || base.id,
    systemPromptMode: base.system_prompt_mode ?? "passthrough",
    // A model is its own backend unless it explicitly points at another's.
    backendModelId: base.backend_model_id || base.id,
    port: base.port ?? 8080,
    firstTokenTimeoutMs: base.first_token_timeout_ms ?? null,
    configSource: hasOverride ? "override" : "gitops",
    hasOverride,
  };
}
