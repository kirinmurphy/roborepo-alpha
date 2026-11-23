#!/usr/bin/env node
// The built-in catalog's skill relationships, end to end in a temporary home: enabling plan-suite
// turns on what it requires without recording it as a selection, they leave with it, react brings
// javascript-typescript and code-style, and a required skill missing from disk shows the parent as
// unhealthy. The generic dependency engine is covered by fixture packages in
// package-lifecycle-check.mjs; this pins the real manifests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeHome, repoRoot } from "./app-root-fixture.mjs";

const cli = path.join(repoRoot, "scripts/cli/main.mjs");
const home = makeHome({ prefix: "roborepo-package-relationships-" });
const stateRoot = path.join(home, ".roborepo");
const env = { ...process.env, HOME: home, ROBOREPO_STATE_ROOT: stateRoot, SKIP_MCP: "1" };

const run = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  assert.equal(result.status, 0, `roborepo ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const roots = () => JSON.parse(fs.readFileSync(path.join(stateRoot, "enabled-packages.json"), "utf8")).packages;
const status = (id) => JSON.parse(run("package", "status", id, "--json"));
const REQUIRED = ["implementation-review", "technical-writing", "test-harness", "code-style", "feature-verification"];

try {
  const out = run("package", "enable", "plan-suite");
  assert.deepEqual(roots(), ["plan-suite"], "only plan-suite is recorded as a selection");
  for (const id of REQUIRED) assert.equal(status(id).status, "enabled", `${id} is on through plan-suite`);
  // Everything plan-suite and what it includes recommend, it already includes.
  assert.doesNotMatch(out, /recommended \(not enabled\)/, "plan-suite has nothing left to recommend");
  assert.equal(status("javascript-typescript").enabled, false, "javascript-typescript is neither included nor turned on");

  // What plan-suite includes leaves with it.
  run("package", "disable", "plan-suite");
  for (const id of REQUIRED) assert.equal(status(id).enabled, false, `${id} leaves with plan-suite`);

  // react includes javascript-typescript, which includes code-style.
  run("package", "enable", "react");
  assert.deepEqual(roots(), ["react"], "only react is recorded as a selection");
  for (const id of ["javascript-typescript", "code-style"]) assert.equal(status(id).enabled, true, `${id} is on through react`);
  run("package", "disable", "react");

  // A required skill missing from disk leaves its parent unhealthy rather than silently degraded.
  run("package", "enable", "plan-suite");
  fs.rmSync(path.join(stateRoot, "skills", "technical-writing"), { recursive: true, force: true });
  const parent = status("plan-suite");
  assert.equal(parent.status, "partial", `plan-suite reports its missing requirement: ${JSON.stringify(parent)}`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log("ok: built-in package relationships");
