import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getPool } from "../../db/pool.js";
import { listModels } from "../../registry/index.js";
import { selectModel } from "../../routing/index.js";
import {
  placeRequest,
  enqueueRequest,
  markStreamStarted,
  recordTokenEmitted,
  completeRequest,
  expireQueuedRequest,
  QUEUE_TIMEOUT_MS,
} from "../../scheduler/index.js";
import { computeCost, getCostConfigForModel } from "../../cost/index.js";
import { isContentLoggingEnabled, recordAuditContent } from "../../audit/index.js";
import type { KedaClient } from "../../adapters/keda.js";
import type { LlamaSwapClient } from "../../adapters/llama-swap.js";
import { statusForError, replicaUnavailable, queueTimeoutError } from "../errors.js";
import type { ChatCompletionRequest, StandardError } from "../../types.js";
import { createAuthPreHandler } from "../auth-middleware.js";
import { affinityKeyFor } from "../../scheduler/affinity.js";
import { writeSseHead } from "../sse.js";
import type { JWKSSource } from "../../auth/index.js";

const PLACEMENT_RETRY_MS = 200;

/** Marks a request row as terminally failed with a given standard error code (not covered by the queue module's own timeout sweepers). */
async function failRequest(requestId: string, err: StandardError, replicaId: string | null): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE requests SET status = $2, error_code = $3, completed_at = now() WHERE id = $1`,
    [requestId, err.error.code === "queue_timeout" ? "queue_timeout" : err.error.code === "replica_unavailable" ? "replica_unavailable" : "error", err.error.code]
  );
  if (replicaId) {
    await pool.query(`UPDATE replicas SET in_flight = GREATEST(0, in_flight - 1) WHERE id = $1`, [replicaId]);
  }
}

async function waitForPlacement(
  modelId: string,
  requestId: string,
  kedaClient: KedaClient,
  affinityKey?: string
): Promise<
  | { ok: true; replicaId: string; endpointUrl: string; affinityHit: boolean }
  | { ok: false; error: StandardError }
> {
  const deadline = Date.now() + QUEUE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const placed = await placeRequest(modelId, { kedaClient, ...(affinityKey ? { affinityKey } : {}) });
    if (placed.ok) {
      return {
        ok: true,
        replicaId: placed.replica.id,
        endpointUrl: placed.replica.endpointUrl,
        affinityHit: placed.affinityHit,
      };
    }
    await new Promise((r) => setTimeout(r, PLACEMENT_RETRY_MS));
  }
  // Fail only this caller's request. The periodic sweep in index.ts handles
  // anything else that has aged out.
  await expireQueuedRequest(requestId);
  return { ok: false, error: queueTimeoutError(`No replica became available for model "${modelId}" within the queue-wait timeout.`) };
}

export function registerV1Routes(
  app: FastifyInstance,
  deps: { jwks: JWKSSource; kedaClient: KedaClient; llamaSwap: LlamaSwapClient }
) {
  const authPreHandler = createAuthPreHandler(deps.jwks);

  app.get("/v1/models", { preHandler: authPreHandler }, async () => {
    const models = await listModels();
    return {
      object: "list",
      data: models.map((m) => ({
        id: m.id,
        object: "model",
        // Required by the OpenAI schema. Clients that validate the listing
        // reject entries without them, so a strict client could not even
        // enumerate the gateway's models.
        created: Math.floor(Date.now() / 1000),
        owned_by: "controldeck",
        capabilities: m.capabilities,
        model_class: m.modelClass,
      })),
    };
  });

  app.post("/v1/chat/completions", { preHandler: authPreHandler }, async (request, reply) => {
    const body = request.body as ChatCompletionRequest;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      reply.code(400).send({ error: { type: "invalid_request_error", code: "invalid_request", message: "messages[] is required." } });
      return;
    }

    const candidates = await listModels();
    const selection = selectModel({ request: body, candidates, endpoint: "chat" });
    if (!selection.ok) {
      reply.code(statusForError(selection.error)).send(selection.error);
      return;
    }

    const requestId = randomUUID();
    const identity = request.identity!;
    // Placement, affinity and scaling are all properties of the workload, not
    // of the name it was requested under: several registry entries can be
    // aliases over one container's loaded weights.
    const selected = candidates.find((m) => m.id === selection.modelId)!;
    const backendId = selected.backendModelId;
    await enqueueRequest({
      id: requestId,
      callerOid: identity.oid,
      callerName: identity.name,
      team: identity.team,
      requestedModel: body.model,
      capabilities: selected.capabilities,
    });
    await getPool().query(`UPDATE requests SET routed_model = $2 WHERE id = $1`, [requestId, selection.modelId]);

    // Prefer the replica already holding this conversation's KV cache. Keyed
    // on the caller plus the opening messages, which stay constant as the
    // conversation grows — see scheduler/affinity.ts.
    //
    // Keyed on the backend rather than the requested model, so two aliases of
    // the same weights share cache locality instead of competing for it.
    const affinityKey = affinityKeyFor(identity, backendId, body.messages) ?? undefined;

    const placement = await waitForPlacement(backendId, requestId, deps.kedaClient, affinityKey);
    if (!placement.ok) {
      reply.code(statusForError(placement.error)).send(placement.error);
      return;
    }

    await markStreamStarted(requestId, placement.replicaId);
    // Recorded so the benefit is measurable rather than assumed.
    await getPool().query(`UPDATE requests SET affinity_hit = $2 WHERE id = $1`, [
      requestId,
      placement.affinityHit,
    ]);
    const model = selected;
    // The placed replica's own address — falling back to the model-level one
    // only for registries predating per-replica endpoints.
    const targetUrl = placement.endpointUrl || model.endpointUrl;
    const startedAt = Date.now();
    // `created` is required by the OpenAI schema; clients that model responses
    // strictly reject a payload without it.
    const created = Math.floor(startedAt / 1000);

    // Everything the caller asked for beyond the messages themselves. Dropping
    // these silently produced answers that looked fine and ignored the
    // caller's temperature, token ceiling and stop sequences.
    const sampling = {
      // llama-swap routes on this; without it a multi-model container has
      // nothing to select on.
      model: model.upstreamModel,
      temperature: body.temperature,
      topP: body.top_p,
      maxTokens: body.max_tokens,
      stop: body.stop,
      seed: body.seed,
      presencePenalty: body.presence_penalty,
      frequencyPenalty: body.frequency_penalty,
      responseFormat: body.response_format,
      tools: body.tools,
      toolChoice: body.tool_choice,
    };

    // content is null on an assistant message that only carries tool_calls.
    const promptText = body.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
      .join("\n");

    if (body.stream) {
      writeSseHead(reply);

      let outputTokens = 0;
      let fullText = "";
      let fullReasoning = "";

      // The spec opens a stream with the assistant role, which is how a client
      // knows which message the deltas belong to.
      reply.raw.write(
        `data: ${JSON.stringify({
          id: requestId,
          object: "chat.completion.chunk",
          created,
          model: model.id,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        })}\n\n`
      );

      try {
        for await (const chunk of deps.llamaSwap.streamChat({
          endpointUrl: targetUrl,
          messages: body.messages,
          systemPrompt: model.systemPrompt,
          ...sampling,
        })) {
          if (chunk.done) break;
          // Reasoning tokens are generated tokens: they cost compute, they
          // keep the stall clock alive, and OpenAI bills them. Counting only
          // the answer would understate a thinking model's real cost.
          outputTokens += 1;
          if (chunk.reasoning) fullReasoning += chunk.reasoning;
          else fullText += chunk.token;
          await recordTokenEmitted(requestId);
          const sse = {
            id: requestId,
            object: "chat.completion.chunk",
            created,
            model: model.id,
            choices: [
              {
                index: 0,
                delta: chunk.reasoning
                  ? { reasoning_content: chunk.reasoning }
                  : { content: chunk.token },
                finish_reason: null,
              },
            ],
          };
          reply.raw.write(`data: ${JSON.stringify(sse)}\n\n`);
        }
        reply.raw.write(
          `data: ${JSON.stringify({
            id: requestId,
            object: "chat.completion.chunk",
            created,
            model: model.id,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`
        );
        reply.raw.write("data: [DONE]\n\n");

        const costConfig = (await getCostConfigForModel(model.id)) ?? { costValue: model.costValue, costBasis: model.costBasis };
        const durationMs = Date.now() - startedAt;
        const inputTokens = Math.ceil(promptText.length / 4);
        const costUsd = computeCost({ costBasis: costConfig.costBasis, costValue: costConfig.costValue, inputTokens, outputTokens, durationMs });
        await getPool().query(`UPDATE requests SET input_tokens = $2 WHERE id = $1`, [requestId, inputTokens]);
        await completeRequest(requestId, { outputTokens, costUsd });

        if (await isContentLoggingEnabled({ team: identity.team, modelId: model.id })) {
          await recordAuditContent(
            requestId,
            promptText,
            fullReasoning ? `${fullReasoning}\n\n${fullText}` : fullText
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Stream failed unexpectedly.";
        const sseErr: StandardError = { error: { type: "capacity_error", code: "replica_unavailable", message } };
        reply.raw.write(`data: ${JSON.stringify(sseErr)}\n\n`);
        await failRequest(requestId, sseErr, placement.replicaId);
      } finally {
        reply.raw.end();
      }
      return reply;
    }

    // non-streaming
    let outputTokens = 0;
    let fullText = "";
    let fullReasoning = "";
    try {
      for await (const chunk of deps.llamaSwap.streamChat({
        endpointUrl: targetUrl,
        messages: body.messages,
        systemPrompt: model.systemPrompt,
        ...sampling,
      })) {
        if (chunk.done) break;
        outputTokens += 1;
        if (chunk.reasoning) fullReasoning += chunk.reasoning;
        else fullText += chunk.token;
        await recordTokenEmitted(requestId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Generation failed unexpectedly.";
      const failErr = replicaUnavailable(message);
      await failRequest(requestId, failErr, placement.replicaId);
      reply.code(statusForError(failErr)).send(failErr);
      return;
    }

    const costConfig = (await getCostConfigForModel(model.id)) ?? { costValue: model.costValue, costBasis: model.costBasis };
    const durationMs = Date.now() - startedAt;
    const inputTokens = Math.ceil(promptText.length / 4);
    const costUsd = computeCost({ costBasis: costConfig.costBasis, costValue: costConfig.costValue, inputTokens, outputTokens, durationMs });
    await getPool().query(`UPDATE requests SET input_tokens = $2 WHERE id = $1`, [requestId, inputTokens]);
    await completeRequest(requestId, { outputTokens, costUsd });

    if (await isContentLoggingEnabled({ team: identity.team, modelId: model.id })) {
      await recordAuditContent(
        requestId,
        promptText,
        // Reasoning is model output under §6.8 too — it can restate the prompt
        // and is exactly what a content-logging scope exists to capture.
        fullReasoning ? `${fullReasoning}\n\n${fullText}` : fullText
      );
    }

    return {
      id: requestId,
      object: "chat.completion",
      created,
      model: model.id,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: fullText,
            // Only present when the model actually produced reasoning, so an
            // ordinary model's response shape is unchanged.
            ...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    };
  });

  app.post("/v1/embeddings", { preHandler: authPreHandler }, async (request, reply) => {
    const body = request.body as { model?: string; input: string | string[] };
    if (!body || !body.input) {
      reply.code(400).send({ error: { type: "invalid_request_error", code: "invalid_request", message: "input is required." } });
      return;
    }

    const candidates = await listModels();
    const selection = selectModel({
      request: { model: body.model, messages: [] },
      candidates,
      endpoint: "embeddings",
    });
    if (!selection.ok) {
      reply.code(statusForError(selection.error)).send(selection.error);
      return;
    }

    const model = candidates.find((m) => m.id === selection.modelId)!;
    const identity = request.identity!;
    const requestId = randomUUID();
    await enqueueRequest({
      id: requestId,
      callerOid: identity.oid,
      callerName: identity.name,
      team: identity.team,
      requestedModel: body.model,
      capabilities: ["embeddings"],
    });
    await getPool().query(`UPDATE requests SET routed_model = $2 WHERE id = $1`, [requestId, model.id]);

    const placement = await waitForPlacement(model.backendModelId, requestId, deps.kedaClient);
    if (!placement.ok) {
      reply.code(statusForError(placement.error)).send(placement.error);
      return;
    }
    await markStreamStarted(requestId, placement.replicaId);

    const startedAt = Date.now();
    const embeddings = await deps.llamaSwap.embed({
      endpointUrl: placement.endpointUrl || model.endpointUrl,
      input: body.input,
      model: model.upstreamModel,
    });
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const inputTokens = inputs.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0);

    const costConfig = (await getCostConfigForModel(model.id)) ?? { costValue: model.costValue, costBasis: model.costBasis };
    const costUsd = computeCost({ costBasis: costConfig.costBasis, costValue: costConfig.costValue, inputTokens, outputTokens: 0, durationMs: Date.now() - startedAt });
    await getPool().query(`UPDATE requests SET input_tokens = $2 WHERE id = $1`, [requestId, inputTokens]);
    await completeRequest(requestId, { outputTokens: 0, costUsd });

    return {
      object: "list",
      model: model.id,
      data: embeddings.map((embedding, index) => ({ object: "embedding", index, embedding })),
      usage: { prompt_tokens: inputTokens, total_tokens: inputTokens },
    };
  });
}
