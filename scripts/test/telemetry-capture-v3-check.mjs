#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// capture_id/call_id,
// call-aware duration pairing, config snapshot references, and operation classification wired into
// the real capture hot path (telemetry-capture.mjs), exercised through the actual CLI process so
// hook-stdin parsing and the collector-dir cursor files are covered for real — not just the pure
// schema validators (telemetry-schemas-check.mjs) or the pure classifier (telemetry-classify-check.mjs).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-telemetry-capture-v3-"));
try {
  enable();
  testSessionStartBuildsSnapshotReusedByLaterCaptures();
  testCallAwareDurationPairingSurvivesConcurrentCalls();
  testDerivedCallIdForHarnessWithoutToolUseId();
  testOperationClassificationOnBashCommand();
  testRawCommandNeverPersisted();
  console.log("telemetry capture v3 checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function env() {
  return { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo") };
}

function capture(payload, { harness = "claude", event }) {
  const result = spawnSync(process.execPath, [cli, "telemetry", "capture", "--harness", harness, "--event", event], {
    input: JSON.stringify(payload),
    env: env(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `capture failed:\n${result.stdout}\n${result.stderr}`);
}

function spoolRecords(harness = "claude") {
  const spoolPath = path.join(tmp, ".roborepo/telemetry/spool", `${harness}.jsonl`);
  return fs.readFileSync(spoolPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function enable() {
  const result = spawnSync(process.execPath, [cli, "telemetry", "enable"], { env: env(), encoding: "utf8" });
  assert.equal(result.status, 0, `telemetry enable failed:\n${result.stdout}\n${result.stderr}`);
}

function testSessionStartBuildsSnapshotReusedByLaterCaptures() {
  capture({ session_id: "sess-snapshot", cwd: repoRoot }, { event: "SessionStart" });
  capture({ session_id: "sess-snapshot", cwd: repoRoot, tool_name: "Read", tool_use_id: "tu_1" }, { event: "PreToolUse" });

  const records = spoolRecords().filter((r) => r.session_id === "sess-snapshot");
  assert.equal(records.length, 2);
  assert.match(records[0].config_snapshot_id, /^cfg_[a-f0-9]{24}$/, "SessionStart must build a real snapshot id");
  assert.equal(records[0].config_snapshot_id, records[1].config_snapshot_id, "later captures in the same session must reuse the cached snapshot id");
  assert.equal(records[0].schema, 3);
  assert.match(records[0].capture_id, /^cap_[a-f0-9]{16}$/);

  const snapshotFile = path.join(tmp, ".roborepo/telemetry/snapshots", `${records[0].config_snapshot_id}.json`);
  assert.ok(fs.existsSync(snapshotFile), "the snapshot referenced by config_snapshot_id must actually be persisted");
}

function testCallAwareDurationPairingSurvivesConcurrentCalls() {
  // Regression fixture for call-aware pairing: two tool calls in the same
  // session overlapping in time (B starts before A ends) must not clobber each other's duration.
  capture({ session_id: "sess-concurrent", cwd: repoRoot, tool_name: "Read", tool_use_id: "call_A" }, { event: "PreToolUse" });
  capture({ session_id: "sess-concurrent", cwd: repoRoot, tool_name: "Bash", tool_use_id: "call_B", tool_input: { command: "echo hi" } }, { event: "PreToolUse" });
  capture({ session_id: "sess-concurrent", cwd: repoRoot, tool_name: "Read", tool_use_id: "call_A" }, { event: "PostToolUse" });
  capture({ session_id: "sess-concurrent", cwd: repoRoot, tool_name: "Bash", tool_use_id: "call_B", tool_input: { command: "echo hi" } }, { event: "PostToolUse" });

  const records = spoolRecords().filter((r) => r.session_id === "sess-concurrent");
  const postA = records.find((r) => r.event === "PostToolUse" && r.call_id === "call_A");
  const postB = records.find((r) => r.event === "PostToolUse" && r.call_id === "call_B");
  assert.ok(postA && postB, "both concurrent calls must produce a matched PostToolUse record");
  assert.equal(typeof postA.duration_ms, "number", "call_A's duration must be resolved from its own cursor, not overwritten by call_B's PreToolUse");
  assert.equal(typeof postB.duration_ms, "number");
}

function testDerivedCallIdForHarnessWithoutToolUseId() {
  // No tool_use_id/call_id on stdin at all (harness that doesn't supply one) — two sequential
  // same-tool calls in one session must still get distinct derived ids, not collide.
  capture({ session_id: "sess-derived", cwd: repoRoot, tool_name: "Read" }, { harness: "codex", event: "PreToolUse" });
  capture({ session_id: "sess-derived", cwd: repoRoot, tool_name: "Read" }, { harness: "codex", event: "PostToolUse" });
  capture({ session_id: "sess-derived", cwd: repoRoot, tool_name: "Read" }, { harness: "codex", event: "PreToolUse" });
  capture({ session_id: "sess-derived", cwd: repoRoot, tool_name: "Read" }, { harness: "codex", event: "PostToolUse" });

  const records = spoolRecords("codex").filter((r) => r.session_id === "sess-derived");
  const posts = records.filter((r) => r.event === "PostToolUse");
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].call_id, posts[1].call_id, "sequential same-tool calls must get distinct derived call ids");
  assert.equal(typeof posts[0].duration_ms, "number");
  assert.equal(typeof posts[1].duration_ms, "number");
}

function testOperationClassificationOnBashCommand() {
  capture({ session_id: "sess-op", cwd: repoRoot, tool_name: "Bash", tool_use_id: "tu_op", tool_input: { command: "npm test" } }, { event: "PreToolUse" });
  const record = spoolRecords().find((r) => r.session_id === "sess-op");
  assert.equal(record.operation.category, "test");
  assert.equal(record.operation.scope, "full");
  assert.equal(record.operation.runner, "npm");
}

function testRawCommandNeverPersisted() {
  capture({ session_id: "sess-priv", cwd: repoRoot, tool_name: "Bash", tool_use_id: "tu_priv", tool_input: { command: "echo super-secret-token-xyz" } }, { event: "PreToolUse" });
  const spoolPath = path.join(tmp, ".roborepo/telemetry/spool/claude.jsonl");
  const raw = fs.readFileSync(spoolPath, "utf8");
  assert.ok(!raw.includes("super-secret-token-xyz"), "raw command text must never appear in the spool");
}
