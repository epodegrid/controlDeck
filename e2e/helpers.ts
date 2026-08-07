import { expect, type Page } from "@playwright/test";

/**
 * Signs in through the mock Entra provider and waits for the dashboard.
 *
 * Lives outside the spec files because Playwright forbids test files importing
 * one another — a shared helper has to be a plain module.
 */
export async function signIn(page: Page, who: RegExp = /Dana Okonkwo/) {
  await page.goto("/login");
  await page.getByRole("link", { name: /Continue with Microsoft Entra ID/i }).click();
  await page.getByRole("link", { name: who }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
