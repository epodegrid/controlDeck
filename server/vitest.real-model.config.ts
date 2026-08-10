import { defineConfig } from "vitest/config";

/**
 * Config for the real-container suite.
 *
 * Separate from vitest.config.ts for one reason: no `globalSetup`. The main
 * config provisions a Postgres test database, and these tests talk only to a
 * llama-swap container over HTTP. Requiring a database they never touch would
 * make the integration suite unrunnable wherever Postgres is not up — which
 * includes the CI job that starts the model container and nothing else.
 */
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    globals: false,
    include: ["test/real-model.test.ts", "test/agent-loop.test.ts"],
    // Weight loading on the first request dominates: the model is small, but
    // it is a real one, and CI runners are not fast.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
