import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-worker-"));
const paths = { spoolDir: path.join(root, "spool"), markersPath: path.join(root, "markers.jsonl"),
  snapshotsDir: path.join(root, "snapshots"), registryPath: path.join(root, "registry.json") };
const signature = `sha256:${"a".repeat(64)}`;
const secret = "PRIVATE-PROMPT /private/path SECRET-COMMAND";
const snapshot = { schema: 2, snapshot_id: "cfg", packages: [], skills: [], evaluability: { packages: true, skills: true } };
const event = { schema: 3, capture_id: "capture", call_id: "call", harness: "claude", session_id: "session",
  event: "PostToolUse", ts: "2026-09-15T12:00:00.000Z", config_snapshot_id: "cfg",
  repo: { repository_id: "git:example/repo" }, session: { model: "model" }, tool: { name: "Read" },
  last_result: { tool: "Read", chars: 100 }, tokens: { input: 100, output: 10, total: 110 }, prompt: { preview: secret } };
const spoolFile = path.join(paths.spoolDir, "capture.jsonl"), snapshotFile = path.join(paths.snapshotsDir, "cfg.json");
function write(file, value) { fs.writeFileSync(file, `${JSON.stringify(value)}\n`); }
async function run(workerPaths = paths) {
  const worker = new Worker(new URL("../cli/telemetry-oracle-worker.mjs", import.meta.url), {
    workerData: { paths: workerPaths, evidence_signature: signature }, stdout: true, stderr: true,
  });
  const messages = [], output = [];
  worker.stdout.on("data", (chunk) => output.push(chunk.toString()));
  worker.stderr.on("data", (chunk) => output.push(chunk.toString()));
  worker.on("message", (message) => messages.push(message));
  let code;
  const timeout = setTimeout(() => { void worker.terminate(); }, 10_000);
  try {
    code = await new Promise((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); });
  } finally { clearTimeout(timeout); }
  assert.equal(code, 0, "one-shot worker exits after publishing");
  assert.equal(messages.length, 1);
  assert.equal(output.join(""), "", "live runs never print evidence or CI diagnostics");
  const result = messages[0];
  assert.equal(result.schema, 1);
  assert.equal(result.evidence_signature, signature);
  assert.ok(Number.isFinite(Date.parse(result.checked_at)));
  assert.ok(result.duration_ms >= 0);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes(root));
  return result;
}
try {
  fs.mkdirSync(paths.spoolDir); fs.mkdirSync(paths.snapshotsDir);
  assert.equal((await run()).status, "unavailable", "empty evidence cannot pass");
  write(spoolFile, event); write(snapshotFile, snapshot);
  const passed = await run();
  assert.equal(passed.status, "passed");
  assert.equal(passed.event_count, 1); assert.equal(passed.operation_count, 1); assert.equal(passed.session_count, 1);
  const remote = "example/repo";
  write(paths.registryPath, { repositories: { repo: { id: "git:example/repo", normalizedRemote: remote } } });
  write(spoolFile, { ...event, repo: { normalized_remote_hash: createHash("sha256").update(remote).digest("hex").slice(0, 24) } });
  assert.equal((await run()).status, "passed", "both implementations interpret the same raw registry");
  fs.rmSync(paths.registryPath);
  assert.equal((await run()).status, "partial", "unresolved legacy identity cannot pass");
  write(spoolFile, event);
  for (const file of [spoolFile, paths.markersPath, path.join(paths.snapshotsDir, "broken.json"), paths.registryPath]) {
    fs.appendFileSync(file, "{broken JSON\n");
    const result = await run();
    assert.notEqual(result.status, "passed");
    assert.ok(result.coverage.issues.some(({ category, count }) => category === "skipped_evidence" && count === 1));
    if (file === spoolFile) write(spoolFile, event); else fs.rmSync(file);
  }
  fs.appendFileSync(spoolFile, "null\n");
  let result = await run();
  assert.equal(result.status, "unavailable", "parsed unsafe rows reach independent support accounting");
  assert.equal(result.event_count, 2); assert.equal(result.coverage.unsupported_events, 1);
  write(spoolFile, event);
  write(snapshotFile, { ...snapshot, schema: 99 });
  assert.equal((await run()).status, "unavailable", "raw unsupported snapshots are not silently discarded");
  write(snapshotFile, snapshot);
  write(path.join(paths.snapshotsDir, "second.json"), { ...snapshot, snapshot_id: "second" });
  fs.appendFileSync(spoolFile, `${JSON.stringify({ ...event, capture_id: "second", call_id: "second", config_snapshot_id: "second" })}\n`);
  result = await run();
  assert.equal(result.status, "partial", "a session changing snapshots retains the comparator's partial coverage");
  assert.ok(result.coverage.issues.some(({ category }) => category === "changing_session_snapshot"));
  write(spoolFile, event); fs.rmSync(path.join(paths.snapshotsDir, "second.json"));
  write(paths.markersPath, { schema: 99 });
  assert.equal((await run()).status, "unavailable", "parsed unsafe markers remain visible to coverage accounting");
  fs.rmSync(paths.markersPath);
  fs.appendFileSync(spoolFile, "\n{broken\n{also broken\n");
  fs.writeFileSync(paths.markersPath, "{broken\n");
  fs.writeFileSync(path.join(paths.snapshotsDir, "broken.json"), "{broken");
  result = await run();
  assert.equal(result.status, "partial");
  assert.equal(result.event_count, 1, "raw event count excludes unparseable lines");
  assert.deepEqual(result.coverage.issues, [{ category: "skipped_evidence", count: 4 }]);
  write(spoolFile, event); fs.rmSync(paths.markersPath); fs.rmSync(path.join(paths.snapshotsDir, "broken.json"));
  result = await run({ ...paths, spoolDir: snapshotFile });
  assert.equal(result.status, "unavailable");
  assert.equal(result.error_category, "evidence_read_error", "I/O failure is operational, never disagreement");
  console.log("telemetry oracle isolated worker checks passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
