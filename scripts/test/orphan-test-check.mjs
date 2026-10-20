#!/usr/bin/env node
// Every test file under scripts/test/ must be reachable from something that actually runs it:
// the bash suite, the local CI-parity runner, or a CI job directly. A test nothing invokes passes
// forever without asserting anything.
//
// This is not hypothetical. test-install-collisions.sh sat in no test list, which is how an
// uninstall that left files behind survived a full review pass (see commit fcdd2b8). The suite
// reported green the entire time, because the check that would have failed was never called.
//
// A second, quieter version of the same failure: a file registered as a package.json `test:*`
// script is not thereby reachable. The CI/local gate names specific `test:*` scripts, and
// test-cli.sh is its own hand-maintained assert list. A `test:*` entry that nothing calls by
// name is exactly as orphaned as a file with no npm script at all — it just looks covered. So a
// `test:*` script counts as reachable only when a runner references its target file or invokes that
// `test:*` name directly — never merely by existing in package.json.
//
// A third: run-checks.mjs can discover every *-check.mjs, but the gate runs it only with
// `--group`, so being discoverable is not being run. Nineteen suites sat outside `npm run check`
// while this check counted them as reachable. A *-check.mjs now counts only when a group the gate
// names in check-groups.json lists it, or a runner names it directly.
//
// Files that are deliberately not suite entry points declare themselves in EXEMPT below, each with
// a reason. An exemption is a decision on the record; an orphan is an accident.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const testDir = path.join(repoRoot, "scripts", "test");

// Reason strings are the point of this map: each entry says why nothing runs the file, so a future
// reader can tell a deliberate non-test from a test that quietly fell out of the suite.
const EXEMPT = new Map([
  ["naming-inventory.mjs", "naming-surface inventory utility (rename-prep); run by hand, not a check"],
  ["test-cli.sh", "the suite runner itself"],
  ["ci.sh", "the CI runner itself"],
  ["run-checks.mjs", "the discover-and-run runner; the gate runs the check-groups.json groups it names through it"],
  ["telemetry-schemas-persistence-child.mjs", "child process spawned by telemetry-schemas-check.mjs"],
  ["telemetry-spool-bench.mjs", "micro-benchmark against the live spool; run by hand, not asserted"],
  ["test-telemetry-pid.sh", "binds a real port; manual smoke, deliberately out of the automated suite"],
  ["hermetic-suite.sh", "wrapper that re-runs test-cli.sh under a sanitized HOME/PATH"],
  ["install-smoke.mjs", "post-install probe against a LIVE installation; run by hand after `roborepo update`, not in CI"],
  ["promote-npm-latest-check.mjs", "touches the real npm registry; release-only, never run in CI"],
  ["publish-npm-check.mjs", "touches the real npm registry; release-only, never run in CI"],
  ["app-root-fixture.mjs", "shared helper imported by other checks to build an isolated app root; exports no assertions of its own"],
  ["docs-reference-scan.mjs", "scanner imported by the docs reference checker; the fixtures check its behavior"],
]);

// Direct runners: substring matching on filename is deliberate. These files call their children in
// several shapes (node "${repo_root}/scripts/test/x.mjs", bash scripts/test/x.sh), and matching the
// filename catches all of them without trying to parse two languages.
const DIRECT_RUNNER_SOURCES = [
  "scripts/test/test-cli.sh",
  "scripts/test/ci.sh",
  ".github/workflows/ci.yml",
];

function readIfPresent(relativePath) {
  const absolute = path.join(repoRoot, relativePath);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
}

const directHaystack = DIRECT_RUNNER_SOURCES.map(readIfPresent).join("\n");
const packageJsonRaw = readIfPresent("package.json");
const packageJsonScripts = JSON.parse(packageJsonRaw || "{}").scripts || {};

// A test:* npm script only counts as a runner when a real runner names that script directly (e.g.
// `npm run --silent test:packages`). Being registered in package.json is not enough.
const targetsOfRunnerCalledScripts = new Set();
for (const [scriptName, command] of Object.entries(packageJsonScripts)) {
  if (!scriptName.startsWith("test:")) continue;
  const calledByRunner = new RegExp(`\\b${scriptName}\\b`).test(directHaystack);
  if (!calledByRunner) continue;
  const match = command.match(/scripts\/test\/([a-zA-Z0-9_.-]+\.(mjs|sh|ps1))/);
  if (match) targetsOfRunnerCalledScripts.add(match[1]);
}

// The check-groups.json groups a runner passes to run-checks.mjs (`--group ci` in ci.sh). Only
// those groups' members run; a group nothing names is as orphaned as an unlisted file.
const checkGroups = JSON.parse(readIfPresent("scripts/test/check-groups.json") || "{}");
const groupedByRunner = new Set();
for (const [, group] of directHaystack.matchAll(/--group\s+([A-Za-z0-9_-]+)/g)) {
  for (const name of checkGroups[group] || []) groupedByRunner.add(name);
}

const testFiles = fs
  .readdirSync(testDir)
  .filter((name) => /\.(mjs|sh|ps1)$/.test(name))
  .sort();

const orphans = [];
for (const name of testFiles) {
  if (EXEMPT.has(name)) continue;
  if (groupedByRunner.has(name)) continue;
  if (directHaystack.includes(name)) continue;
  if (targetsOfRunnerCalledScripts.has(name)) continue;
  orphans.push(name);
}

// A stale exemption is its own kind of drift: the file was deleted or renamed, and the reason string
// now documents nothing. Cheap to catch here rather than letting the map rot.
const staleExemptions = [...EXEMPT.keys()].filter((name) => !testFiles.includes(name));

let failed = false;

if (orphans.length > 0) {
  failed = true;
  console.error(`fail: ${orphans.length} test file(s) under scripts/test/ are not run by anything:`);
  for (const name of orphans) console.error(`  ${name}`);
  console.error("");
  console.error("Add a *-check.mjs to the `ci` group in scripts/test/check-groups.json; add anything else to scripts/test/test-cli.sh, a package.json test:* script the gate runs, or a CI job.");
  console.error(`If it is deliberately not a suite entry point, add it to EXEMPT in ${path.relative(repoRoot, fileURLToPath(import.meta.url))} with a reason.`);
}

if (staleExemptions.length > 0) {
  failed = true;
  console.error(`fail: EXEMPT names ${staleExemptions.length} file(s) that no longer exist:`);
  for (const name of staleExemptions) console.error(`  ${name}`);
}

if (failed) process.exit(1);

console.log(`ok: all ${testFiles.length - EXEMPT.size} test files reachable (${EXEMPT.size} exempt)`);
