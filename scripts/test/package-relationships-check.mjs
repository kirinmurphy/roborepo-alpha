#!/usr/bin/env node
// The built-in catalog's skill relationships, end to end in a temporary home: enabling plan-suite
// turns on what it requires without recording it as a selection, implementation-review stays on
// while either parent that requires it is on, and a required skill missing from disk shows the
// parent as unhealthy. The generic dependency engine is covered by fixture packages in
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
const REQUIRED = ["implementation-review", "technical-writing", "test-harness", "code-style"];

try {
  const out = run("package", "enable", "plan-suite");
  assert.deepEqual(roots(), ["plan-suite"], "only plan-suite is recorded as a selection");
  for (const id of REQUIRED) assert.equal(status(id).status, "enabled", `${id} is on through plan-suite`);
  assert.match(out, /recommended \(not enabled\): javascript-typescript, feature-verification\n/, "a non-interactive enable lists the recommendations");
  for (const id of ["javascript-typescript", "feature-verification"]) {
    assert.equal(status(id).enabled, false, `${id} is offered, never enabled`);
  }

  // Recommendations are flattened: session-close offers its own and those of implementation-review,
  // which it requires, except what is already on.
  run("package", "disable", "plan-suite");
  const closeOut = run("package", "enable", "session-close");
  assert.match(closeOut, /recommended \(not enabled\): test-harness, plan-suite, code-style, javascript-typescript\n/,
    "session-close offers its own recommendations and those of what it requires");
  run("package", "disable", "session-close");
  run("package", "enable", "plan-suite");

  // Both lifecycle packages require implementation-review; it leaves with the last of them.
  run("package", "enable", "session-close");
  run("package", "disable", "plan-suite");
  assert.equal(status("implementation-review").status, "enabled", "session-close keeps implementation-review on");
  assert.equal(status("technical-writing").enabled, false, "plan-suite's other requirements leave with it");
  run("package", "disable", "session-close");
  assert.equal(status("implementation-review").enabled, false, "disabling both parents removes implementation-review");

  // A required skill missing from disk leaves its parent unhealthy rather than silently degraded.
  run("package", "enable", "plan-suite");
  fs.rmSync(path.join(stateRoot, "skills", "technical-writing"), { recursive: true, force: true });
  const parent = status("plan-suite");
  assert.equal(parent.status, "partial", `plan-suite reports its missing requirement: ${JSON.stringify(parent)}`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log("ok: built-in package relationships");
