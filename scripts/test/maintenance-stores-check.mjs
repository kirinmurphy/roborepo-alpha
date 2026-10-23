#!/usr/bin/env node
// `roborepo maintenance stores` — listing, policy-driven reset, --all, and the --check mode doctor
// calls.
//
// Driven as a subprocess under a sandboxed ROBOREPO_STATE_ROOT, because the module resolves every
// store path from state-paths.mjs at import time.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "scripts/cli/maintenance-stores.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-stores-cli-"));
const MB = 1024 * 1024;

try {
  // ---- Listing an empty state root still names every registered store ----
  const empty = run([]);
  assert.equal(empty.status, 0, "list succeeds against an empty state root");
  for (const id of ["developer-runtime-history", "telemetry-spool-claude", "capture-dense-bash-claude"]) {
    assert.ok(empty.stdout.includes(id), `list names ${id}`);
  }
  assert.ok(empty.stdout.includes(tempRoot), "list reports the state root it inspected");

  // ---- An over-cap store is reported by --check and fixed by reset ----
  const spool = path.join(tempRoot, "telemetry", "spool", "claude.jsonl");
  writeOversizedLog(spool, 26 * MB);

  const failing = run(["--check"]);
  assert.equal(failing.status, 1, "--check exits non-zero when a store is over its cap");
  assert.ok(failing.stderr.includes("telemetry-spool-claude"), "--check names the offending store");
  assert.ok(failing.stderr.includes("maintenance stores reset"), "--check names the fix");

  const reset = run(["reset", "telemetry-spool-claude"]);
  assert.equal(reset.status, 0);
  assert.ok(reset.stdout.includes("removed"), "reset reports what it removed");
  assert.ok(fs.statSync(spool).size <= 25 * MB, "reset brings the store under its cap");
  assert.ok(fs.statSync(spool).size > 0, "reset never empties a store");

  assert.equal(run(["--check"]).status, 0, "--check passes once the store is back within policy");

  // ---- Reset on a store already within policy is a no-op, not an error ----
  const second = run(["reset", "telemetry-spool-claude"]);
  assert.equal(second.status, 0);
  assert.ok(second.stdout.includes("already within policy"), "a compliant store says so");

  // ---- --all clears outright, unlike a policy reset ----
  const before = fs.statSync(spool).size;
  assert.ok(before > 0);
  const cleared = run(["reset", "telemetry-spool-claude", "--all"]);
  assert.equal(cleared.status, 0);
  assert.ok(cleared.stdout.includes("cleared"), "--all reports a clear, not a trim");
  assert.ok(!fs.existsSync(spool), "--all removes the store outright");

  // ---- File-set stores reset by removing files ----
  const snapshots = path.join(tempRoot, "telemetry", "snapshots");
  fs.mkdirSync(snapshots, { recursive: true });
  for (let i = 0; i < 40; i += 1) {
    fs.writeFileSync(path.join(snapshots, `cfg_${i}.json`), JSON.stringify({ blob: "z".repeat(200_000) }));
  }
  const snapReset = run(["reset", "telemetry-snapshots"]);
  assert.equal(snapReset.status, 0);
  const remaining = fs.readdirSync(snapshots).filter((name) => name.endsWith(".json"));
  assert.ok(remaining.length > 0 && remaining.length < 40, "oldest snapshot files are removed");

  // ---- Browser evidence is listed with its bound, and counts only evidence files ----
  const evidence = path.join(tempRoot, "browser", "evidence");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "20261021T000000Z-abc123-1-screenshot.png"), "png");
  fs.writeFileSync(path.join(evidence, "20261021T000000Z-abc123-2-video.webm"), "webm");
  fs.writeFileSync(path.join(evidence, "notes.txt"), "not evidence");
  const listed = run([]);
  const evidenceBlock = listed.stdout.slice(listed.stdout.indexOf("browser-evidence"));
  assert.ok(listed.stdout.includes("browser-evidence"), "list names the browser evidence store");
  assert.match(evidenceBlock, /bound 14d \/ 250\.0MB/, "the evidence store reports both bounds");
  assert.match(evidenceBlock, /2 file\(s\)/, "the evidence count ignores non-evidence files");

  // ---- Bad input is rejected with usage, not a stack trace ----
  const unknown = run(["reset", "not-a-store"]);
  assert.equal(unknown.status, 2, "an unknown store id exits 2");
  assert.ok(unknown.stderr.includes("known:"), "the error lists the valid ids");

  const badSub = run(["frobnicate"]);
  assert.equal(badSub.status, 2, "an unknown subcommand exits 2");
  assert.ok(badSub.stderr.includes("usage:"), "the error shows usage");

  console.log("ok: maintenance stores (list, reset, --all, --check)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ROBOREPO_STATE_ROOT: tempRoot },
    encoding: "utf8",
  });
}

// Chronological records, so trimming the oldest is meaningful rather than arbitrary.
function writeOversizedLog(filePath, targetBytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = fs.openSync(filePath, "w");
  try {
    let written = 0;
    let i = 0;
    while (written < targetBytes) {
      const line = JSON.stringify({
        ts: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
        pad: "x".repeat(4000),
      }) + "\n";
      fs.writeSync(handle, line);
      written += Buffer.byteLength(line, "utf8");
      i += 1;
    }
  } finally {
    fs.closeSync(handle);
  }
}
