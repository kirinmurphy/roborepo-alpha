import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { startPortalServer } from "../cli/portal-server.mjs";
import { telemetryOracleEvidenceSignature } from "../cli/telemetry.mjs";
import { createTelemetryOracleObserver } from "../cli/telemetry-oracle-observer.mjs";

const sizeArgument = process.argv.indexOf("--size-mib");
const sizeMiB = sizeArgument === -1 ? 24 : Number(process.argv[sizeArgument + 1]);
if (!Number.isFinite(sizeMiB) || sizeMiB <= 0 || sizeMiB > 24) {
  throw new Error("usage: telemetry-oracle-runtime-check.mjs [--size-mib <number from 0 to 24>]");
}
const targetBytes = sizeMiB * 1024 * 1024;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-runtime-"));
const paths = { spoolDir: path.join(root, "spool"), snapshotsDir: path.join(root, "snapshots"),
  markersPath: path.join(root, "markers.jsonl"), registryPath: path.join(root, "registry.json") };
const workers = [];
const observer = createTelemetryOracleObserver({ readSignature: () => telemetryOracleEvidenceSignature(paths),
  createWorker(signature) {
    const worker = new Worker(new URL("../cli/telemetry-oracle-worker.mjs", import.meta.url), {
      workerData: { paths, evidence_signature: signature },
    });
    workers.push(worker); return worker;
  } });
let server;
try {
  fs.mkdirSync(paths.spoolDir); fs.mkdirSync(paths.snapshotsDir);
  fs.writeFileSync(path.join(paths.snapshotsDir, "cfg.json"), JSON.stringify({ schema: 2, snapshot_id: "cfg",
    packages: [], skills: [], evaluability: { packages: true, skills: true } }));
  const rows = []; let bytes = 0;
  while (bytes < targetBytes) {
    const index = rows.length;
    const line = JSON.stringify({ schema: 3, capture_id: `capture-${index}`, call_id: `call-${index}`, harness: "claude",
      session_id: `session-${Math.floor(index / 50)}`, event: "PostToolUse", ts: new Date(1_760_000_000_000 + index * 1000).toISOString(),
      config_snapshot_id: "cfg", repo: { repository_id: "git:example/repo" }, session: { model: "model" },
      tool: { name: "Read" }, last_result: { tool: "Read", chars: 100 },
      tokens: { input: index * 100, output: index * 10, total: index * 110 }, prompt: { preview: "synthetic ".repeat(180) } }) + "\n";
    rows.push(line); bytes += Buffer.byteLength(line);
  }
  fs.writeFileSync(path.join(paths.spoolDir, "claude.jsonl"), rows.join(""));
  const eventCount = rows.length; rows.length = 0;
  const port = await new Promise((resolve) => {
    server = startPortalServer({ port: 0, onListening(actualPort) { observer.start(); resolve(actualPort); } });
  });
  await new Promise((resolve, reject) => { workers[0].once("online", resolve); workers[0].once("error", reject); });
  let responsesWhileRunning = 0;
  const deadline = Date.now() + 35_000;
  while (workers[0].threadId !== -1 && Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/portal/status`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
    if (workers[0].threadId !== -1) responsesWhileRunning++;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(responsesWhileRunning >= 2, "lightweight portal requests complete while the real oracle worker runs");
  const health = observer.getHealth();
  assert.equal(health.status, "passed", JSON.stringify(health));
  assert.equal(health.event_count, eventCount); assert.equal(workers.length, 1); assert.equal(workers[0].threadId, -1);
  console.log(`telemetry oracle runtime: ${sizeMiB} MiB target, ${bytes} bytes, ${eventCount} events, ${health.duration_ms} ms, ${responsesWhileRunning} concurrent portal responses`);
} finally {
  await observer.stop();
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  fs.rmSync(root, { recursive: true, force: true });
}
