import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import OpenAI from "openai";

const run = promisify(execFile);

/**
 * A real agent loop, through the gateway, against a real model.
 *
 * This is the test that would have caught the worst bug this project has had.
 * The router forwarded `tools` upstream and then dropped `tool_calls` on the
 * way back, so every agent client — opencode, Copilot, anything with a tool
 * loop — saw a model that thought out loud and never touched a file. Chat
 * worked, so the platform looked healthy.
 *
 * Nothing here is stubbed: the official OpenAI SDK talks to the router, the
 * router talks to a llama-swap container, and the tools genuinely read, write
 * and execute in a temporary workspace.
 *
 * What it asserts is the *protocol*, not the model's competence. Qwen3-0.6B is
 * a 400 MB model chosen to fit in CI; it is not going to refactor anything.
 * The gateway's contract is what must hold:
 *
 *   1. a tool call reaches the client, with its arguments intact
 *   2. finish_reason says `tool_calls`, so a loop knows to continue
 *   3. results sent back as `role: "tool"` are accepted
 *   4. an assistant message carrying tool_calls and null content round-trips
 *   5. the model can then finish the turn
 *
 * Skipped unless the gateway is running: ./scripts/e2e-real-model.sh
 */

const GATEWAY = process.env.REAL_GATEWAY_URL;
const TOKEN = process.env.REAL_GATEWAY_TOKEN;
const suite = GATEWAY && TOKEN ? describe : describe.skip;

// The non-thinking variant, so a turn is not spent reasoning before the tool
// call arrives. Registered as an alias over the same container (backendRef),
// which is how the production fleet exposes its own variants.
const MODEL = process.env.REAL_GATEWAY_MODEL ?? "tiny-instruct";

/**
 * `"required"` rather than naming the function, deliberately.
 *
 * Two things about this llama.cpp build, established by testing it directly
 * rather than through the gateway, so neither is mistaken for a gateway bug:
 * the named-function form (`{type: "function", function: {name}}`) is not
 * honoured — it answers in prose — and with `"auto"` a 0.6B model simply
 * invents the file contents instead of calling anything. `"required"` forces
 * the protocol path, which is what these tests are about; whether a small
 * model *chooses* to use a tool is the model's business, not the router's.
 */
const FORCE_TOOL = "required" as const;
const TURN_TIMEOUT = 300_000;

/**
 * How many times to ask before concluding the gateway is at fault.
 *
 * `tool_choice: "required"` is not strictly enforced by this llama.cpp build:
 * measured directly against the container, it produced a tool call in 4 of 5
 * attempts at temperature 0.1 and 1 of 5 at temperature 0. That is the model
 * declining to call, which is explicitly not the contract under test — the
 * contract is that a call, once made, reaches the client intact.
 *
 * So these retry, and fail only when no attempt yields one, which is what a
 * gateway dropping tool calls would look like. Three attempts puts a false
 * failure at well under one percent.
 */
const TOOL_ATTEMPTS = 3;

/** Names of the tools above, for assertions. */
const TOOL_NAMES = ["read_file", "write_file", "bash"];

/** The tools an agent client actually carries, in OpenAI's schema. */
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file in the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the workspace and return its output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

suite("agent loop through the gateway", () => {
  let workspace: string;
  let client: OpenAI;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "cd-agent-"));
    await writeFile(join(workspace, "hello.txt"), "the secret word is platypus\n");
    client = new OpenAI({ baseURL: `${GATEWAY}/v1`, apiKey: TOKEN! });
  });

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  /**
   * Executes a tool for real. Paths are resolved inside the workspace and
   * rejected otherwise — a test that lets a model write anywhere on the
   * machine is a bad test regardless of what it proves.
   */
  async function execute(name: string, args: Record<string, unknown>): Promise<string> {
    const safe = (p: unknown) => {
      const full = resolve(workspace, String(p ?? ""));
      if (!full.startsWith(resolve(workspace))) throw new Error("path escapes the workspace");
      return full;
    };

    switch (name) {
      case "read_file":
        return await readFile(safe(args.path), "utf8");
      case "write_file":
        await writeFile(safe(args.path), String(args.content ?? ""));
        return `wrote ${args.path}`;
      case "bash": {
        const { stdout, stderr } = await run("/bin/sh", ["-c", String(args.command ?? "")], {
          cwd: workspace,
          timeout: 10_000,
        });
        return stdout || stderr || "(no output)";
      }
      default:
        return `unknown tool: ${name}`;
    }
  }


  /**
   * Asks until the model actually makes a tool call. See TOOL_ATTEMPTS.
   */
  async function untilToolCall(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    let last: OpenAI.Chat.Completions.ChatCompletion | undefined;
    for (let i = 0; i < TOOL_ATTEMPTS; i++) {
      const res = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: FORCE_TOOL,
        max_tokens: 200,
        temperature: 0.1,
      });
      last = res;
      if (res.choices[0].message.tool_calls?.length) return res;
    }
    return last!;
  }

  it("delivers a tool call the client can act on", async () => {
    const res = await untilToolCall([
      { role: "user", content: "Read hello.txt and tell me the secret word." },
    ]);

    const message = res.choices[0].message;
    // Before the fix this was undefined and content held prose: the model had
    // made the call and the router discarded it.
    expect(message.tool_calls, "no tool_calls reached the client").toBeTruthy();
    expect(res.choices[0].finish_reason).toBe("tool_calls");

    const call = message.tool_calls![0];
    expect(call.type).toBe("function");
    // Which tool it picks is the model's call; that a usable one arrives is
    // the gateway's.
    expect(TOOL_NAMES).toContain((call as { function: { name: string } }).function.name);
    // Arguments arrive fragmented across frames upstream; they must reassemble
    // into valid JSON or no client can use them.
    const parsed = JSON.parse((call as { function: { arguments: string } }).function.arguments);
    expect(typeof parsed).toBe("object");
  }, TURN_TIMEOUT);

  it("completes a full call → execute → result → answer round trip", async () => {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: "You are a coding agent. Use the provided tools. Be brief.",
      },
      { role: "user", content: "Read hello.txt and report the secret word." },
    ];

    const first = await untilToolCall(messages);
    const assistant = first.choices[0].message;
    expect(assistant.tool_calls).toBeTruthy();

    // The shape that used to crash the router with a 500: an assistant message
    // carrying tool_calls and null content, which is every multi-turn tool
    // exchange there is.
    messages.push(assistant as OpenAI.Chat.Completions.ChatCompletionMessageParam);

    const results: string[] = [];
    for (const call of assistant.tool_calls!) {
      const fn = (call as { function: { name: string; arguments: string } }).function;
      let out: string;
      try {
        out = await execute(fn.name, JSON.parse(fn.arguments || "{}"));
      } catch (err) {
        // A tool that throws is a normal turn in an agent loop — the error
        // goes back as the result and the model decides what to do. What
        // matters here is that the gateway carries it.
        out = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      results.push(out);
      messages.push({
        role: "tool",
        tool_call_id: (call as { id: string }).id,
        content: out,
      });
    }
    expect(results.length).toBeGreaterThan(0);

    // Whichever tool it chose, reading the seeded file is the one that yields
    // the secret — assert it only when that is what the model asked for.
    const readTheFile = assistant.tool_calls!.some(
      (c) => (c as { function: { name: string } }).function.name === "read_file"
    );
    if (readTheFile) expect(results.join("\n")).toContain("platypus");

    const second = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      max_tokens: 300,
      temperature: 0.1,
    });

    // The turn completes rather than erroring on the tool-result messages.
    expect(["stop", "length", "tool_calls"]).toContain(second.choices[0].finish_reason);
    const reply = second.choices[0].message;
    expect((reply.content ?? "") + JSON.stringify(reply.tool_calls ?? "")).not.toBe("");
  }, TURN_TIMEOUT);

  it("streams tool calls in fragments that reassemble", async () => {
    // Agent clients stream. The arguments arrive a few characters at a time,
    // and a gateway that drops or reorders them breaks the client just as
    // completely as one that drops the call.
    //
    // Retried for the same reason as the others: the model does not always
    // choose to call, and that is not what is under test here.
    let name = "";
    let assembled = "";
    let finish: string | null | undefined;

    for (let attempt = 0; attempt < TOOL_ATTEMPTS && !name; attempt++) {
      const stream = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "user", content: "Write 'hi' into out.txt using the tool." }],
        tools: TOOLS,
        tool_choice: FORCE_TOOL,
        max_tokens: 250,
        temperature: 0.1,
        stream: true,
      });

      const args = new Map<number, string>();
      let seenName = "";
      let seenFinish: string | null | undefined;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as {
          tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }>;
        };
        for (const tc of delta?.tool_calls ?? []) {
          const i = tc.index ?? 0;
          if (tc.function?.name) seenName = tc.function.name;
          if (tc.function?.arguments) args.set(i, (args.get(i) ?? "") + tc.function.arguments);
        }
        if (chunk.choices[0]?.finish_reason) seenFinish = chunk.choices[0].finish_reason;
      }

      if (seenName) {
        name = seenName;
        assembled = args.get(0) ?? "";
        finish = seenFinish;
      }
    }

    expect(TOOL_NAMES, "no tool call arrived over the stream").toContain(name);
    expect(finish).toBe("tool_calls");

    // Fragments must reassemble into valid JSON, or no client can use them.
    expect(assembled.length).toBeGreaterThan(0);
    expect(typeof JSON.parse(assembled)).toBe("object");
  }, TURN_TIMEOUT);

  it("runs a bash tool call end to end", async () => {
    const res = await untilToolCall([
      { role: "user", content: "List the files here using the bash tool." },
    ]);

    const call = res.choices[0].message.tool_calls?.[0];
    expect(call).toBeTruthy();
    const fn = (call as { function: { name: string; arguments: string } }).function;
    expect(TOOL_NAMES).toContain(fn.name);
    // Arguments survive the trip intact.
    expect(() => JSON.parse(fn.arguments || "{}")).not.toThrow();

    // And the loop can actually execute and hand output back. A fixed command
    // keeps this about the gateway rather than a small model's shell fluency.
    const output = await execute("bash", { command: "ls" });
    expect(output).toContain("hello.txt");
  }, TURN_TIMEOUT);
});
