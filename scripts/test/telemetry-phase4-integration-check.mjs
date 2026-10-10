#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Inferred phase
// tagging and intervening-work signals wired into the real capture hot path, exercised through the
// actual CLI process (matching telemetry-capture-v3-check.mjs's approach) so hook-stdin parsing,
// the session activity cursor, and transcript-derived exit_status/failure_signature are covered for
// real. This is the capture-time half: capture stores the raw signals; deriving cohort-level
// findings from them happens at analysis time.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-telemetry-phase4-"));
try {
  enable();
  testFullSuiteFailureIsDebuggingPhaseWithFailSignature();
  testRerunWithUnchangedFailureSignatureIsDetected();
  testEditAfterFailureFlipsInterveningEditSinceLastTest();
  testDiscoveryPhaseFromReadOnlyActivity();
  console.log("telemetry phase4 integration checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function env() {
  return { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo") };
}

function enable() {
  const result = spawnSync(process.execPath, [cli, "telemetry", "enable"], { env: env(), encoding: "utf8" });
  assert.equal(result.status, 0, `telemetry enable failed:\n${result.stdout}\n${result.stderr}`);
}

function spoolRecords(harness = "claude") {
  const spoolPath = path.join(tmp, ".roborepo/telemetry/spool", `${harness}.jsonl`);
  return fs.readFileSync(spoolPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Appends one assistant tool_use + one user tool_result to a fake Claude transcript so
// transcriptStats() (which telemetry-capture.mjs reads to populate operation.exit_status/
// failure_signature) sees a real result for this call, matching real hook behavior where the
// transcript is the source of truth for tool outcomes, not hook stdin.
function appendTranscriptTurn(transcriptPath, { toolUseId, toolName, resultText, isError }) {
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-test", content: [{ type: "tool_use", id: toolUseId, name: toolName }] },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: resultText, is_error: isError }] },
    }),
  ];
  fs.appendFileSync(transcriptPath, lines.join("\n") + "\n");
}

function capture(payload, { harness = "claude", event }) {
  const result = spawnSync(process.execPath, [cli, "telemetry", "capture", "--harness", harness, "--event", event], {
    input: JSON.stringify(payload),
    env: env(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `capture failed:\n${result.stdout}\n${result.stderr}`);
}

function testFullSuiteFailureIsDebuggingPhaseWithFailSignature() {
  const sessionId = "sess-debug-fail";
  const transcriptPath = path.join(tmp, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, "");

  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath }, { event: "SessionStart" });
  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Bash", tool_use_id: "tu_full1", tool_input: { command: "npm test" } }, { event: "PreToolUse" });
  appendTranscriptTurn(transcriptPath, { toolUseId: "tu_full1", toolName: "Bash", resultText: "1 failing\nAssertionError: expected true to be false", isError: true });
  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Bash", tool_use_id: "tu_full1", tool_input: { command: "npm test" } }, { event: "PostToolUse" });

  const post = spoolRecords().filter((r) => r.session_id === sessionId).find((r) => r.event === "PostToolUse");
  assert.equal(post.operation.category, "test");
  assert.equal(post.operation.scope, "full");
  assert.equal(post.operation.exit_status, "fail", "a failing transcript result must set operation.exit_status");
  assert.match(post.operation.failure_signature, /^[a-f0-9]{24}$/, "a failure must produce a hashed failure_signature");
  assert.equal(post.phase.name, "debugging", "a failing full-suite test run must infer the debugging phase");
  assert.equal(post.phase.source, "inferred");

  // Privacy: raw failure text must never appear anywhere in the persisted spool line.
  const raw = fs.readFileSync(path.join(tmp, ".roborepo/telemetry/spool/claude.jsonl"), "utf8");
  assert.ok(!raw.includes("AssertionError: expected true to be false"), "raw failure output must never be persisted");
}

function testRerunWithUnchangedFailureSignatureIsDetected() {
  const sessionId = "sess-redundant-rerun";
  const transcriptPath = path.join(tmp, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, "");

  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath }, { event: "SessionStart" });

  // First full-suite failure.
  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Bash", tool_use_id: "tu_r1", tool_input: { command: "npm test" } }, { event: "PreToolUse" });
  appendTranscriptTurn(transcriptPath, { toolUseId: "tu_r1", toolName: "Bash", resultText: "same failure every time", isError: true });
  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Bash", tool_use_id: "tu_r1", tool_input: { command: "npm test" } }, { event: "PostToolUse" });

  // Second full-suite run, identical failure text, no intervening edit — the redundant-rerun case
  // the "full-suite reruns with the same failure signature" finding depends on.
  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Bash", tool_use_id: "tu_r2", tool_input: { command: "npm test" } }, { event: "PreToolUse" });
  appendTranscriptTurn(transcriptPath, { toolUseId: "tu_r2", toolName: "Bash", resultText: "same failure every time", isError: true });
  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Bash", tool_use_id: "tu_r2", tool_input: { command: "npm test" } }, { event: "PostToolUse" });

  const posts = spoolRecords().filter((r) => r.session_id === sessionId && r.event === "PostToolUse");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].operation.failure_signature, posts[1].operation.failure_signature, "identical failure text must hash to the identical signature");
  assert.equal(posts[1].intervening.failure_signature_changed, false, "a rerun with the same failure signature must be flagged as unchanged");
  assert.equal(posts[1].intervening.edit_since_last_test, false, "no edit occurred between the two runs");
}

function testEditAfterFailureFlipsInterveningEditSinceLastTest() {
  const sessionId = "sess-edit-after-fail";
  const transcriptPath = path.join(tmp, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, "");

  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath }, { event: "SessionStart" });

  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Bash", tool_use_id: "tu_e1", tool_input: { command: "npm test" } }, { event: "PreToolUse" });
  appendTranscriptTurn(transcriptPath, { toolUseId: "tu_e1", toolName: "Bash", resultText: "failure one", isError: true });
  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Bash", tool_use_id: "tu_e1", tool_input: { command: "npm test" } }, { event: "PostToolUse" });

  // An edit completes after the failure — this must be reflected in the next capture's intervening
  // signal.
  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Edit", tool_use_id: "tu_edit1", tool_input: { file_path: "src/thing.js" } }, { event: "PreToolUse" });
  appendTranscriptTurn(transcriptPath, { toolUseId: "tu_edit1", toolName: "Edit", resultText: "ok", isError: false });
  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Edit", tool_use_id: "tu_edit1", tool_input: { file_path: "src/thing.js" } }, { event: "PostToolUse" });

  const editPost = spoolRecords().filter((r) => r.session_id === sessionId && r.event === "PostToolUse").pop();
  assert.equal(editPost.tool.name, "Edit");
  assert.equal(editPost.intervening.edit_since_last_test, true, "an edit occurring after a test failure must set edit_since_last_test");
  assert.equal(editPost.intervening.changed_file_count, 1);
  assert.deepEqual(editPost.intervening.changed_file_categories, ["code"]);
}

function testDiscoveryPhaseFromReadOnlyActivity() {
  const sessionId = "sess-discovery";
  const transcriptPath = path.join(tmp, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, "");

  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath }, { event: "SessionStart" });
  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Read", tool_use_id: "tu_read1" }, { event: "PreToolUse" });
  appendTranscriptTurn(transcriptPath, { toolUseId: "tu_read1", toolName: "Read", resultText: "file contents", isError: false });
  capture({ session_id: sessionId, cwd: repoRoot, transcript_path: transcriptPath, tool_name: "Read", tool_use_id: "tu_read1" }, { event: "PostToolUse" });

  const post = spoolRecords().filter((r) => r.session_id === sessionId && r.event === "PostToolUse").pop();
  assert.equal(post.phase.name, "discovery", "read-only activity with no edits must infer discovery");
  assert.equal(post.intervening.changed_file_count, 0);
}
