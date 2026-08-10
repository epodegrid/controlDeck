import { describe, it, expect } from "vitest";
import { mergeModelConfig, type ModelRegistryRow } from "../src/registry/merge.js";

const base: ModelRegistryRow = {
  id: "kestrel-9b",
  name: "Kestrel-9B",
  class_label: "Fast / general",
  model_class: "fast",
  capabilities: ["chat", "tools"],
  min_replicas: 2,
  max_replicas: 8,
  system_prompt: "Base prompt",
  cost_value: "0.0011",
  cost_basis: "per_1k_tokens",
  endpoint_url: "http://kestrel-9b.internal",
  upstream_model: null,
  system_prompt_mode: null,
  backend_model_id: null,
  port: 8080,
  first_token_timeout_ms: null,
};

describe("mergeModelConfig", () => {
  it("uses base config when no override exists", () => {
    const merged = mergeModelConfig(base, null);
    expect(merged.configSource).toBe("gitops");
    expect(merged.hasOverride).toBe(false);
    expect(merged.systemPrompt).toBe("Base prompt");
    expect(merged.costValue).toBe(0.0011);
  });

  it("uses base config when override has no fields", () => {
    const merged = mergeModelConfig(base, {});
    expect(merged.configSource).toBe("gitops");
    expect(merged.hasOverride).toBe(false);
  });

  it("overlays dashboard override fields without mutating unset base fields", () => {
    const merged = mergeModelConfig(base, { systemPrompt: "Overridden prompt", maxReplicas: 10 });
    expect(merged.configSource).toBe("override");
    expect(merged.hasOverride).toBe(true);
    expect(merged.systemPrompt).toBe("Overridden prompt");
    expect(merged.maxReplicas).toBe(10);
    // untouched fields still come from base
    expect(merged.minReplicas).toBe(2);
    expect(merged.costValue).toBe(0.0011);
    expect(merged.name).toBe("Kestrel-9B");
  });

  it("preserves capabilities and modelClass from base always (not overridable)", () => {
    const merged = mergeModelConfig(base, { name: "Kestrel Renamed" });
    expect(merged.capabilities).toEqual(["chat", "tools"]);
    expect(merged.modelClass).toBe("fast");
  });
});
