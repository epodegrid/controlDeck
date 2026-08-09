import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against the full stack in *production auth mode* — the
 * dashboard behind real SSO, the router validating real signed tokens — with
 * the bundled mock provider standing in for Entra.
 *
 * Running these in sim mode would prove almost nothing: sim mode bypasses
 * sign-in entirely. The point is to exercise the path an operator actually
 * deploys.
 *
 * Prerequisites (checked by e2e/global-setup.ts, which fails with
 * instructions rather than a timeout):
 *   docker compose up -d          # postgres, mock-oidc, mock model replicas
 */

const TENANT = "11111111-2222-3333-4444-555555555555";
const AUTHORITY = "http://localhost:9000";
const ROUTER_PORT = 4100;
const DASH_PORT = 3100;

const routerEnv = {
  DATABASE_URL: "postgres://controldeck:controldeck@localhost:5433/controldeck",
  PORT: String(ROUTER_PORT),
  MODEL_BACKEND: "http",
  ENTRA_JWKS_URI: `${AUTHORITY}/${TENANT}/discovery/v2.0/keys`,
  ENTRA_ISSUER: `${AUTHORITY}/${TENANT}/v2.0`,
  ENTRA_AUDIENCE: "api://llm-gateway",
  ENTRA_TENANT_ID: TENANT,
  MODEL_REPLICAS_ORNITH_35B: "http://localhost:5001,http://localhost:5011",
  MODEL_REPLICAS_KESTREL_9B: "http://localhost:5002,http://localhost:5012,http://localhost:5022",
  MODEL_REPLICAS_LARK_VISION: "http://localhost:5003,http://localhost:5013",
  MODEL_REPLICAS_EMBER_EMBED: "http://localhost:5004",
};

const dashboardEnv = {
  // Server-side only, exactly as the chart sets it. NEXT_PUBLIC_API_BASE_URL is
  // deliberately absent: setting it here made the browser call the router
  // directly, which no deployment can reproduce — Next inlines NEXT_PUBLIC_*
  // at build time, so the published image always carried the localhost
  // fallback instead. The suite passed for two releases while every
  // client-side call was broken in the cluster. Leave it unset so these tests
  // exercise the same-origin /gateway proxy the browser actually uses.
  API_BASE_URL: `http://localhost:${ROUTER_PORT}`,
  DASHBOARD_APP_URL: `http://localhost:${DASH_PORT}`,
  DASHBOARD_SESSION_SECRET: "e2e-session-secret-at-least-32-characters-long",
  DASHBOARD_ENTRA_AUTHORITY: AUTHORITY,
  DASHBOARD_ENTRA_TENANT_ID: TENANT,
  DASHBOARD_ENTRA_CLIENT_ID: "controldeck-dashboard",
  DASHBOARD_ENTRA_CLIENT_SECRET: "not-checked-by-the-mock-provider",
  // The mock directory grants this role to Dana and Priya but not to Wei, so
  // admin enforcement is exercised for real rather than left unconfigured.
  // Roles rather than a group id: this is the configuration we recommend, so
  // it is the one the suite should be proving.
  DASHBOARD_ADMIN_ROLE: "Admin",
};

export const E2E = { TENANT, AUTHORITY, ROUTER_PORT, DASH_PORT };

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // These share one database and one router; running them in parallel would
  // make the audit tests fight over the same rows.
  workers: 1,
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${DASH_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npx tsx src/index.ts",
      cwd: "./server",
      port: ROUTER_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: routerEnv,
    },
    {
      command: `npx next dev -p ${DASH_PORT}`,
      port: DASH_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: dashboardEnv,
    },
  ],
});
