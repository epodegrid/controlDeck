/**
 * Prompt corpus for the traffic simulator.
 *
 * Prompts are written to deliberately trip (or deliberately avoid) the
 * router's complexity signals in `routing/complexity.ts`, so the traffic mix
 * is a live assertion about routing behaviour rather than random noise:
 *
 *   QUICK      — short, single question, no markers  -> fast model
 *   ANALYTICAL — reasoning markers / multi-part / long -> large model
 *
 * If someone changes a threshold in complexity.ts, the simulator's model mix
 * shifts visibly on the dashboard, which is the point.
 */

/** Short and unambiguous: no marker, one question mark, well under the length threshold. */
export const QUICK_PROMPTS = [
  "What's the default port for Postgres?",
  "Convert 15:45 UTC to CET.",
  "Give me a one-line summary of what a JWKS endpoint does.",
  "Is `git restore` the same as `git checkout --`?",
  "What does a 503 status code mean?",
  "Name the four capability flags this gateway supports.",
  "How do I list pods in a namespace with kubectl?",
  "What's the difference between RAM and VRAM for model serving?",
  "Spell out the acronym KEDA.",
  "What time zone is AEST relative to UTC?",
];

/** Each contains an explicit reasoning marker or a multi-part structure. */
export const ANALYTICAL_PROMPTS = [
  "Think through the trade-offs between event sourcing and CRUD persistence for an audit-heavy system, and explain where each one breaks down under load.",
  "Reason through why a queue-wait timeout and a stall timeout need to be separate clocks in an inference gateway. What fails if you collapse them into one?",
  "Analyze in depth how JWKS key rotation should be handled by a service with no outbound internet access.",
  "Walk me through this step by step: 1) how KEDA decides to scale, 2) how the cluster autoscaler reacts, 3) where the latency actually comes from.",
  "Prove that a least-loaded routing strategy cannot double-assign a replica if in-flight counts live in a single shared transaction.",
  "Compare three approaches to cost attribution for self-hosted models. 1) per token, 2) per request, 3) per compute-second. Which is most defensible to a finance team?",
  "Think through the failure modes of streaming SSE responses through two proxy layers. What does the client see in each case?",
  "In-depth analysis please: what are the security implications of forwarding an end user's own Entra token through a chat UI to a backend gateway?",
];

/** Paired with an image part; the text alone is intentionally unremarkable. */
export const VISION_PROMPTS = [
  "What's shown in this screenshot?",
  "Describe this architecture diagram.",
  "Read the error message in this image.",
  "Is this chart's y-axis truncated?",
  "What UI component is this?",
];

/** Short document-ish strings for the embeddings endpoint. */
export const EMBEDDING_INPUTS = [
  "Quarterly platform reliability review, Q3.",
  "Runbook: recovering a stuck llama-swap replica.",
  "Customer ticket 88213 — latency spike during batch ingest.",
  "Design doc: shared router state and HA coordination.",
  "Postmortem: audit retention job deleted more than intended.",
  "Onboarding guide for the inference gateway.",
  "Meeting notes — capacity planning for the 35B rollout.",
];

/** A tools[] array, forcing the `tools` capability filter (§6.3 step 1). */
export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "search_runbooks",
      description: "Search internal runbooks by keyword.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
];

/**
 * A 1x1 transparent PNG. Tiny on purpose — the mock backend never decodes it,
 * it only needs to be a well-formed image part so the capability filter fires.
 */
export const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export function pick<T>(items: T[], rand: () => number = Math.random): T {
  return items[Math.floor(rand() * items.length)];
}
