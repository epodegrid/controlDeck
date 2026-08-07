#!/usr/bin/env node
/**
 * Sets the release version everywhere it appears, in one step.
 *
 * The project ships four artifacts — three container images and a Helm chart —
 * whose versions must agree, because the chart's appVersion is what selects
 * the image tags. Bumping them by hand is how you end up with a 0.3.0 chart
 * deploying 0.2.0 images and a very confusing afternoon. The release workflow
 * re-checks this against the git tag and refuses to publish on a mismatch.
 *
 *   node scripts/set-version.mjs 0.2.0
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/set-version.mjs <version>   e.g. 0.2.0");
  process.exit(1);
}
// SemVer without a leading v; the git tag adds it.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`"${version}" is not a semver version (expected e.g. 0.2.0 or 1.0.0-rc.1)`);
  process.exit(1);
}

const packages = ["package.json", "server/package.json", "mock-model/package.json", "mock-oidc/package.json"];

for (const rel of packages) {
  const path = join(root, rel);
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`  ${rel} -> ${version}`);
}

// Chart `version` is the chart's own; `appVersion` is what it deploys. They are
// allowed to diverge in Helm, but keeping them equal here means one number
// describes the whole release.
const chartPath = join(root, "helm/controldeck/Chart.yaml");
const chart = readFileSync(chartPath, "utf8")
  .replace(/^version:\s*.*$/m, `version: ${version}`)
  .replace(/^appVersion:\s*.*$/m, `appVersion: "${version}"`);
writeFileSync(chartPath, chart);
console.log(`  helm/controldeck/Chart.yaml -> ${version}`);

console.log(`\nNext:\n  git commit -am "Release ${version}"\n  git tag v${version}\n  git push --follow-tags`);
