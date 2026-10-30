import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEvidenceSnapshot } from "../cli/telemetry-oracle-evidence.mjs";
import { runOracleCheck } from "../cli/telemetry-oracle-command.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-evidence-"));
const paths = { spoolDir: path.join(root, "spool"), markersPath: path.join(root, "markers.jsonl"),
  snapshotsDir: path.join(root, "snapshots") };
const secret = "PRIVATE-PROMPT /private/path SECRET-COMMAND";
const snapshot = { schema: 2, snapshot_id: "cfg", packages: [], skills: [], evaluability: { packages: true, skills: true } };
const event = { schema: 3, capture_id: "capture", call_id: "call", harness: "claude", session_id: "session",
  event: "PostToolUse", ts: "2026-09-15T12:00:00.000Z", config_snapshot_id: "cfg",
  repo: { repository_id: "git:example/repo" }, session: { model: "model" }, tool: { name: "Read" },
  last_result: { tool: "Read", chars: 100 }, tokens: { input: 100, output: 10, total: 110 }, prompt: { preview: secret } };
const spoolFile = path.join(paths.spoolDir, "capture.jsonl"), snapshotFile = path.join(paths.snapshotsDir, "cfg.json");
function write(file, value) { fs.writeFileSync(file, `${JSON.stringify(value)}\n`); }
function run(checkPaths = paths) {
  const result = runOracleCheck(checkPaths);
  assert.equal(result.schema, 1);
  assert.ok(Number.isFinite(Date.parse(result.checked_at)));
  assert.ok(result.duration_ms >= 0);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes(root));
  return result;
}
try {
  fs.mkdirSync(paths.spoolDir); fs.mkdirSync(paths.snapshotsDir);
  assert.equal(run().status, "unavailable", "empty evidence cannot pass");
  write(spoolFile, event); write(snapshotFile, snapshot);
  const passed = run();
  assert.equal(passed.status, "passed");
  assert.equal(passed.event_count, 1); assert.equal(passed.operation_count, 1); assert.equal(passed.session_count, 1);
  const [read] = readEvidenceSnapshot(paths).events;
  assert.deepEqual(read.spool_provenance, { source: "spool:capture.jsonl", sequence: 1 });
  assert.equal(Object.keys(read).includes("spool_provenance"), false, "provenance never becomes a persisted field");

  const stores = [[spoolFile, "malformed_events"], [paths.markersPath, "malformed_markers"],
    [path.join(paths.snapshotsDir, "broken.json"), "malformed_snapshots"]];
  for (const [file, category] of stores) {
    fs.appendFileSync(file, "{broken JSON\n");
    assert.equal(readEvidenceSnapshot(paths).options.skippedEvidence[category], 1, `${category} is counted per store`);
    const result = run();
    assert.notEqual(result.status, "passed");
    assert.ok(result.coverage.issues.some(({ category: issue, count }) => issue === "skipped_evidence" && count === 1));
    if (file === spoolFile) write(spoolFile, event); else fs.rmSync(file);
  }

  fs.appendFileSync(spoolFile, "null\n");
  let result = run();
  assert.equal(result.status, "unavailable", "parsed unsafe rows reach independent support accounting");
  assert.equal(result.event_count, 2); assert.equal(result.coverage.unsupported_events, 1);
  write(spoolFile, event);
  write(snapshotFile, { ...snapshot, schema: 99 });
  assert.equal(run().status, "unavailable", "raw unsupported snapshots are not silently discarded");
  write(snapshotFile, snapshot);
  write(path.join(paths.snapshotsDir, "second.json"), { ...snapshot, snapshot_id: "second" });
  fs.appendFileSync(spoolFile, `${JSON.stringify({ ...event, capture_id: "second", call_id: "second", config_snapshot_id: "second" })}\n`);
  result = run();
  assert.equal(result.status, "partial", "a session changing snapshots retains the comparator's partial coverage");
  assert.ok(result.coverage.issues.some(({ category }) => category === "changing_session_snapshot"));
  write(spoolFile, event); fs.rmSync(path.join(paths.snapshotsDir, "second.json"));
  write(paths.markersPath, { schema: 99 });
  assert.equal(run().status, "unavailable", "parsed unsafe markers remain visible to coverage accounting");
  fs.rmSync(paths.markersPath);

  fs.appendFileSync(spoolFile, "\n{broken\n{also broken\n");
  fs.writeFileSync(paths.markersPath, "{broken\n");
  fs.writeFileSync(path.join(paths.snapshotsDir, "broken.json"), "{broken");
  result = run();
  assert.equal(result.status, "partial");
  assert.equal(result.event_count, 1, "raw event count excludes unparseable lines");
  assert.deepEqual(result.coverage.issues, [{ category: "skipped_evidence", count: 4 }]);
  write(spoolFile, event); fs.rmSync(paths.markersPath); fs.rmSync(path.join(paths.snapshotsDir, "broken.json"));

  assert.throws(() => readEvidenceSnapshot({ ...paths, spoolDir: snapshotFile }), "the reader never hides I/O failure");
  result = run({ ...paths, spoolDir: snapshotFile });
  assert.equal(result.status, "unavailable");
  assert.equal(result.error_category, "evidence_read_error", "I/O failure is operational, never disagreement");
  console.log("telemetry oracle evidence reader checks passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
