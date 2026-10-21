import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { oracleExitCode } from "../cli/telemetry-oracle-command.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(repoRoot, "scripts", "cli", "main.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-command-"));
const stateDir = path.join(tmp, ".roborepo");
const spoolDir = path.join(stateDir, "telemetry", "spool"), snapshotsDir = path.join(stateDir, "telemetry", "snapshots");
const secret = "PRIVATE-PROMPT SECRET-COMMAND";
const snapshot = { schema: 2, snapshot_id: "cfg", packages: [], skills: [], evaluability: { packages: true, skills: true } };
const event = { schema: 3, capture_id: "capture", call_id: "call", harness: "claude", session_id: "session",
  event: "PostToolUse", ts: "2026-09-15T12:00:00.000Z", config_snapshot_id: "cfg",
  repo: { repository_id: "git:example/repo" }, session: { model: "model" }, tool: { name: "Read", input: { file_path: "/private/notes.md" } },
  last_result: { tool: "Read", chars: 100 }, tokens: { input: 100, output: 10, total: 110 }, prompt: { preview: secret } };
const RAW_FIELDS = ["capture_id", "call_id", "session_id", "harness", "prompt", "preview", "tool", "file_path", "repository_id", "tokens"];

function run(args = []) {
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: stateDir };
  return spawnSync(process.execPath, [cli, "telemetry", "oracle", ...args], { cwd: repoRoot, env, encoding: "utf8" });
}

try {
  assert.deepEqual(["passed", "failed", "partial", "unavailable"].map(oracleExitCode), [0, 1, 2, 2]);
  assert.equal(oracleExitCode("unknown"), 2, "an unrecognized status is inconclusive, never a pass");

  fs.mkdirSync(spoolDir, { recursive: true });
  let result = run();
  assert.equal(result.status, 2, `empty spool is inconclusive:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^Oracle check: Unavailable$/m);

  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.writeFileSync(path.join(spoolDir, "capture.jsonl"), `${JSON.stringify(event)}\n`);
  fs.writeFileSync(path.join(snapshotsDir, "cfg.json"), JSON.stringify(snapshot));
  result = run();
  assert.equal(result.status, 0, `supported spool passes:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^Oracle check: Passed$/m);
  assert.match(result.stdout, /^Evidence: 1 events · 1 sessions · 1 operations$/m);
  assert.match(result.stdout, /^Coverage: 1 supported · 0 unsupported$/m);
  assert.match(result.stdout, /^Checked: sessions, operations, conditions, boundaries, gating, regression, loops$/m);
  assert.match(result.stdout, /^Duration: [\d,]+ ms$/m);
  assert.doesNotMatch(result.stdout, /Differences:|Error:/);

  result = run(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.schema, 1);
  assert.equal(json.status, "passed");
  assert.equal(json.event_count, 1);
  for (const field of RAW_FIELDS) assert.equal(result.stdout.includes(`"${field}"`), false, `--json omits raw field ${field}`);
  for (const text of [secret, "/private/notes.md", tmp, "git:example/repo"]) {
    assert.equal(result.stdout.includes(text), false, `--json omits ${text}`);
  }

  result = run(["--verbose"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument: --verbose/);
  console.log("telemetry oracle command checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
