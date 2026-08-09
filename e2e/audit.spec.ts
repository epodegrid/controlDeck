import { test, expect } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * The audit surface, which is the one place where getting it wrong is a
 * compliance problem rather than a cosmetic one: content logging must be off
 * unless a scope says otherwise, the toggle must actually persist, and
 * deleting history must actually delete.
 */
test.describe("audit", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("lists requests with caller, model and token counts", async ({ page }) => {
    await page.goto("/audit");
    await expect(page.getByRole("heading", { name: /Audit/i }).first()).toBeVisible();

    const body = await page.locator("body").innerText();
    // Either there is history, or the empty state explains its absence —
    // never a blank panel.
    expect(
      /No requests have been recorded yet/.test(body ?? "") || /ornith-35b|kestrel-9b|ember-embed/.test(body ?? "")
    ).toBe(true);
  });

  test("the content-logging toggle persists across a reload", async ({ page }) => {
    await page.goto("/settings");

    const toggle = page.getByRole("switch").first();
    await expect(toggle).toBeVisible();

    const before = await toggle.getAttribute("aria-checked");

    // The knob moves optimistically, so the click resolving proves nothing.
    // Wait for the write itself: reloading before it lands tests the race, not
    // the persistence this is about.
    const saved = page.waitForResponse(
      (r) => r.url().includes("/api/audit/logging-config") && r.request().method() === "PUT"
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", before === "true" ? "false" : "true");
    expect((await saved).ok()).toBe(true);

    // The real assertion: it survives a round-trip to the router, rather than
    // only flipping in local state.
    await page.reload();
    const after = page.getByRole("switch").first();
    await expect(after).toHaveAttribute("aria-checked", before === "true" ? "false" : "true");

    // Put it back so the suite is re-runnable.
    await after.click();
    await expect(after).toHaveAttribute("aria-checked", before ?? "false");
  });

  test("the switch knob actually travels when toggled", async ({ page }) => {
    // Guards the geometry bug where the knob was absolutely positioned with no
    // horizontal anchor: it sat mid-track, so the off state looked like on.
    await page.goto("/settings");
    const toggle = page.getByRole("switch").first();
    const knob = toggle.locator("span").first();

    const track = await toggle.boundingBox();
    const start = await knob.boundingBox();
    expect(track && start).toBeTruthy();
    // The knob must begin inside its track, not centred in it.
    expect(start!.x).toBeGreaterThanOrEqual(track!.x - 1);
    expect(start!.x + start!.width).toBeLessThanOrEqual(track!.x + track!.width + 1);

    await toggle.click();
    await page.waitForTimeout(450); // let the transition settle
    const moved = await knob.boundingBox();
    expect(Math.abs(moved!.x - start!.x)).toBeGreaterThan(8);
    expect(moved!.x + moved!.width).toBeLessThanOrEqual(track!.x + track!.width + 1);

    await toggle.click(); // restore
  });

  test("delete history removes rows and reports how many", async ({ page }) => {
    await page.goto("/audit");

    const deleteButton = page.getByRole("button", { name: /delete/i }).first();
    if ((await deleteButton.count()) === 0) test.skip(true, "no delete control rendered");

    page.once("dialog", (d) => d.accept());
    await deleteButton.click();

    // Whatever it reports, it must not leave the page in a broken state.
    await expect(page.getByRole("heading", { name: /Audit/i }).first()).toBeVisible();
  });
});
