import { config } from "../config.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerV1Routes } from "./routes/v1.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerLogRoutes } from "./routes/logs.js";
import { registerSystemRoutes } from "./routes/system.js";
import { getJwksSource } from "../config.js";
import { createLlamaSwapClient, type LlamaSwapClient } from "../adapters/llama-swap.js";
import { createKedaClient, type KedaClient } from "../adapters/keda.js";

export async function buildApp(
  opts: { kedaClient?: KedaClient; logger?: boolean; llamaSwap?: LlamaSwapClient } = {}
) {
  const app = Fastify({
    logger: opts.logger ?? true,
    bodyLimit: config.bodyLimitBytes,
  });

  // Fastify's own 413 is not an OpenAI error, so a client parsing the response
  // sees an unrecognised shape rather than a reason. Translated, it says which
  // limit was hit and what to change.
  app.setErrorHandler((err, _request, reply) => {
    if ((err as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      const limitMb = (config.bodyLimitBytes / 1024 / 1024).toFixed(0);
      reply.code(413).send({
        error: {
          type: "invalid_request_error",
          code: "invalid_request",
          message:
            `Request body exceeds the gateway's ${limitMb} MB limit. This is usually an agent ` +
            `sending its whole conversation at once. Raise BODY_LIMIT_BYTES on the router, and ` +
            `the ingress body-size limit with it.`,
        },
      });
      return;
    }
    reply.send(err);
  });
  await app.register(cors, { origin: true });

  const jwks = await getJwksSource();
  const llamaSwap = opts.llamaSwap ?? createLlamaSwapClient();
  const kedaClient = opts.kedaClient ?? createKedaClient();

  registerSystemRoutes(app, { kedaClient });
  registerDashboardRoutes(app);
  registerLogRoutes(app);
  registerV1Routes(app, { jwks, kedaClient, llamaSwap });

  return app;
}
