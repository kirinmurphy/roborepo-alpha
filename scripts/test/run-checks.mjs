#!/usr/bin/env node

// Discover-and-run for the node `*-check.mjs` suites under scripts/test/.
//
// WHY THIS EXISTS: every `-check.mjs` file used to get its own package.json `test:*` entry (71 of
// them, all `node scripts/test/<name>-check.mjs`). The manifest was noise — nothing about a file
// running it required an entry, and adding a new check meant remembering to add a script. This
// runner is the single entry point: it discovers `scripts/test/*-check.mjs` by convention, so a
// new check file is picked up automatically, and package.json stays at one `test:unit` script.
// The CI gate is narrower: ci.sh runs only the `ci` group, so a new suite runs in CI once it is
// listed there. orphan-test-check.mjs fails until it is, rather than counting discovery as running.
//
//   node scripts/test/run-checks.mjs                  # run every *-check.mjs, aggregate
//   node scripts/test/run-checks.mjs --list           # print discovered names, run nothing
//   node scripts/test/run-checks.mjs --filter <sub>   # run only files whose name contains <sub>
//   node scripts/test/run-checks.mjs --group <name>   # run the exact files listed for <name> in
//                                                     #   check-groups.json (used by ci.sh)
//
// Environment is inherited (spawnSync with the caller's env), so flags that suites read directly
// from the environment — e.g. CLEAN_MACHINE_STRICT=1 — pass through unchanged when ci.sh
// invokes this.
//
// Exit: 0 when every selected suite exited 0; 1 when any did not. Failures are aggregated and
// reported at the end rather than stopping on the first, so a broken gate shows every red suite.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const testDir = path.join(repoRoot, "scripts", "test");
const groupsPath = path.join(testDir, "check-groups.json");

function discoveredSuites() {
  return fs
    .readdirSync(testDir)
    .filter((name) => /-check\.mjs$/.test(name))
    .sort();
}

function loadGroups() {
  if (!fs.existsSync(groupsPath)) return {};
  return JSON.parse(fs.readFileSync(groupsPath, "utf8"));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const mode = { list: false, filter: null, group: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--list") mode.list = true;
    else if (arg === "--filter") mode.filter = args[++i];
    else if (arg === "--group") mode.group = args[++i];
    else {
      console.error(`usage: run-checks.mjs [--list] [--filter <substr>] [--group <name>]`);
      process.exit(2);
    }
  }
  return mode;
}

function selectSuites(mode) {
  const all = discoveredSuites();
  if (mode.group) {
    const groups = loadGroups();
    const names = groups[mode.group];
    if (!names) {
      console.error(`unknown check group: ${mode.group}`);
      console.error(`known groups: ${Object.keys(groups).join(", ")}`);
      process.exit(2);
    }
    const byName = new Map(all.map((f) => [f, true]));
    const missing = names.filter((f) => !byName.has(f));
    if (missing.length > 0) {
      console.error(`group "${mode.group}" names files that do not exist: ${missing.join(", ")}`);
      process.exit(2);
    }
    return names;
  }
  if (mode.filter) {
    return all.filter((f) => f.includes(mode.filter));
  }
  return all;
}

function main() {
  const mode = parseArgs();
  if (mode.list) {
    for (const f of discoveredSuites()) console.log(f);
    return;
  }

  const suites = selectSuites(mode);
  if (suites.length === 0) {
    console.error("no check suites matched");
    process.exit(2);
  }

  const failed = [];
  for (const file of suites) {
    const fullPath = path.join(testDir, file);
    const result = spawnSync(process.execPath, [fullPath], { stdio: "inherit", env: process.env });
    if (result.status !== 0) failed.push(file);
  }

  const passed = suites.length - failed.length;
  console.log("");
  console.log(`check suites: ${passed}/${suites.length} passed`);
  if (failed.length > 0) {
    console.error("failed:");
    for (const f of failed) console.error(`  ${f}`);
    process.exit(1);
  }
}

main();