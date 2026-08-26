import { describe, it, expect } from "vitest";
import { BackendError } from "../src/adapters/llama-swap.js";

/**
 * Two things an agent needs from the gateway in order to manage its own
 * context window, both of which it previously got wrong.
 *
 * It compacts its history when `usage.prompt_tokens` approaches the limit, and
 * it recognises a hard overflow by the error code. Reporting invented token
 * counts means it never compacts in time; returning a generic error code means
 * it cannot tell "summarise and retry" from "this request is malformed".
 */
describe("context overflow detection", () => {
  it("recognises llama.cpp's overflow error", () => {
    const err = new BackendError(
      400,
      JSON.stringify({
        error: {
          code: 400,
          message: "request (40013 tokens) exceeds the available context size (32768 tokens), try increasing it",
          type: "exceed_context_size_error",
          n_prompt_tokens: 40013,
          n_ctx: 32768,
        },
      })
    );
    expect(err.isContextOverflow).toBe(true);
    expect(err.isCallerError).toBe(true);
  });

  it("recognises the prose forms other backends use", () => {
    // vLLM and friends describe it in a sentence rather than a type field.
    const vllm = new BackendError(
      400,
      JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length." } })
    );
    expect(vllm.isContextOverflow).toBe(true);

    const openai = new BackendError(400, JSON.stringify({ error: { code: "context_length_exceeded" } }));
    expect(openai.isContextOverflow).toBe(true);
  });

  it("does not mistake an ordinary bad request for an overflow", () => {
    const other = new BackendError(400, JSON.stringify({ error: { message: "no model id could be identified" } }));
    expect(other.isContextOverflow).toBe(false);
    expect(other.isCallerError).toBe(true);
  });

  it("treats a server error as retryable, not the caller's fault", () => {
    const boom = new BackendError(503, "upstream unavailable");
    expect(boom.isCallerError).toBe(false);
    expect(boom.isContextOverflow).toBe(false);
  });

  it("surfaces the backend's sentence rather than its JSON envelope", () => {
    // The message is read by people and matched by agents; burying it two
    // levels inside a wrapper helps neither.
    const err = new BackendError(
      400,
      JSON.stringify({ error: { code: 400, message: "request (40013 tokens) exceeds the available context size (32768 tokens)" } })
    );
    expect(err.message).toContain("request (40013 tokens) exceeds");
    expect(err.message).not.toContain('{"error"');
  });

  it("falls back to the raw body when it is not JSON", () => {
    expect(new BackendError(500, "plain text failure").message).toContain("plain text failure");
  });
});
