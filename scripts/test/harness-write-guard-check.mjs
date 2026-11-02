#!/usr/bin/env node
// harness-write-guard.mjs: a roborepo state root in a temporary directory with a real HOME must not
// write harness config, because the paths it embeds vanish with the temporary directory. Each case
// runs in a child process because STATE_ROOT is fixed when roots.mjs loads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const guard = path.join(repoRoot, "scripts", "cli", "harness-write-guard.mjs");
const cli = path.join(repoRoot, "scripts", "cli", "main.mjs");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-write-guard-"));
// A HOME outside every temporary directory, standing in for the user's real one. Nothing is written
// to it: each blocked case must stop before the first write.
const realHome = os.homedir();

function run(args, env) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, ROBOREPO_STATE_ROOT: "", ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function blockReason(env, target = "") {
  const script = `import(${JSON.stringify(guard)}).then((g) => console.log(g.harnessWriteBlockReason(${target ? JSON.stringify(target) : "null"}) ?? "allowed"))`;
  return run(["-e", script], env).output.trim();
}

try {
  const tempState = { HOME: realHome, ROBOREPO_STATE_ROOT: path.join(scratch, "state") };
  assert.match(blockReason(tempState), /^refusing to write harness config/, "temporary state with a real HOME is blocked");
  assert.match(
    blockReason(tempState, path.join(realHome, ".claude", "settings.json")),
    /^refusing to write .*settings\.json/,
    "a write into the real HOME is blocked",
  );
  assert.equal(
    blockReason(tempState, path.join(scratch, "fixture", "settings.json")),
    "allowed",
    "a write outside HOME (a test fixture) is allowed",
  );

  const isolated = { HOME: path.join(scratch, "home"), ROBOREPO_STATE_ROOT: path.join(scratch, "home", ".roborepo") };
  assert.equal(blockReason(isolated), "allowed", "temporary state with a temporary HOME is allowed");
  assert.equal(blockReason({ HOME: realHome, ROBOREPO_STATE_ROOT: "" }), "allowed", "the default state root is allowed");

  const direct = run([guard], tempState);
  assert.equal(direct.status, 1, "the installer pre-check exits 1 when blocked");
  assert.match(direct.output, /Point HOME at an isolated directory/, "the pre-check names the fix");

  const enable = run([cli, "package", "enable", "react"], tempState);
  assert.notEqual(enable.status, 0, "package enable refuses under temporary state with a real HOME");
  assert.match(enable.output, /refusing to write harness config/, "package enable reports the guard reason");
  const dryRun = run([cli, "package", "enable", "react", "--dry-run"], tempState);
  assert.doesNotMatch(dryRun.output, /refusing to write/, "a dry run is not blocked");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log("harness-write-guard ok");
