import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildEffectiveSnapshot } from "../cli/telemetry-schemas/snapshot-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conditions-cache-"));
const ready = path.join(tmp, "ready");
const state = path.join(tmp, "state");
const spool = path.join(state, "telemetry", "spool");
const snapshots = path.join(state, "telemetry", "snapshots");
fs.mkdirSync(spool, { recursive: true }); fs.mkdirSync(snapshots, { recursive: true });
const snapshot = buildEffectiveSnapshot({ packages: [{ id: "condition", enabled: true, resources: ["rules"] }], tools: [] }, { harness: "claude" });
const event = { schema: 3, harness: "claude", session_id: "s", capture_id: "cap_0000000000000001", call_id: "call", ts: "2026-09-01T00:00:00Z", config_snapshot_id: snapshot.snapshot_id, session: { model: "model" }, tokens: { input: 100, output: 10, total: 110 } };
fs.writeFileSync(path.join(spool, "claude.jsonl"), JSON.stringify(event) + "\n");
let output = "";
const child = spawn(process.execPath, [path.join(root, "scripts/cli/main.mjs"), "web", "--no-open", "--port", "0", "--allow-zero-port"], { cwd: root, env: { ...process.env, HOME: tmp, ROBOREPO_STATE_ROOT: state, PORTAL_READY_FILE: ready }, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (part) => { output += part; }); child.stderr.on("data", (part) => { output += part; });
try {
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(ready)) {
    if (child.exitCode != null || Date.now() > deadline) throw new Error(`test portal failed to start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const port = fs.readFileSync(ready, "utf8").match(/ready:(\d+)/)[1];
  const report = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/data`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const missing = await report();
  assert.equal(missing.conditions.data_quality.condition_coverage.packages.unknown, 1);
  const file = path.join(snapshots, `${snapshot.snapshot_id}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot));
  const available = await report();
  assert.notEqual(available.version, missing.version);
  assert.equal(available.conditions.data_quality.condition_coverage.packages.known, 1);
  fs.writeFileSync(file, JSON.stringify({ ...snapshot, evaluability: { packages: false, skills: true } }));
  const changed = await report();
  assert.notEqual(changed.version, available.version);
  assert.equal(changed.conditions.data_quality.condition_coverage.packages.unknown, 1);
  fs.unlinkSync(file);
  const evicted = await report();
  assert.equal(evicted.conditions.data_quality.condition_coverage.packages.unknown, 1);
  console.log("telemetry conditions cache: snapshot creation, content-only update and eviction refresh without a capture passed");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
