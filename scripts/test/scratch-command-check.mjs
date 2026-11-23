#!/usr/bin/env node
// `roborepo scratch <name>`: prints a folder in the scratch store, prunes the store on every call,
// never prunes the folder it hands back, and refuses names that are not one path segment.
//
// Driven through the real CLI under a temporary ROBOREPO_STATE_ROOT.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isBodyLocation } from "../cli/delivery.mjs";
import { bodyLocationNote } from "../cli/scratch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-scratch-cli-"));
const scratch = path.join(stateRoot, "scratch");
const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

try {
  // ---- A call creates the folder, prints only its path, and prunes old folders ----
  ageFolder("stale-topic");
  const opened = run(["gy8ncs9u"]);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(opened.stdout, `${path.join(scratch, "gy8ncs9u")}\n`, "stdout is the path alone");
  assert.ok(fs.statSync(path.join(scratch, "gy8ncs9u")).isDirectory(), "the named folder exists");
  assert.ok(!fs.existsSync(path.join(scratch, "stale-topic")), "an old folder is pruned by the call");
  assert.match(opened.stderr, /removed 1 folder/, "pruning is reported on stderr");

  // ---- Naming an old folder refreshes it instead of pruning it ----
  fs.mkdirSync(path.join(scratch, "returning-topic"));
  const notes = path.join(scratch, "returning-topic", "notes.md");
  fs.writeFileSync(notes, "earlier work");
  fs.utimesSync(notes, old, old);
  ageFolder("returning-topic");
  const returning = run(["returning-topic"]);
  assert.equal(returning.status, 0, returning.stderr);
  assert.equal(fs.readFileSync(path.join(scratch, "returning-topic", "notes.md"), "utf8"), "earlier work", "the named old folder survives with its contents");

  // ---- The byte cap never removes the folder being handed out ----
  // A sparse file counts its full size toward the 500 MB cap without using disk. Stamped in the
  // future, the big folder sorts newer than the one just touched, so the oldest-first byte walk
  // would pick the handed-out folder first.
  const big = path.join(scratch, "big-topic");
  fs.mkdirSync(big);
  fs.writeFileSync(path.join(big, "sparse.bin"), "");
  fs.truncateSync(path.join(big, "sparse.bin"), 600 * 1024 * 1024);
  const future = new Date(Date.now() + 60 * 60 * 1000);
  fs.utimesSync(path.join(big, "sparse.bin"), future, future);
  fs.utimesSync(big, future, future);
  const capped = run(["capped-topic"]);
  assert.equal(capped.status, 0, capped.stderr);
  assert.equal(capped.stdout, `${path.join(scratch, "capped-topic")}\n`);
  assert.ok(fs.existsSync(path.join(scratch, "capped-topic")), "the printed folder exists after pruning");
  fs.rmSync(big, { recursive: true });

  // ---- The byte cap removes quiet folders but spares one changed in the last hour ----
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const quiet = sparseFolder("over-cap-quiet", twoHoursAgo);
  const busy = sparseFolder("over-cap-busy", new Date());
  const overCap = run(["after-cap"]);
  assert.equal(overCap.status, 0, overCap.stderr);
  assert.ok(!fs.existsSync(quiet), "a folder quiet for two hours is removed by the byte cap");
  assert.ok(fs.existsSync(busy), "a folder changed in the last hour is spared although the store is still over the cap");
  fs.rmSync(busy, { recursive: true });

  // ---- Names that are not one path segment are refused, and nothing is created ----
  for (const bad of ["../escape", "a/b", "..", ".hidden", "", "with space"]) {
    const refused = run([bad]);
    assert.equal(refused.status, 2, `"${bad}" is refused`);
    assert.match(refused.stderr, /usage: roborepo scratch <name>/);
  }
  assert.ok(!fs.existsSync(path.join(stateRoot, "escape")), "a refused name creates nothing outside the store");
  assert.equal(run([]).status, 2, "a missing name is refused");

  // ---- A store root replaced by a link is refused, and the link's target is left alone ----
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-scratch-elsewhere-"));
  const swappedState = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-scratch-swapped-"));
  try {
    const victim = path.join(elsewhere, "old-folder");
    fs.mkdirSync(victim);
    fs.utimesSync(victim, old, old);
    fs.symlinkSync(elsewhere, path.join(swappedState, "scratch"));
    const swapped = spawnSync(process.execPath, [cli, "scratch", "probe"], {
      env: { ...process.env, ROBOREPO_STATE_ROOT: swappedState }, encoding: "utf8",
    });
    assert.equal(swapped.status, 1, "a linked store root is refused");
    assert.match(swapped.stderr, /is not a folder; refusing to use it/);
    assert.ok(fs.existsSync(victim), "nothing in the link's target is pruned");
    assert.ok(!fs.existsSync(path.join(elsewhere, "probe")), "nothing is created in the link's target");
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
    fs.rmSync(swappedState, { recursive: true, force: true });
  }

  // ---- A link under the name is not handed out ----
  fs.symlinkSync(stateRoot, path.join(scratch, "linked"));
  const linked = run(["linked"]);
  assert.equal(linked.status, 1, "a link in place of a folder is refused");
  assert.equal(linked.stdout, "", "no path is printed for a refused folder");

  // ---- pr-body location: the note, with explicit roots, independent of where fixtures live ----
  const acceptedRoot = fs.realpathSync(stateRoot);
  const insideFolder = path.join(scratch, "gy8ncs9u");
  assert.equal(bodyLocationNote(insideFolder, [acceptedRoot]), null, "no note for a folder under an accepted root");
  const otherRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-scratch-other-")));
  try {
    assert.match(bodyLocationNote(insideFolder, [otherRoot]) ?? "", /outside what `roborepo delivery pr-body` reads/,
      "a folder under no accepted root gets the note");
    assert.match(bodyLocationNote(insideFolder, []) ?? "", /outside what/, "with no accepted roots every folder gets the note");
    assert.match(bodyLocationNote(`${acceptedRoot}-sibling`, [acceptedRoot]) ?? "", /outside what/,
      "a sibling sharing the root's name prefix is outside it");
  } finally {
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }

  // ---- pr-body location: the note appears exactly when pr-body would refuse the folder ----
  // Each fixture's expectation comes from the accepted roots, so the check holds wherever TMPDIR
  // and the checkout live.
  expectBodyNote(opened, path.join(scratch, "gy8ncs9u"));
  // The checkout's ignored .tmp/ is usually outside every temp root and the account's scratch folder.
  const ignoredTmp = path.join(repoRoot, ".tmp");
  const madeIgnoredTmp = !fs.existsSync(ignoredTmp);
  fs.mkdirSync(ignoredTmp, { recursive: true });
  const outsideState = fs.mkdtempSync(path.join(ignoredTmp, "scratch-state-"));
  try {
    const movedFolder = path.join(outsideState, "scratch", "gy8ncs9u");
    const moved = run(["gy8ncs9u"], outsideState);
    assert.equal(moved.status, 0, moved.stderr);
    assert.equal(moved.stdout, `${movedFolder}\n`, "stdout is still the path alone");
    expectBodyNote(moved, movedFolder);
    if (isBodyLocation(movedFolder)) {
      console.log("skip: the checkout is inside a folder pr-body reads, so no overridden state root falls outside it");
    }
  } finally {
    fs.rmSync(outsideState, { recursive: true, force: true });
    if (madeIgnoredTmp) {
      try {
        fs.rmdirSync(ignoredTmp);
      } catch {
        // Not empty any more; leave it.
      }
    }
  }

  console.log("ok: roborepo scratch (create, prune, keep named folder, refuse bad names)");
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
}

function ageFolder(name) {
  const folder = path.join(scratch, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.utimesSync(folder, old, old);
}

// A folder holding one sparse 600 MB file (over the 500 MB cap on its own), last changed `at`.
function sparseFolder(name, at) {
  const folder = path.join(scratch, name);
  fs.mkdirSync(folder);
  const file = path.join(folder, "sparse.bin");
  fs.writeFileSync(file, "");
  fs.truncateSync(file, 600 * 1024 * 1024);
  fs.utimesSync(file, at, at);
  fs.utimesSync(folder, at, at);
  return folder;
}

function expectBodyNote(result, folder) {
  const note = /outside what `roborepo delivery pr-body` reads/;
  if (isBodyLocation(folder)) assert.doesNotMatch(result.stderr, note, `no note for ${folder}, which pr-body reads`);
  else assert.match(result.stderr, note, `a note for ${folder}, which pr-body would refuse`);
}

function run(args, root = stateRoot) {
  return spawnSync(process.execPath, [cli, "scratch", ...args], {
    env: { ...process.env, ROBOREPO_STATE_ROOT: root },
    encoding: "utf8",
  });
}
