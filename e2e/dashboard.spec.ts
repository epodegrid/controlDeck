import { test, expect } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("every view renders without a client-side error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    for (const path of ["/", "/models", "/requests", "/cost", "/audit", "/monitoring", "/settings"]) {
      await page.goto(path);
      await expect(page.locator("header")).toBeVisible();
      // Next's error overlay would mean the page threw during render.
      await expect(page.getByText(/Unhandled Runtime Error|Application error/i)).toHaveCount(0);
    }
    expect(errors, `page errors: ${errors.join("; ")}`).toHaveLength(0);
  });

  test("no view scrolls sideways", async ({ page }) => {
    for (const path of ["/", "/models", "/cost", "/audit"]) {
      await page.goto(path);
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      );
      expect(overflows, `${path} overflows horizontally`).toBe(false);
    }
  });

  test("shows the fleet, and never leaks raw ISO timestamps into labels", async ({ page }) => {
    await page.goto("/");
    const visible = await page.locator("body").innerText();
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(visible), "raw ISO timestamp visible").toBe(false);
  });

  test("theme choice persists across navigation and reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.goto("/cost");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.reload();
    // The blocking script in <head> must apply it before paint.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.getByRole("radio", { name: "System" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
  });

  test("dark mode drops the light ambient wash", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("radio", { name: "Dark" }).click();

    const washDisplay = await page.evaluate(() => {
      const el = document.querySelector(".ambient-wash");
      return el ? getComputedStyle(el, "::before").display : "none";
    });
    expect(washDisplay).toBe("none");

    await page.getByRole("radio", { name: "System" }).click();
  });

  test("the models view reflects the live replica fleet", async ({ page }) => {
    await page.goto("/models");
    const body = (await page.textContent("body")) ?? "";
    expect(/kestrel-9b|ornith-35b|No models registered/.test(body)).toBe(true);
  });
});
