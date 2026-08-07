import type { CostBasis } from "../types.js";

export type ComputeCostInput = {
  costBasis: CostBasis;
  costValue: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
};

/**
 * Pure function computing the dollar cost of a request under an admin-configured
 * cost basis. See PRD §6.7 — cost reflects actual infra reality, not vendor billing.
 */
export function computeCost({
  costBasis,
  costValue,
  inputTokens,
  outputTokens,
  durationMs,
}: ComputeCostInput): number {
  switch (costBasis) {
    case "per_1k_tokens":
      return ((inputTokens + outputTokens) / 1000) * costValue;
    case "per_request":
      return costValue;
    case "per_compute_second":
      return (durationMs / 1000) * costValue;
    default: {
      const _exhaustive: never = costBasis;
      throw new Error(`Unknown cost basis: ${_exhaustive}`);
    }
  }
}
