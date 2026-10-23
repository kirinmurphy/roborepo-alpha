#!/usr/bin/env node
// write-log.mjs: every logged harness-config write names its trigger. Each case runs in a child
// process against a throwaway HOME and state root, because the log path is fixed when the module
// loads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const writeLog = path.join(repoRoot, "scripts", "cli", "write-log.mjs");
const cli = path.join(repoRoot, "scripts", "cli", "main.mjs");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-write-log-"));
const state = path.join(home, ".roborepo");
const logPath = path.join(state, "logs", "config-writes.jsonl");
const target = path.join(home, ".claude", "settings.json");
const env = (extra = {}) => ({ ...process.env, HOME: home, ROBOREPO_STATE_DIR: state, ROBOREPO_STATE_ROOT: "", ROBOREPO_WRITE_ACTOR: "", ...extra });
const entries = () => fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));

function node(script, extraEnv = {}, args = []) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, ...args], { encoding: "utf8", env: env(extraEnv) });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const importLog = `const log = await import(${JSON.stringify(writeLog)});`;

try {
  node(`${importLog} log.recordConfigWrite(${JSON.stringify(target)}, "first");`, { ROBOREPO_WRITE_ACTOR: "roborepo update" });
  let last = entries().at(-1);
  assert.equal(last.actor, "roborepo update", "an inherited ROBOREPO_WRITE_ACTOR names the outermost command");
  assert.equal(last.file, target);
  assert.equal(last.detail, "first");

  node(`${importLog} await log.runWithWriteActor("portal POST /api/config/packages", async () => { await new Promise((r) => setTimeout(r, 5)); log.recordConfigWrite(${JSON.stringify(target)}); });`,
    { ROBOREPO_WRITE_ACTOR: "roborepo web" });
  assert.equal(entries().at(-1).actor, "portal POST /api/config/packages", "a portal request names itself across awaits");

  const before = entries().length;
  node(`${importLog} log.recordConfigWrite(${JSON.stringify(path.join(repoRoot, "generated", "claude", "settings.json"))});`);
  assert.equal(entries().length, before, "writes to generated files inside the app are not logged");

  assert.equal(
    node(`${importLog} console.log(log.lastConfigWrite(${JSON.stringify(target)}).actor);`),
    "portal POST /api/config/packages",
    "lastConfigWrite returns the newest entry for the file",
  );

  const record = spawnSync(process.execPath, [writeLog, "record", target, "merge into local root config"], { encoding: "utf8", env: env({ ROBOREPO_WRITE_ACTOR: "roborepo update" }) });
  assert.equal(record.status, 0, record.stderr);
  last = entries().at(-1);
  assert.equal(last.detail, "merge into local root config", "the installer's record mode logs with a detail");
  assert.equal(last.actor, "roborepo update");

  const enable = spawnSync(process.execPath, [cli, "package", "enable", "react"], { encoding: "utf8", env: env() });
  assert.equal(enable.status, 0, enable.stderr);
  const registryWrite = entries().reverse().find((entry) => entry.file.endsWith("enabled-packages.json"));
  assert.equal(registryWrite?.actor, "roborepo package enable react", "a CLI command names itself");
  assert.equal(registryWrite?.detail, "enable react");

  fs.writeFileSync(logPath, "x".repeat(600 * 1024));
  node(`${importLog} log.recordConfigWrite(${JSON.stringify(target)});`);
  assert.ok(fs.existsSync(`${logPath}.1`), "an oversized log rotates to .1");
  assert.equal(entries().length, 1, "the fresh log starts with the new entry");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("write-log ok");
