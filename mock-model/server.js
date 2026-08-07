// A dependency-free stand-in for an ik_llama.cpp/llama-swap model replica.
//
// It speaks enough of the OpenAI-compatible surface for the router to treat it
// as a real backend: a readiness endpoint that stays down for a configurable
// warm-up, SSE chat completions paced at a configurable tokens/sec, and
// embeddings. Every interesting failure the PRD names (§6.5, §6.6) is
// reachable here on demand, so routing, queueing, stall detection, audit and
// the dashboard can all be exercised without a GPU in sight.
//
// Deliberately zero-dependency: the image stays tiny and needs no registry
// access to build, matching the air-gapped deployment story in PRD §8.

import { createServer } from "node:http";

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const MODEL_ID = process.env.MODEL_ID ?? "mock-model";
const PORT = num("PORT", 8080);
const CAPABILITIES = (process.env.CAPABILITIES ?? "chat,tools")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const EMBEDDING_DIM = num("EMBEDDING_DIM", 16);

// Mutable at runtime via POST /_control, so an e2e test can force a specific
// failure instead of waiting for a probability to land.
const state = {
  tokensPerSec: num("TOKENS_PER_SEC", 40),
  maxConcurrency: num("MAX_CONCURRENCY", 4),
  stallProbability: num("STALL_PROBABILITY", 0),
  errorProbability: num("ERROR_PROBABILITY", 0),
  replyMinTokens: num("REPLY_MIN_TOKENS", 12),
  replyMaxTokens: num("REPLY_MAX_TOKENS", 48),
  // Readiness gate. PRD §6.4: a replica must not receive traffic until its
  // weights are loaded, so we hold /health down for the warm-up window.
  readyAt: Date.now() + num("LOAD_DELAY_MS", 0),
  forceReady: false,
};

const stats = { chat: 0, embeddings: 0, stalled: 0, errored: 0, rejected: 0 };
let inFlight = 0;

const isReady = () => state.forceReady || Date.now() >= state.readyAt;

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Mirrors the platform's standardized error shape (PRD §6.6). */
function apiError(res, code, type, errorCode, message) {
  stats.errored += 1;
  json(res, code, { error: { type, code: errorCode, message } });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** Detects an image part in OpenAI multi-part message content. */
function hasImage(messages) {
  return messages.some(
    (m) =>
      Array.isArray(m?.content) &&
      m.content.some((part) => part?.type === "image_url" || part?.type === "image")
  );
}

function promptTextOf(messages) {
  return messages
    .map((m) => {
      if (typeof m?.content === "string") return m.content;
      if (Array.isArray(m?.content)) {
        return m.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join(" ");
      }
      return "";
    })
    .join("\n");
}

/**
 * Builds the reply. Always leads with "Hello world" so the content is
 * instantly recognizable in the audit log, then pads to a random length so
 * token counts and cost figures vary across requests instead of being
 * suspiciously uniform.
 */
function buildReply(promptText) {
  const min = Math.max(2, state.replyMinTokens);
  const max = Math.max(min, state.replyMaxTokens);
  const target = min + Math.floor(Math.random() * (max - min + 1));

  const tokens = ["Hello", "world", "from", `${MODEL_ID}.`];
  const filler = [
    "This", "is", "synthetic", "output", "produced", "by", "the", "mock",
    "model", "replica", "for", "routing", "and", "audit", "verification.",
    "The", "prompt", "was", `${promptText.trim().slice(0, 40) || "(empty)"}.`,
  ];
  let i = 0;
  while (tokens.length < target) tokens.push(filler[i++ % filler.length]);
  return tokens.slice(0, target);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleChat(req, res, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return apiError(res, 400, "invalid_request_error", "invalid_request", "messages[] is required.");
  }

  // The router is supposed to have filtered on capability before it got here
  // (PRD §6.3 step 1). Rejecting rather than best-efforting means a routing
  // regression shows up as a loud failure instead of a plausible-looking
  // answer from the wrong model.
  if (hasImage(messages) && !CAPABILITIES.includes("vision")) {
    return apiError(res, 400, "invalid_request_error", "capability_mismatch",
      `Model "${MODEL_ID}" has no vision capability but the request contains an image.`);
  }
  if (Array.isArray(body.tools) && body.tools.length > 0 && !CAPABILITIES.includes("tools")) {
    return apiError(res, 400, "invalid_request_error", "capability_mismatch",
      `Model "${MODEL_ID}" has no tools capability but the request supplies tools[].`);
  }

  if (inFlight >= state.maxConcurrency) {
    stats.rejected += 1;
    return apiError(res, 503, "capacity_error", "replica_unavailable",
      `Replica for "${MODEL_ID}" is at its concurrency limit (${state.maxConcurrency}).`);
  }
  if (Math.random() < state.errorProbability) {
    return apiError(res, 500, "server_error", "replica_unavailable",
      `Injected fault: replica for "${MODEL_ID}" failed to generate.`);
  }

  inFlight += 1;
  stats.chat += 1;
  const tokens = buildReply(promptTextOf(messages));
  const perTokenMs = 1000 / Math.max(1, state.tokensPerSec);
  // Roll the stall dice once up front, then pick a cut-off partway through so
  // the request looks like it is progressing before it goes quiet.
  const stallAt = Math.random() < state.stallProbability
    ? 1 + Math.floor(Math.random() * Math.max(1, tokens.length - 1))
    : -1;

  try {
    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      for (let i = 0; i < tokens.length; i++) {
        if (i === stallAt) {
          // PRD §6.5 clock #2: go silent while holding the connection open.
          // The router's inactivity sweep is what must notice this.
          stats.stalled += 1;
          return; // `finally` keeps the socket open by design.
        }
        await sleep(perTokenMs);
        if (res.writableEnded || res.destroyed) return;
        const chunk = {
          id: `chatcmpl-${MODEL_ID}`,
          object: "chat.completion.chunk",
          model: MODEL_ID,
          choices: [{ index: 0, delta: { content: tokens[i] + " " }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${MODEL_ID}`,
        object: "chat.completion.chunk",
        model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Non-streaming still costs real wall-clock time, so duration-based cost
    // (PRD §6.7) reflects the same generation speed either way.
    await sleep(perTokenMs * tokens.length);
    const promptTokens = Math.ceil(promptTextOf(messages).length / 4);
    json(res, 200, {
      id: `chatcmpl-${MODEL_ID}`,
      object: "chat.completion",
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content: tokens.join(" ") }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: tokens.length,
        total_tokens: promptTokens + tokens.length,
      },
    });
  } finally {
    inFlight -= 1;
  }
}

async function handleEmbeddings(req, res, body) {
  if (!CAPABILITIES.includes("embeddings")) {
    return apiError(res, 400, "invalid_request_error", "capability_mismatch",
      `Model "${MODEL_ID}" has no embeddings capability.`);
  }
  if (body?.input === undefined || body.input === null || body.input === "") {
    return apiError(res, 400, "invalid_request_error", "invalid_request", "input is required.");
  }

  stats.embeddings += 1;
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  // Deterministic per input text, so repeated calls are comparable.
  const data = inputs.map((text, index) => {
    const seed = Array.from(String(text)).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    return {
      object: "embedding",
      index,
      embedding: Array.from({ length: EMBEDDING_DIM }, (_, i) => Number(Math.sin(seed + i).toFixed(6))),
    };
  });
  const promptTokens = inputs.reduce((acc, t) => acc + Math.ceil(String(t).length / 4), 0);
  json(res, 200, {
    object: "list",
    model: MODEL_ID,
    data,
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    const ready = isReady();
    return json(res, ready ? 200 : 503, {
      status: ready ? "ready" : "loading",
      model: MODEL_ID,
      capabilities: CAPABILITIES,
      inFlight,
      maxConcurrency: state.maxConcurrency,
      msUntilReady: ready ? 0 : state.readyAt - Date.now(),
    });
  }

  if (req.method === "GET" && path === "/v1/models") {
    return json(res, 200, {
      object: "list",
      data: [{ id: MODEL_ID, object: "model", capabilities: CAPABILITIES }],
    });
  }

  if (req.method === "GET" && (path === "/_stats" || path === "/_control")) {
    return json(res, 200, { model: MODEL_ID, ready: isReady(), inFlight, stats, state });
  }

  // Runtime fault control, so tests can force a stall or a cold replica
  // deterministically rather than waiting on a probability.
  if (req.method === "POST" && path === "/_control") {
    const body = await readBody(req);
    if (body === null) return apiError(res, 400, "invalid_request_error", "invalid_request", "Body must be valid JSON.");
    for (const key of ["tokensPerSec", "maxConcurrency", "stallProbability", "errorProbability", "replyMinTokens", "replyMaxTokens"]) {
      if (typeof body[key] === "number") state[key] = body[key];
    }
    if (typeof body.forceReady === "boolean") state.forceReady = body.forceReady;
    if (typeof body.loadDelayMs === "number") {
      state.readyAt = Date.now() + body.loadDelayMs;
      state.forceReady = false;
    }
    return json(res, 200, { ok: true, state });
  }

  // Readiness gating applies to inference only — /health and /_control must
  // stay reachable while the replica is still warming.
  if (!isReady()) {
    return apiError(res, 503, "capacity_error", "replica_unavailable",
      `Replica for "${MODEL_ID}" is still loading model weights.`);
  }

  if (req.method === "POST" && path === "/v1/chat/completions") {
    const body = await readBody(req);
    if (body === null) return apiError(res, 400, "invalid_request_error", "invalid_request", "Body must be valid JSON.");
    return handleChat(req, res, body);
  }

  if (req.method === "POST" && path === "/v1/embeddings") {
    const body = await readBody(req);
    if (body === null) return apiError(res, 400, "invalid_request_error", "invalid_request", "Body must be valid JSON.");
    return handleEmbeddings(req, res, body);
  }

  apiError(res, 404, "invalid_request_error", "not_found", `No route for ${req.method} ${path}.`);
});

// A stalled stream deliberately holds its socket open past any sane timeout;
// letting Node time it out would defeat the point of the fault.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.setTimeout(0);

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[mock-model] ${MODEL_ID} listening on :${PORT} ` +
      `caps=${CAPABILITIES.join("|")} tps=${state.tokensPerSec} ` +
      `maxConc=${state.maxConcurrency} readyIn=${Math.max(0, state.readyAt - Date.now())}ms`
  );
});
