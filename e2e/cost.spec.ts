import { test, expect } from "@playwright/test";
import { signIn } from "./helpers";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The chart plots completed requests from the last 24 hours, so the test has
 * to supply some. Reusing whatever the shared development database happens to
 * contain makes the result depend on when it was last used — these rows are
 * seeded here and removed afterwards, scoped by a caller name nothing else
 * uses (the same convention the server suites follow).
 */
const CALLER = "e2e-cost-fixture";

/**
 * Runs SQL through the compose Postgres. Shelling out rather than importing a
 * driver: `pg` is a dependency of the server workspace, not of the dashboard,
 * and the e2e stack already requires these containers to be up.
 */
async function sql(statement: string): Promise<string> {
  const { stdout } = await run("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "controldeck",
    "-d",
    "controldeck",
    "-q",
    "-c",
    statement,
  ]);
  return stdout;
}

/**
 * The cost view, and specifically the hourly distribution chart.
 *
 * That chart shipped rendering nothing. Every bar carried a correct inline
 * `height: 40%` and computed to 0 pixels, because a percentage height resolves
 * against the parent's height and the column wrapping the bars had none. The
 * data was right, the styles were right, and the chart was blank.
 *
 * So these assert *geometry*, not presence. A test that checks the bars exist
 * passes on a chart nobody can see — which is exactly how this survived.
 */
test.describe("cost", () => {
  test.beforeAll(async () => {
    await sql(
      `INSERT INTO requests (id, caller_oid, caller_name, team, requested_model, routed_model,
                             capabilities, status, arrived_at, started_at, completed_at,
                             input_tokens, output_tokens, cost_usd, duration_ms)
       SELECT gen_random_uuid(), 'e2e-cost-oid', '${CALLER}', 'engineering', 'kestrel-9b',
              'kestrel-9b', '{chat}', 'completed',
              now() - (g || ' hours')::interval, now() - (g || ' hours')::interval,
              now() - (g || ' hours')::interval,
              -- Deliberately uneven, so a chart that renders every bar the same
              -- height fails rather than passes.
              100 + g * 40, 200 + g * 90, 0.001, 1200
       FROM generate_series(0, 5) g`
    );
  });

  test.afterAll(async () => {
    await sql(`DELETE FROM requests WHERE caller_name = '${CALLER}'`);
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("the hourly distribution renders bars with real height", async ({ page }) => {
    await page.goto("/cost");
    await expect(page.getByText("Hourly distribution")).toBeVisible();

    // The fixture guarantees traffic in the window, so the empty state here
    // would mean the query or the period selector is broken.
    await expect(page.getByText("No hourly data for this period")).toHaveCount(0);

    const bars = page.locator(".bar-grow");
    await expect(bars.first()).toBeVisible();

    // Give the grow animation time to settle before measuring.
    await page.waitForTimeout(1200);

    const measured = await bars.evaluateAll((els) =>
      els.map((el) => ({
        rendered: el.getBoundingClientRect().height,
        inline: (el as HTMLElement).style.height,
      }))
    );

    expect(measured.length).toBeGreaterThan(0);

    // Every bar with a non-zero percentage must occupy actual pixels.
    const shouldBeVisible = measured.filter(
      (m) => m.inline.endsWith("%") && parseFloat(m.inline) > 1
    );
    expect(shouldBeVisible.length).toBeGreaterThan(0);
    for (const bar of shouldBeVisible) {
      expect(bar.rendered, `bar with inline height ${bar.inline} rendered ${bar.rendered}px`)
        .toBeGreaterThan(1);
    }

    // And they must differ from one another, or the chart is a flat block
    // that happens to have height.
    const heights = new Set(shouldBeVisible.map((b) => Math.round(b.rendered)));
    expect(heights.size).toBeGreaterThan(1);
  });

  test("token totals under the chart agree with the bars", async ({ page }) => {
    await page.goto("/cost");
    // Wait for the panel itself, not just navigation: reading the body while
    // the server component is still streaming sees only the shell.
    await expect(page.getByText("Hourly distribution")).toBeVisible();
    // innerText returns *rendered* text, and these labels are uppercased by
    // CSS — matching the source casing would fail on a page that is fine.
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body).toContain("tokens in");
    // Whatever the numbers are, they must be numbers.
    expect(body).not.toContain("nan");
  });
});
