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
  const app = Fastify({ logger: opts.logger ?? true });
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
