import { test, expect } from "@playwright/test";
import { E2E } from "../playwright.config";
import { signIn } from "./helpers";

/**
 * Sign-in against the mock Entra provider.
 *
 * This is the path that had never actually been executed end to end — it was
 * verified by minting a session cookie by hand, which proves the session
 * format and nothing about the OIDC exchange.
 */

const CONTROL = `${E2E.AUTHORITY}/_control`;

test.afterEach(async ({ request }) => {
  // Leave the provider in its default shape for the next test.
  await request.post(CONTROL, {
    data: {
      omitName: false,
      omitDepartment: false,
      omitRoles: false,
      groupOverage: false,
      failTokenExchange: false,
    },
  });
});

test.describe("dashboard authentication", () => {
  test("an unauthenticated visitor is sent to sign-in, not an empty dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText(/Access is granted by Entra group membership/i)).toBeVisible();
  });

  test("every dashboard route is gated, not just the home page", async ({ page }) => {
    for (const path of ["/models", "/requests", "/cost", "/audit", "/monitoring", "/settings"]) {
      await page.goto(path);
      await expect(page, `${path} should require sign-in`).toHaveURL(/\/login/);
    }
  });

  test("completes the full authorization-code flow and lands signed in", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: /Continue with Microsoft Entra ID/i }).click();

    // The provider's account picker — proof we actually reached the IdP.
    await expect(page.getByRole("heading", { name: "Mock Entra" })).toBeVisible();
    await page.getByRole("link", { name: /Dana Okonkwo/ }).click();

    await expect(page).toHaveURL(new RegExp(`localhost:${E2E.DASH_PORT}/$`));
    // Identity comes from the id_token, not from anything we invented.
    const banner = page.getByRole("banner");
    await expect(banner.getByText("Dana Okonkwo")).toBeVisible();
    await expect(banner.getByText("dana@example.com")).toBeVisible();
    // A real session must never be labelled as simulated.
    await expect(page.getByText("Sim mode")).toHaveCount(0);
  });

  test("the session survives navigation across views", async ({ page }) => {
    await signIn(page);
    for (const path of ["/models", "/cost", "/audit"]) {
      await page.goto(path);
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.getByRole("banner").getByText("Dana Okonkwo")).toBeVisible();
    }
  });

  test("signing out clears the session and re-gates the dashboard", async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Sign out" }).click();

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/You have been signed out/i)).toBeVisible();

    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("a failed token exchange surfaces an error instead of a blank page", async ({ page, request }) => {
    await request.post(CONTROL, { data: { failTokenExchange: true } });

    await page.goto("/login");
    await page.getByRole("link", { name: /Continue with Microsoft Entra ID/i }).click();
    await page.getByRole("link", { name: /Dana Okonkwo/ }).click();

    await expect(page).toHaveURL(/\/login\?error=/);
    await expect(page.getByText(/invalid_grant|Injected token-exchange failure/i)).toBeVisible();
  });

  test("refuses a user who does not hold the admin app role", async ({ page }) => {
    // §6.1: authorization is directory membership and nothing else.
    await page.goto("/login");
    await page.getByRole("link", { name: /Continue with Microsoft Entra ID/i }).click();
    await page.getByRole("link", { name: /Wei Zhang/ }).click();

    await expect(page).toHaveURL(/\/login\?error=/);
    await expect(page.getByText(/does not hold app role "Admin"/i)).toBeVisible();
  });

  test("app roles survive group-claim overage", async ({ page, request }) => {
    // The reason roles are the recommended configuration: `roles` is scoped to
    // one application and cannot overflow, so an admin who belongs to hundreds
    // of groups still signs in. The same scenario on a group id locks them out.
    await request.post(CONTROL, { data: { groupOverage: true } });

    await page.goto("/login");
    await page.getByRole("link", { name: /Continue with Microsoft Entra ID/i }).click();
    await page.getByRole("link", { name: /Dana Okonkwo/ }).click();

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("banner").getByText("Dana Okonkwo")).toBeVisible();
  });

  test("explains overage specifically when no role is held and groups overflowed", async ({ page, request }) => {
    // The diagnosability case: "not a member" is misleading for a user who
    // demonstrably is one, so the message must name the real cause.
    await request.post(CONTROL, { data: { groupOverage: true, omitRoles: true } });

    await page.goto("/login");
    await page.getByRole("link", { name: /Continue with Microsoft Entra ID/i }).click();
    await page.getByRole("link", { name: /Dana Okonkwo/ }).click();

    await expect(page).toHaveURL(/\/login\?error=/);
    await expect(page.getByText(/too many groups for Entra to list them/i)).toBeVisible();
    await expect(page.getByText(/DASHBOARD_ADMIN_ROLE/)).toBeVisible();
  });

  test("a tampered state parameter is refused", async ({ page }) => {
    // Arrive at the callback with a code the browser never negotiated.
    await page.goto("/api/auth/callback?code=fabricated&state=not-the-one-we-issued");
    await expect(page).toHaveURL(/\/login\?error=/);
  });

  test("signs in even when the provider omits name and department", async ({ page, request }) => {
    // Entra's default for access tokens. The dashboard must degrade to the
    // username rather than refusing a legitimate admin.
    await request.post(CONTROL, { data: { omitName: true, omitDepartment: true } });

    await page.goto("/login");
    await page.getByRole("link", { name: /Continue with Microsoft Entra ID/i }).click();
    await page.getByRole("link", { name: /Priya Raman/ }).click();

    await expect(page).not.toHaveURL(/\/login/);
    // The display name degrades to the username, so both lines of the identity
    // block show it — that is the fallback working, not a rendering bug.
    const shown = page.getByRole("banner").getByText("priya@example.com");
    await expect(shown.first()).toBeVisible();
    await expect(shown).toHaveCount(2);
  });
});
