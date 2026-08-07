import { Client } from "pg";
import { seed } from "../src/db/seed.js";
import { closePool, getPool } from "../src/db/pool.js";

/**
 * Provisions a dedicated test database before the suite runs.
 *
 * The suite is DB-backed and writes fixture rows — teams, replicas, requests,
 * logging scopes — many of which outlive the test that created them. Pointed
 * at the development database those artifacts accumulate in the very tables
 * the dashboard reads, so the Audit page ends up listing dozens of
 * `other-team-<uuid>` scopes and Cost reports a `test-model-*` line. Keeping
 * tests on their own database means `npm test` can never corrupt what the
 * dashboard shows.
 *
 * Override with TEST_DATABASE_URL; the default mirrors docker-compose.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://controldeck:controldeck@localhost:5433/controldeck_test";

export async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);

  // CREATE DATABASE cannot run from inside the database being created, so
  // connect to the default 'postgres' database to check and provision.
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });

  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Could not reach Postgres at ${adminUrl.host} to provision the test database. ` +
        `Is docker-compose up? (${err instanceof Error ? err.message : String(err)})`
    );
  }

  const { rows } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
  if (rows.length === 0) {
    // Identifier can't be parameterized; dbName comes from our own config, and
    // quoting it keeps an unusual-but-legal name from breaking the statement.
    await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    console.log(`[test] created database ${dbName}`);
  }
  await admin.end();

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  // seed() migrates first, then installs the baseline registry. Several tests
  // assume the standard model set exists (e.g. /v1/models returning replicas),
  // which previously came from whoever last ran `npm run seed` by hand.
  // force: vitest's `env` block applies to test files, not to globalSetup, so
  // SIM_MODE may not be visible here. The target database is this file's own
  // throwaway test database, so the guard has nothing to protect.
  await seed({ force: true });

  // Replicas are created by the reconciler at runtime and by individual tests
  // under test; nothing should inherit them from a previous run. Clearing them
  // here keeps every run identical to a fresh checkout — which is exactly the
  // difference that let a suite pass locally and fail in CI.
  await getPool().query(`DELETE FROM replicas`);

  await closePool();
}
