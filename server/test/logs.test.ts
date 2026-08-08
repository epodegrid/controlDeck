import { describe, it, expect } from "vitest";
import { parseLine } from "../src/logs/sources.js";
import { createRedactor, REDACTED } from "../src/logs/redact.js";

/**
 * Parsing and redaction against real ik_llama.cpp output.
 *
 * The sample below is genuine operator-supplied log output, including the case
 * that matters most: these servers print the prompt itself at higher
 * verbosity. The log panel streams container stdout and has none of the Audit
 * view's per-scope controls, so content reaching it would defeat §6.8 — an
 * admin who turned content logging off for a team would read their prompts
 * here anyway.
 */
describe("model server log parsing", () => {
  it("reads the level llama.cpp declares rather than guessing", () => {
    expect(parseLine(`INFO [ log_server_request] request | status=200`, "m")?.level).toBe("info");
    expect(parseLine(`ERROR [ server_main] could not load weights`, "m")?.level).toBe("error");
    expect(parseLine(`WARN [ slot_update] context shift`, "m")?.level).toBe("warn");
    // The mock model's own shape still works.
    expect(parseLine(`[debug] request finished`, "m")?.level).toBe("debug");
  });

  it("drops successful health-probe lines, which drown out everything else", () => {
    // kubelet polls /health every few seconds per pod. Real fleets produce
    // thousands of these an hour and nothing else would be visible.
    expect(
      parseLine(`[INFO] Request 10.1.2.3 "GET /health HTTP/1.1" 200 2 "kube-probe" 6.083µs`, "m")
    ).toBeNull();

    // A failing probe is precisely what the panel is for.
    const failing = parseLine(
      `[INFO] Request 10.1.2.3 "GET /health HTTP/1.1" 503 2 "kube-probe" 6.083µs`,
      "m"
    );
    expect(failing).not.toBeNull();
  });

  it("treats llama-swap's start-up connection retries as warnings, not errors", () => {
    // Emitted once per retry while a model process starts. On a cold start of
    // a large model this is the normal path, not a fault.
    const line = parseLine(
      `2026/08/08 09:53:17 http: proxy error: dial tcp [::1]:5801: connect: connection refused`,
      "m"
    );
    expect(line?.level).toBe("warn");
  });

  it("strips the Kubernetes timestamp into the ts field", () => {
    const line = parseLine(`2026-08-08T01:02:03.456789Z INFO [ x] hello`, "m");
    expect(line?.ts).toBe("2026-08-08T01:02:03.456789Z");
    expect(line?.message).toContain("hello");
  });

  it("keeps operational lines intact — they are what the panel is for", () => {
    const redact = createRedactor(true);
    const operational = [
      `slot apply_checkp: id 0 | task 3817 | restored context checkpoint took 34.38 ms`,
      `INFO [ batch_pending_prompt] kv cache rm [p0, end) | id_slot=0 p0=50376`,
      `[1783304166] Resampling because token 1265: 'action' does not meet grammar rules`,
      `INFO [ log_server_request] request | status=200 method="POST" path="/v1/chat/completions"`,
      `slot print_timing: id 0 | task 0 | eval time = 21.12 ms / 6 tok`,
    ];
    for (const line of operational) {
      expect(redact(line), `should not have been redacted: ${line}`).toBe(line);
    }
  });

  it("masks a prompt dump and everything in it", () => {
    const redact = createRedactor(true);
    // Exactly the shape a real server emits: a `prompt:` header, then the
    // chat-templated content, then normal logging resumes.
    expect(redact("prompt:")).toContain(REDACTED);
    expect(redact("<|im_start|>assistant")).toBe(REDACTED);
    expect(redact("<tool_call>")).toBe(REDACTED);
    expect(redact(`{"name": "skill_manage", "arguments": {"action": "patch"}}`)).toBe(REDACTED);

    // A real log line closes the block, and logging continues normally.
    const resumed = `INFO [ log_server_request] request | status=200`;
    expect(redact(resumed)).toBe(resumed);
    expect(redact(`slot release: id 0 | task 3817`)).toContain("slot release");
  });

  it("masks chat-template markers even inline on an otherwise normal line", () => {
    const redact = createRedactor(true);
    expect(redact(`INFO [ srv] formatted: <|im_start|>user hello<|im_end|>`)).toBe(REDACTED);
    expect(redact(`[INST] what is my password [/INST]`)).toBe(REDACTED);
  });

  it("can be turned off for an operator who needs raw output", () => {
    const redact = createRedactor(false);
    expect(redact("<|im_start|>assistant")).toBe("<|im_start|>assistant");
  });
});
