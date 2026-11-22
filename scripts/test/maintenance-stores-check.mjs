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
const DAY_MS = 24 * 60 * 60 * 1000;

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

  // ---- --dry-run previews a file-set reset and removes nothing ----
  const beforePreview = fs.readdirSync(snapshots).length;
  for (let i = 0; i < 40; i += 1) {
    fs.writeFileSync(path.join(snapshots, `extra_${i}.json`), JSON.stringify({ blob: "z".repeat(200_000) }));
  }
  const snapPreview = run(["reset", "telemetry-snapshots", "--dry-run"]);
  assert.equal(snapPreview.status, 0);
  assert.match(snapPreview.stdout, /would remove \d+ file\(s\).*dry run, nothing removed/, "a file-set preview says what would go");
  assert.equal(fs.readdirSync(snapshots).length, beforePreview + 40, "a dry run removes no file");
  const logPreview = run(["reset", "telemetry-spool-claude", "--all", "--dry-run"]);
  assert.match(logPreview.stdout, /would clear nothing \(absent\)/, "a log --all preview reports what it would clear");

  // ---- The scratch store: a folder set judged by the newest change inside each folder ----
  const scratch = path.join(tempRoot, "scratch");
  const outside = path.join(tempRoot, "outside-target");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");
  const old = new Date(Date.now() - 30 * DAY_MS);
  const oldFolder = makeFolder("old-plan", old);
  makeFolder("recent-topic", new Date());
  const nestedFolder = makeFolder("old-folder-new-file", old);
  // A file edited deep inside an old folder: the folder's own time does not move with it.
  const nestedFile = path.join(nestedFolder, "deep", "notes.md");
  fs.mkdirSync(path.dirname(nestedFile));
  fs.writeFileSync(nestedFile, "still in use");
  fs.utimesSync(path.join(nestedFolder, "deep"), old, old);
  fs.utimesSync(nestedFolder, old, old);
  fs.symlinkSync(outside, path.join(scratch, "link-out"));

  const scratchPreview = run(["reset", "scratch", "--dry-run"]);
  assert.equal(scratchPreview.status, 0);
  assert.match(scratchPreview.stdout, /would remove 1 folder\(s\) \(age\)/, "only the old folder would go");
  assert.match(scratchPreview.stdout, /old-plan/);
  assert.doesNotMatch(scratchPreview.stdout, /old-folder-new-file|recent-topic|link-out/, "folders with recent content are kept");
  assert.ok(fs.existsSync(oldFolder), "a dry run removes nothing");

  const allPreview = run(["reset", "scratch", "--all", "--dry-run"]);
  for (const name of ["old-plan", "recent-topic", "old-folder-new-file", "link-out"]) {
    assert.match(allPreview.stdout, new RegExp(name), `--all --dry-run lists ${name}`);
  }
  assert.match(allPreview.stdout, /would clear 4 entries/);
  assert.equal(fs.readdirSync(scratch).length, 4, "--all --dry-run removes nothing");

  const scratchReset = run(["reset", "scratch"]);
  assert.equal(scratchReset.status, 0);
  assert.match(scratchReset.stdout, /removed 1 folder\(s\)/);
  assert.deepEqual(fs.readdirSync(scratch).sort(), ["link-out", "old-folder-new-file", "recent-topic"], "the reset removes exactly the old folder");
  assert.ok(fs.existsSync(nestedFile), "a recently edited nested file keeps its folder");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "must survive", "a link's target is never touched");

  const scratchListed = run([]);
  assert.match(scratchListed.stdout.slice(scratchListed.stdout.indexOf("Agent scratch") - 200), /3 folder\(s\)/, "list counts scratch folders");

  assert.equal(run(["reset", "scratch", "--all"]).status, 0);
  assert.ok(!fs.existsSync(scratch), "--all clears the scratch store");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "must survive", "--all removes the link, not its target");

  // ---- Bad input is rejected with usage, not a stack trace ----
  const unknown = run(["reset", "not-a-store"]);
  assert.equal(unknown.status, 2, "an unknown store id exits 2");
  assert.ok(unknown.stderr.includes("known:"), "the error lists the valid ids");

  const badSub = run(["frobnicate"]);
  assert.equal(badSub.status, 2, "an unknown subcommand exits 2");
  assert.ok(badSub.stderr.includes("usage:"), "the error shows usage");

  console.log("ok: maintenance stores (list, reset, --all, --dry-run, --check, scratch folder set)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function makeFolder(name, at) {
  const folder = path.join(tempRoot, "scratch", name);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "file.txt");
  fs.writeFileSync(file, name);
  fs.utimesSync(file, at, at);
  fs.utimesSync(folder, at, at);
  return folder;
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
