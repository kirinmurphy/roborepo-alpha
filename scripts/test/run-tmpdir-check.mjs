#!/usr/bin/env node
// The test runners give each run its own TMPDIR and remove it when the run ends; a run first
// removes the folders of earlier runs whose process is gone, and never a live run's folder.
//
// Drives the real runner (run-checks.mjs on one small suite) under a temporary base folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { closeRunTmpdir, openRunTmpdir, runsRoot } from "./lib/run-tmpdir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-run-tmpdir-"));

try {
  const root = runsRoot(base);
  // A crashed run (its pid no longer exists) and a live one (this process).
  const crashed = path.join(root, "run-2147483646-1");
  const live = path.join(root, `run-${process.pid}-1`);
  fs.mkdirSync(path.join(crashed, "leftover"), { recursive: true });
  fs.mkdirSync(live, { recursive: true });
  // A suite that chmods a folder shut must not stop the removal.
  fs.chmodSync(path.join(crashed, "leftover"), 0o000);
  // A dead run's entry that is a link is removed as a link; its target keeps its permissions.
  const victim = path.join(base, "victim");
  fs.mkdirSync(path.join(victim, "inner"), { recursive: true });
  fs.chmodSync(victim, 0o755);
  fs.chmodSync(path.join(victim, "inner"), 0o755);
  fs.symlinkSync(victim, path.join(root, "run-2147483645-1"));

  const result = spawnSync(process.execPath, [path.join(here, "run-checks.mjs"), "--filter", "scratch-command-check"], {
    env: { ...process.env, TMPDIR: base, TEMP: base, TMP: base }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fs.readdirSync(root), [path.basename(live)], "the run removed its own folder and the crashed run's, and kept the live one");
  assert.equal(fs.statSync(victim).mode & 0o777, 0o755, "a link's target keeps its mode");
  assert.equal(fs.statSync(path.join(victim, "inner")).mode & 0o777, 0o755, "a link's target tree keeps its mode");

  // The folder a run gets is inside the runs root and is gone after close.
  const dir = openRunTmpdir({ base });
  assert.equal(path.dirname(dir), root);
  assert.equal(closeRunTmpdir(dir), true);
  assert.ok(!fs.existsSync(dir));
  assert.equal(closeRunTmpdir(base), false, "close refuses a folder the helper did not name");
  assert.ok(fs.existsSync(base));

  // An existing root made wider than 0700 is narrowed; a root replaced by a link is refused.
  if (process.platform !== "win32") {
    fs.chmodSync(root, 0o777);
    closeRunTmpdir(openRunTmpdir({ base }));
    assert.equal(fs.statSync(root).mode & 0o777, 0o700, "an existing wide root is made private");
  }
  const linkedBase = fs.mkdtempSync(path.join(base, "linked-"));
  fs.symlinkSync(victim, runsRoot(linkedBase));
  assert.throws(() => openRunTmpdir({ base: linkedBase }), /not a folder/, "a runs root replaced by a link is refused");

  console.log("ok: test runs use and remove their own TMPDIR, sweeping only finished runs");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
