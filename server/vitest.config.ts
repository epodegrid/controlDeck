import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 15000,
    // DB-backed test files share one Postgres instance and some truncate
    // shared tables in beforeEach; running files in parallel causes
    // cross-file races. Serialize file execution instead.
    fileParallelism: false,
    // Provisions + migrates a dedicated test database so fixture rows never
    // land in the tables the dashboard reads. See test/global-setup.ts.
    globalSetup: "./test/global-setup.ts",
    env: {
      USE_FAKE_ADAPTERS: "true",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgres://controldeck:controldeck@localhost:5433/controldeck_test",
    },
  },
});
