import { test, expect } from "@playwright/test";
import { signIn } from "./helpers";
import { E2E } from "../playwright.config";

/**
 * Live log tailing (PRD §6.10).
 *
 * This panel used to be filled by lines the router generated from database
 * state — "readiness poll ok", source picked at random. An operator triaging a
 * crash-looping replica would have read that and concluded it was fine. These
 * tests assert the lines are the replica's own stdout, and that when they
 * cannot be obtained the panel says so rather than inventing them.
 */

const ROUTER = `http://localhost:${E2E.ROUTER_PORT}`;

async function selectReplica(page: import("@playwright/test").Page, match = /-localhost-\d+/) {
  await page.goto("/monitoring");
  const replica = page.getByRole("button").filter({ hasText: match }).first();
  await expect(replica).toBeVisible({ timeout: 15_000 });
  const id = (await replica.textContent())?.match(/\S+-localhost-\d+/)?.[0] ?? "";
  await replica.click();
  return id;
}

test.describe("replica logs", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("streams the replica's own stdout, not lines the router made up", async ({ page }) => {
    await selectReplica(page);

    // Assert on message text the mock model actually emits. An earlier version
    // of this test matched the model id anywhere on the page, which the replica
    // buttons in the sidebar satisfied — so it passed while the panel sat empty
    // and CORS was silently blocking the stream.
    await expect(
      page
        .getByText(/in_flight=\d+\/\d+|weights loaded, ready to serve|listening on :8080/)
        .first()
    ).toBeVisible({ timeout: 20_000 });

    // The old fabricated lines must never reappear.
    const panel = await page.locator("body").innerText();
    expect(panel).not.toMatch(/readiness poll ok|scaledObject watch tick|no auth events/);
  });

  test("shows a line appear as the replica produces it", async ({ page, request }) => {
    const replicaId = await selectReplica(page, /kestrel-9b-localhost-\d+/);
    const port = replicaId.match(/(\d+)$/)?.[1];
    expect(port, `could not derive a port from "${replicaId}"`).toBeTruthy();

    // Let the stream attach before producing the line we expect to see.
    await page.waitForTimeout(1500);

    // Drive the exact container being tailed, rather than going through the
    // router — placement spreads across three kestrel replicas, so a request
    // sent to the model would usually land on one we are not watching.
    await request.post(`http://localhost:${port}/v1/chat/completions`, {
      data: { messages: [{ role: "user", content: "produce a log line" }] },
    });

    await expect(page.getByText(/chat request accepted|request finished/).first()).toBeVisible({
      timeout: 25_000,
    });
  });

  test("states why it cannot attach instead of showing invented lines", async ({ page }) => {
    const res = await page.request.get(`${ROUTER}/api/logs/no-such-replica`);
    const body = await res.text();
    expect(body).toMatch(/Could not attach to logs/);
    expect(body).toMatch(/no-such-replica/);
    expect(body).not.toMatch(/readiness poll ok|scaledObject watch tick/);
  });
});
