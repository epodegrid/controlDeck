import { E2E } from "../playwright.config";

/**
 * Fails fast with an actionable message when the supporting containers aren't
 * up, instead of letting Playwright spend two minutes timing out on a
 * webServer that was never going to start.
 */
async function reachable(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default async function globalSetup() {
  const checks: { name: string; url: string }[] = [
    { name: "mock-oidc", url: `${E2E.AUTHORITY}/healthz` },
    { name: "mock model (kestrel-9b-a)", url: "http://localhost:5002/health" },
  ];

  const down = [];
  for (const c of checks) {
    if (!(await reachable(c.url))) down.push(c.name);
  }

  if (down.length > 0) {
    throw new Error(
      `E2E prerequisites are not running: ${down.join(", ")}.\n\n` +
        `Start the supporting stack first:\n\n` +
        `    docker compose up -d\n\n` +
        `These tests run the dashboard in production auth mode against the bundled\n` +
        `mock Entra provider, so both it and the model replicas must be up.`
    );
  }

  // The router needs a registered model to route to. In production this comes
  // from Helm; here the demo registry stands in for it.
  const { seed } = await import("../server/src/db/seed.js");
  process.env.DATABASE_URL ??= "postgres://controldeck:controldeck@localhost:5433/controldeck";
  await seed({ force: true });
}
