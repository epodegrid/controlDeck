import type { ChatCompletionRequest, ModelConfig, StandardError } from "../types.js";
import { type Endpoint, filterByCapabilities, hasAllCapabilities, requiredCapabilities } from "./capabilities.js";
import { computeComplexitySignals, isComplex } from "./complexity.js";

export type SelectModelInput = {
  request: ChatCompletionRequest;
  candidates: ModelConfig[];
  endpoint: Endpoint;
};

export type SelectModelResult =
  | { ok: true; modelId: string; reason: string }
  | { ok: false; error: StandardError };

const NO_MODEL_SENTINELS = new Set([undefined, "", "auto"]);

/**
 * Pure, side-effect-free model selection per PRD §6.3.
 *
 * Precedence:
 *   1. Explicit override — request.model names a real model id. If it lacks
 *      a capability the request needs, hard-reject (capability_mismatch).
 *      Never silently substitute another model or strip the requirement.
 *   2. Auto-routing — no model named, or "auto":
 *        Step 1: hard filter candidates down to those with every required
 *                capability. Zero survivors -> capability_mismatch.
 *        Step 2: rule-based complexity selection among survivors.
 */
export function selectModel(input: SelectModelInput): SelectModelResult {
  const { request, candidates, endpoint } = input;
  const required = requiredCapabilities(request, endpoint);

  if (!NO_MODEL_SENTINELS.has(request.model)) {
    return selectExplicit(request.model as string, candidates, required);
  }

  return selectAuto(request, candidates, required);
}

function selectExplicit(
  modelId: string,
  candidates: ModelConfig[],
  required: import("../types.js").Capability[]
): SelectModelResult {
  const named = candidates.find((model) => model.id === modelId);

  if (!named) {
    return {
      ok: false,
      error: capabilityMismatchError(
        `Requested model "${modelId}" is not a known/eligible model.`
      ),
    };
  }

  if (!hasAllCapabilities(named, required)) {
    const missing = required.filter((cap) => !named.capabilities.includes(cap));
    return {
      ok: false,
      error: capabilityMismatchError(
        `Requested model "${modelId}" does not support required capability: ${missing.join(", ")}.`
      ),
    };
  }

  return { ok: true, modelId: named.id, reason: "explicit_override" };
}

function selectAuto(
  request: ChatCompletionRequest,
  candidates: ModelConfig[],
  required: import("../types.js").Capability[]
): SelectModelResult {
  const eligible = filterByCapabilities(candidates, required);

  if (eligible.length === 0) {
    return {
      ok: false,
      error: capabilityMismatchError(
        `No available model supports required capabilities: ${required.join(", ")}.`
      ),
    };
  }

  const signals = computeComplexitySignals(request);
  const complex = isComplex(signals);

  const chosen = pickByClass(eligible, complex);
  const reason = chosen.modelClass === "large" ? "complexity:large" : "complexity:fast";

  return { ok: true, modelId: chosen.id, reason };
}

/**
 * Among capability-eligible candidates, prefer the large model when the
 * complexity signals warrant it, otherwise prefer the fast model. Falls
 * back to the first eligible candidate when the preferred class isn't
 * present (e.g. only a vision or embedding model qualifies).
 */
function pickByClass(eligible: ModelConfig[], complex: boolean): ModelConfig {
  const preferredClass = complex ? "large" : "fast";
  const preferred = eligible.find((model) => model.modelClass === preferredClass);
  if (preferred) return preferred;

  // Fallback: if we wanted "large" but none exists, prefer "fast" if present;
  // if we wanted "fast" but none exists, just take the first eligible model.
  if (complex) {
    const fastFallback = eligible.find((model) => model.modelClass === "fast");
    if (fastFallback) return fastFallback;
  }

  return eligible[0];
}

function capabilityMismatchError(message: string): StandardError {
  return {
    error: {
      type: "invalid_request_error",
      code: "capability_mismatch",
      message,
    },
  };
}
