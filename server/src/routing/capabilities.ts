import type { Capability, ChatCompletionRequest, ChatMessage, ModelConfig } from "../types.js";

export type Endpoint = "chat" | "embeddings";

/**
 * Determine which capabilities a request needs, based purely on the shape of
 * the request and the endpoint it hit. Never inspects `request.model` here —
 * capability requirements are a property of the request content, not of
 * which model the caller asked for.
 */
export function requiredCapabilities(request: ChatCompletionRequest, endpoint: Endpoint): Capability[] {
  if (endpoint === "embeddings") {
    return ["embeddings"];
  }

  const required = new Set<Capability>(["chat"]);

  if (requestHasImage(request.messages)) {
    required.add("vision");
  }

  if (Array.isArray(request.tools) && request.tools.length > 0) {
    required.add("tools");
  }

  return Array.from(required);
}

function requestHasImage(messages: ChatMessage[]): boolean {
  return messages.some((message) => {
    if (typeof message.content === "string") return false;
    return message.content.some((part) => isImagePart(part));
  });
}

function isImagePart(part: { type: string; [key: string]: unknown }): boolean {
  // Cover common shapes: OpenAI-style `image_url`, and any part whose
  // `type` field explicitly says "image".
  return part.type === "image_url" || part.type === "image" || part.type.startsWith("image_");
}

export function hasAllCapabilities(model: ModelConfig, required: Capability[]): boolean {
  return required.every((cap) => model.capabilities.includes(cap));
}

export function filterByCapabilities(candidates: ModelConfig[], required: Capability[]): ModelConfig[] {
  return candidates.filter((model) => hasAllCapabilities(model, required));
}
