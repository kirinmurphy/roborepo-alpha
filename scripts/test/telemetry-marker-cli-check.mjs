#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// `telemetry mark`
// and `telemetry experiment start|end|status`, end to end through the real CLI process (so
// git-identity resolution, snapshot creation, and persistence all run for real, matching how a
// user would invoke it — not just the pure schema validators covered by telemetry-schemas-check.mjs).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-telemetry-marker-cli-"));
try {
  testMarkerCreation();
  testMarkerValidationErrors();
  testExperimentLifecycle();
  console.log("telemetry marker/experiment CLI checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function run(args) {
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo") };
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, env, encoding: "utf8" });
}

function testMarkerCreation() {
  const result = run(["telemetry", "mark", "--type", "change", "--title", "Prevent full-suite debugging loops", "--package", "test-harness", "--metric", "test.full_suite_calls_per_debug_phase", "--expect", "decrease"]);
  assert.equal(result.status, 0, `mark failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^marker: mark_[a-f0-9]{16}$/m, "must print the created marker id");
  // Regression check for the config_snapshot_id format bug: marker-schema.mjs originally validated
  // snapshot ids against the generic 16-hex generateId() format, but computeSnapshotId produces a
  // 24-hex content hash — every real marker with a resolved snapshot failed validation until fixed.
  assert.match(result.stdout, /snapshot: cfg_[a-f0-9]{24}/, "snapshot id must be a real 24-hex content hash, not rejected as invalid");
}

function testMarkerValidationErrors() {
  const badType = run(["telemetry", "mark", "--type", "bogus", "--title", "x"]);
  assert.equal(badType.status, 2);
  assert.match(badType.stderr, /--type is required/);

  const missingStatus = run(["telemetry", "mark", "--type", "outcome", "--title", "x"]);
  assert.equal(missingStatus.status, 2);
  assert.match(missingStatus.stderr, /outcome markers require --status/);

  const unknownFlag = run(["telemetry", "mark", "--type", "note", "--title", "x", "--bogus"]);
  assert.equal(unknownFlag.status, 2);
  assert.match(unknownFlag.stderr, /unknown argument: --bogus/);
}

function testExperimentLifecycle() {
  const start = run(["telemetry", "experiment", "start", "--title", "Test-harness guidance v2", "--metric", "test.full_suite_calls_per_debug_phase", "--expect", "decrease", "--guardrail", "outcome.completion_rate", "--minimum-sessions", "5"]);
  assert.equal(start.status, 0, `experiment start failed:\n${start.stdout}\n${start.stderr}`);
  const experimentId = /^experiment: (exp_[a-f0-9]{16})$/m.exec(start.stdout)?.[1];
  assert.ok(experimentId, "experiment start must print the created experiment id");

  const statusRunning = run(["telemetry", "experiment", "status", experimentId]);
  assert.equal(statusRunning.status, 0);
  assert.match(statusRunning.stdout, /\[running\]/);

  const end = run(["telemetry", "experiment", "end", experimentId]);
  assert.equal(end.status, 0, `experiment end failed:\n${end.stdout}\n${end.stderr}`);

  const endAgain = run(["telemetry", "experiment", "end", experimentId]);
  assert.equal(endAgain.status, 1, "ending an already-ended experiment must fail");
  assert.match(endAgain.stderr, /already ended/);

  const statusEnded = run(["telemetry", "experiment", "status", experimentId]);
  assert.equal(statusEnded.status, 0);
  assert.match(statusEnded.stdout, /\[ended\]/);

  // export must include markers (start/end), the experiment definition, and the dedup'd snapshot.
  const exported = run(["telemetry", "export"]);
  assert.equal(exported.status, 0);
  const data = JSON.parse(exported.stdout);
  assert.ok(data.experiments.some((e) => e.experiment_id === experimentId));
  assert.ok(data.markers.length >= 2, "expected at least start+end markers across both tests");
}
