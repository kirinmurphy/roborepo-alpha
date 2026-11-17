#!/usr/bin/env node
// Where `roborepo browser run` looks for Playwright, and in what order: the scenario's project, then
// the directory the command ran from, then RoboRepo's tool directory. Each location gets its own
// fake install with a distinct version, so a reversed order shows up as the wrong version.
//
// Resolution only reads package.json, so this check needs no real Playwright or browser. Runs with
// a real Playwright are browser-playwright-check.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { playwrightProvider } from "../cli/browser/playwright-provider.mjs";
import { resolvePlaywright, toolsDir } from "../cli/browser/playwright-resolve.mjs";
import { STATUS } from "../cli/browser/result.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-browser-resolve-"));

try {
  // ---- Each location wins only when every higher-priority one is absent ----
  // Node caches module lookups per process, so each case builds a fresh layout instead of deleting
  // an install between cases.
  assert.deepEqual(resolveIn("all", { scenario: true, working: true, tools: true }), { source: "project", version: "1.0.0-scenario" }, "the scenario's project wins over the others");
  assert.deepEqual(resolveIn("no-scenario", { working: true, tools: true }), { source: "project", version: "1.0.0-working" }, "the working directory wins over the tool directory");
  assert.deepEqual(resolveIn("tools-only", { tools: true }), { source: "roborepo", version: "1.0.0-tools" }, "the tool directory is the last resort");
  assert.equal(resolveIn("none", {}), null, "nothing installed resolves to nothing");

  // ---- The provider searches the scenario's directory before the one the command ran from ----
  const { scenarioDir, workingDir, stateRoot } = layout("provider", {});
  const scenarioPath = path.join(scenarioDir, "observe.mjs");
  fs.writeFileSync(scenarioPath, "export default async () => {};\n");
  const blocked = await playwrightProvider.run({ scenarioPath, capture: [], stateRoot, cwd: workingDir, timeoutMs: 1_000 });
  assert.equal(blocked.status, STATUS.BLOCKED);
  const message = blocked.limitations.join("\n");
  assert.ok(message.indexOf(scenarioDir) >= 0 && message.indexOf(scenarioDir) < message.indexOf(workingDir), `the scenario's directory is searched first: ${message}`);

  console.log("ok: browser playwright resolution (scenario project, then working directory, then tool directory)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function layout(name, present) {
  const root = path.join(tempRoot, name);
  const scenarioProject = path.join(root, "scenario-project");
  const dirs = { scenarioDir: path.join(scenarioProject, "scripts"), workingDir: path.join(root, "working-project"), stateRoot: path.join(root, "state") };
  fs.mkdirSync(dirs.scenarioDir, { recursive: true });
  fs.mkdirSync(dirs.workingDir, { recursive: true });
  if (present.scenario) fakePlaywright(scenarioProject, "1.0.0-scenario");
  if (present.working) fakePlaywright(dirs.workingDir, "1.0.0-working");
  if (present.tools) fakePlaywright(toolsDir(dirs.stateRoot), "1.0.0-tools");
  return dirs;
}

function resolveIn(name, present) {
  const { scenarioDir, workingDir, stateRoot } = layout(name, present);
  const resolved = resolvePlaywright({ fromDirs: [scenarioDir, workingDir], stateRoot });
  return resolved && { source: resolved.source, version: resolved.version };
}

function fakePlaywright(base, version) {
  const dir = path.join(base, "node_modules", "playwright");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "playwright", version }));
  return dir;
}
