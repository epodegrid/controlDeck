import { describe, it, expect } from "vitest";
import { mergeSystemIntoFirstUser } from "../src/adapters/llama-swap.js";

/**
 * Not every chat template has a system role. Gemma's does not — it knows only
 * user and model turns — so a system message is dropped and the model ignores
 * its instructions while every layer above reports success: the gateway
 * forwards the message, llama.cpp accepts the request, and the prompt never
 * reaches the weights.
 *
 * Confirmed with a recording proxy that opencode sends ~9.5k characters of
 * system prompt and the gateway forwards it intact, which is what narrowed the
 * loss to the template.
 */
describe("merging a system prompt into the first user turn", () => {
  it("folds the system message into the first user message", () => {
    const out = mergeSystemIntoFirstUser([
      { role: "system", content: "You are opencode." },
      { role: "user", content: "Who are you?" },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toBe("You are opencode.\n\nWho are you?");
  });

  it("keeps the rest of the conversation in order", () => {
    const out = mergeSystemIntoFirstUser([
      { role: "system", content: "S" },
      { role: "user", content: "one" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "two" },
    ]);

    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // Only the first user turn carries the preamble; a later one is untouched.
    expect(out[0].content).toBe("S\n\none");
    expect(out[2].content).toBe("two");
  });

  it("joins several system messages, and treats developer as one", () => {
    const out = mergeSystemIntoFirstUser([
      { role: "system", content: "first" },
      { role: "developer", content: "second" },
      { role: "user", content: "hi" },
    ]);
    expect(out[0].content).toBe("first\n\nsecond\n\nhi");
  });

  it("invents a user turn rather than dropping the instructions", () => {
    // A tools-only exchange has no user message to merge into. Losing the
    // system prompt is the failure this whole mode exists to prevent.
    const out = mergeSystemIntoFirstUser([
      { role: "system", content: "S" },
      { role: "assistant", content: null },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "S" });
    expect(out).toHaveLength(2);
  });

  it("leaves a conversation with no system message alone", () => {
    const input = [{ role: "user", content: "hi" }];
    expect(mergeSystemIntoFirstUser(input)).toEqual(input);
  });
});
