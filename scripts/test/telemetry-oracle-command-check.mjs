import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatOracleResult, oracleExitCode } from "../cli/telemetry-oracle-command.mjs";
import { createOracleResult, emptyOracleResult } from "../cli/telemetry-schemas/oracle-result-schema.mjs";

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

// The readable output adds a line only when it has something to explain.
function checkConditionalLines() {
  const metadata = { checked_at: "2026-10-01T18:22:31.000Z", duration_ms: 1234 };
  const checks = ["sessions", "operations", "conditions", "boundaries", "gating", "regression", "loops"];
  const base = { event_count: 1200, session_count: 3, operation_count: 900,
    coverage: { supported_events: 1200, unsupported_events: 0, comparable: true, complete: true, issues: [], checks } };
  const failed = formatOracleResult(createOracleResult({ ...base, status: "failed", differences: ["conditions", "regression"] }, metadata));
  assert.match(failed, /^Oracle check: Failed$/m);
  assert.match(failed, /^Evidence: 1,200 events · 3 sessions · 900 operations$/m);
  assert.match(failed, /^Differences: conditions, regression$/m);
  assert.match(failed, /^Duration: 1,234 ms$/m);
  assert.doesNotMatch(failed, /^(Issues|Error):/m);

  const partial = formatOracleResult(createOracleResult({ ...base, status: "partial", differences: [], event_count: 1200,
    coverage: { ...base.coverage, supported_events: 1190, unsupported_events: 10, complete: false,
      issues: [{ category: "unknown_model", count: 7 }, { category: "skipped_evidence", count: 2 }] } }, metadata));
  assert.match(partial, /^Oracle check: Partial$/m);
  assert.match(partial, /^Issues: unknown_model \(7\), skipped_evidence \(2\)$/m);
  assert.doesNotMatch(partial, /^(Differences|Error):/m);

  const readError = formatOracleResult(createOracleResult(emptyOracleResult("evidence_read_error"), metadata));
  assert.match(readError, /^Oracle check: Unavailable$/m);
  assert.match(readError, /^Error: evidence_read_error$/m);
  assert.doesNotMatch(readError, /^(Checked|Differences|Issues):/m, "a check that never ran lists nothing it checked");
}

function run(args = []) {
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_ROOT: stateDir };
  return spawnSync(process.execPath, [cli, "telemetry", "oracle", ...args], { cwd: repoRoot, env, encoding: "utf8" });
}

try {
  assert.deepEqual(["passed", "failed", "partial", "unavailable"].map(oracleExitCode), [0, 1, 2, 2]);
  assert.equal(oracleExitCode("unknown"), 2, "an unrecognized status is inconclusive, never a pass");
  checkConditionalLines();

  fs.mkdirSync(spoolDir, { recursive: true });
  let result = run();
  assert.equal(result.status, 2, `empty spool is inconclusive:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^Oracle check: Unavailable$/m);
  const empty = JSON.parse(run(["--json"]).stdout);
  assert.deepEqual([empty.status, empty.event_count, empty.coverage.comparable, empty.coverage.complete],
    ["unavailable", 0, false, false], "an empty spool never reports comparable or complete coverage");

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
