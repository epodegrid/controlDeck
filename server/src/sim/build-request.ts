import type { Behaviour, Persona } from "./personas.js";
import {
  ANALYTICAL_PROMPTS,
  EMBEDDING_INPUTS,
  QUICK_PROMPTS,
  TINY_PNG_DATA_URL,
  TOOL_DEFINITIONS,
  VISION_PROMPTS,
  pick,
} from "./prompts.js";

export type SimRequest = {
  endpoint: "/v1/chat/completions" | "/v1/embeddings";
  body: Record<string, unknown>;
  /** What the traffic mix expects the router to choose, for reporting. */
  expectedModel: string | null;
  /** Set when the request is designed to fail, with the code it should fail as. */
  expectedError: string | null;
  behaviour: Behaviour;
};

/**
 * Turns a persona + behaviour into a concrete API call.
 *
 * `expectedModel` / `expectedError` are the simulator's assertions about what
 * the router should do. The live runner compares them against reality and
 * reports mismatches, so a routing regression surfaces as a failing
 * expectation rather than as traffic that merely looks plausible.
 */
export function buildRequest(persona: Persona, behaviour: Behaviour, rand: () => number = Math.random): SimRequest {
  const stream = rand() < persona.streamRate;

  switch (behaviour) {
    case "quick":
      return {
        endpoint: "/v1/chat/completions",
        body: { stream, messages: [{ role: "user", content: pick(QUICK_PROMPTS, rand) }] },
        expectedModel: "kestrel-9b",
        expectedError: null,
        behaviour,
      };

    case "analytical":
      return {
        endpoint: "/v1/chat/completions",
        body: { stream, messages: [{ role: "user", content: pick(ANALYTICAL_PROMPTS, rand) }] },
        expectedModel: "ornith-35b",
        expectedError: null,
        behaviour,
      };

    case "vision":
      return {
        endpoint: "/v1/chat/completions",
        body: {
          stream,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: pick(VISION_PROMPTS, rand) },
                { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
              ],
            },
          ],
        },
        expectedModel: "lark-vision",
        expectedError: null,
        behaviour,
      };

    case "embedding":
      return {
        endpoint: "/v1/embeddings",
        body: { input: pick(EMBEDDING_INPUTS, rand) },
        expectedModel: "ember-embed",
        expectedError: null,
        behaviour,
      };

    case "tooluser":
      return {
        endpoint: "/v1/chat/completions",
        body: {
          stream,
          tools: TOOL_DEFINITIONS,
          messages: [{ role: "user", content: pick(QUICK_PROMPTS, rand) }],
        },
        // Both chat models carry `tools`; a short prompt keeps it on the fast one.
        expectedModel: "kestrel-9b",
        expectedError: null,
        behaviour,
      };

    case "explicit": {
      const target = pick(["ornith-35b", "kestrel-9b"], rand);
      return {
        endpoint: "/v1/chat/completions",
        body: { stream, model: target, messages: [{ role: "user", content: pick(QUICK_PROMPTS, rand) }] },
        expectedModel: target,
        expectedError: null,
        behaviour,
      };
    }
  }
}

/**
 * Requests engineered to fail, so the error paths in the dashboard are never
 * empty. PRD §6.6 requires these to come back as standardized error codes
 * rather than as a dropped connection or a best-effort answer.
 */
export function buildFailingRequest(rand: () => number = Math.random): SimRequest {
  const kind = pick(["vision_mismatch", "embeddings_mismatch", "unknown_model"], rand);

  if (kind === "vision_mismatch") {
    // Explicit override to a model with no vision capability + an image.
    return {
      endpoint: "/v1/chat/completions",
      body: {
        model: "kestrel-9b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: pick(VISION_PROMPTS, rand) },
              { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
            ],
          },
        ],
      },
      expectedModel: null,
      expectedError: "capability_mismatch",
      behaviour: "vision",
    };
  }

  if (kind === "embeddings_mismatch") {
    // A chat model asked to serve /v1/embeddings.
    return {
      endpoint: "/v1/embeddings",
      body: { model: "kestrel-9b", input: pick(EMBEDDING_INPUTS, rand) },
      expectedModel: null,
      expectedError: "capability_mismatch",
      behaviour: "embedding",
    };
  }

  return {
    endpoint: "/v1/chat/completions",
    body: { model: "does-not-exist-7b", messages: [{ role: "user", content: pick(QUICK_PROMPTS, rand) }] },
    expectedModel: null,
    expectedError: "capability_mismatch",
    behaviour: "explicit",
  };
}
