#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolateGitConfig } from "./lib/git-config.mjs";
import { legacyRecovery, legacyRecoveryCount, restoreLegacyBackup } from "../../modules/repositories/worktree-legacy-recovery.mjs";
import { inspectCommitLanding } from "../../modules/repositories/worktree-landed.mjs";
import { createWorktreeSnapshot } from "./helpers/worktree-snapshot-fixture.mjs";
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-legacy-test-")));
const restoreConfig = isolateGitConfig(root);
function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function write(cwd, file, bytes) { fs.writeFileSync(path.join(cwd, file), bytes); }
function hasRef(repo, ref) { return spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repo }).status === 0; }
try {
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  git(repo, "init", "-qb", "main"); write(repo, "seed", "seed\n"); git(repo, "add", "seed"); git(repo, "commit", "-qm", "seed");
  const initial = git(repo, "rev-parse", "HEAD");
  const reachable = "refs/roborepo/abandoned/reachable-fffffff";
  git(repo, "update-ref", reachable, initial);
  const cli = fileURLToPath(new URL("../cli/main.mjs", import.meta.url));
  const cleanup = (...args) => spawnSync(process.execPath, [cli, "git", "worktrees", "cleanup", ...args], {
    cwd: repo, encoding: "utf8", env: { ...process.env, ROBOREPO_STATE_ROOT: path.join(root, "state") },
  });
  const cleanupJson = cleanup("--json");
  assert.equal(cleanupJson.status, 0, cleanupJson.stderr);
  assert.deepEqual(JSON.parse(cleanupJson.stdout), [{ legacyRecoveryPending: 1 }]);
  const cleanupText = cleanup();
  assert.equal(cleanupText.status, 0, cleanupText.stderr);
  assert.equal(cleanupText.stdout.trim(), "Legacy recovery pending: 1; run roborepo git worktrees legacy-recovery");
  const branch = path.join(root, "feature"); git(repo, "worktree", "add", "-qb", "feature", branch);
  write(branch, "code", "feature\n"); git(branch, "add", "code"); git(branch, "commit", "-qm", "feature");
  const tip = git(branch, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", "feature"); git(repo, "commit", "-qm", "squash");
  const mismatch = "refs/roborepo/abandoned/feature-deadbee";
  git(repo, "update-ref", mismatch, tip);
  assert.equal((await inspectCommitLanding(repo, tip)).landed, true, "squashed legacy tip needs no branch reflog");
  assert.equal((await inspectCommitLanding(repo, initial)).proof, "reachable");
  const preserved = await createWorktreeSnapshot(branch); assert.equal(preserved.ok, true, preserved.reason);
  write(branch, "code", "unique staged\n"); git(branch, "add", "code"); write(branch, "code", "unique filesystem\n");
  const unique = await createWorktreeSnapshot(branch); assert.equal(unique.ok, true, unique.reason);
  const invalid = "refs/roborepo/worktree-archives/00000000-0000-4000-8000-000000000001";
  git(repo, "update-ref", invalid, initial);
  const beforeRefs = git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
  const beforeObjects = git(repo, "count-objects", "-v");
  const preview = await legacyRecovery(repo);
  assert.equal(preview.action, "preview");
  assert.equal(preview.items.find((item) => item.ref === mismatch).tip, tip, "ref suffix is not an identity");
  assert.equal(preview.items.find((item) => item.ref === mismatch).class, "preserved");
  assert.equal(preview.items.find((item) => item.ref === preserved.ref).class, "preserved");
  assert.notEqual(preview.items.find((item) => item.ref === unique.ref).class, "preserved", "parent landing does not cover unique layers");
  assert.equal(preview.items.find((item) => item.ref === invalid).class, "invalid");
  assert.equal(git(repo, "for-each-ref", "--format=%(refname) %(objectname)"), beforeRefs);
  assert.equal(git(repo, "count-objects", "-v"), beforeObjects, "proof objects stay temporary");
  assert.equal(await legacyRecoveryCount(repo), 5);
  assert.equal((await legacyRecovery(repo, { apply: true })).ok, false, "apply needs exact digest");
  const restoredPath = path.join(root, "restored-tip");
  assert.equal((await restoreLegacyBackup(repo, mismatch, restoredPath)).action, "preview");
  assert.equal(fs.existsSync(restoredPath), false);
  const restored = await restoreLegacyBackup(repo, mismatch, restoredPath, { apply: true });
  assert.equal(restored.action, "restored", JSON.stringify(restored));
  assert.equal(git(restoredPath, "rev-parse", "HEAD"), tip);
  assert.equal(spawnSync("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: restoredPath }).status, 1);
  const changedRef = "refs/roborepo/abandoned/concurrent";
  git(repo, "update-ref", changedRef, initial);
  assert.equal((await legacyRecovery(repo, { apply: true, approve: preview.digest })).ok, false, "changed inventory refuses stale approval");
  assert.equal(hasRef(repo, mismatch), true);
  git(repo, "update-ref", "-d", changedRef);
  const reviewedBase = git(repo, "rev-parse", "main");
  write(repo, "later", "new base content"); git(repo, "add", "later"); git(repo, "commit", "-qm", "base advances");
  assert.equal((await legacyRecovery(repo, { apply: true, approve: preview.digest })).ok, false, "base changes invalidate approval even when refs are unchanged");
  const advancedBase = git(repo, "rev-parse", "main");
  git(repo, "update-ref", "refs/heads/main", reviewedBase);
  let advancedDuringApply = false;
  const staleBase = await legacyRecovery(repo, { apply: true, approve: preview.digest, runGit: async (cwd, args, settings) => {
    if (!advancedDuringApply && args[0] === "update-ref" && args[1] === "--stdin") {
      advancedDuringApply = true;
      git(repo, "update-ref", "refs/heads/main", advancedBase, reviewedBase);
    }
    return runGitProcess(cwd, args, settings);
  } });
  assert.equal(advancedDuringApply, true);
  assert.equal(staleBase.ok, false, "base movement during deletion refuses preserved-ref removal");
  assert.equal(hasRef(repo, mismatch), true);
  assert.equal(hasRef(repo, preserved.ref), true);
  git(repo, "update-ref", "refs/heads/main", reviewedBase, advancedBase);
  const applied = await legacyRecovery(repo, { apply: true, approve: preview.digest });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(hasRef(repo, mismatch), false); assert.equal(hasRef(repo, preserved.ref), false);
  assert.equal(hasRef(repo, unique.ref), true); assert.equal(hasRef(repo, invalid), true);
  const discard = [unique.ref, invalid];
  const explicit = await legacyRecovery(repo, { discard });
  assert.equal(explicit.items.every((item) => item.resolution === "discard"), true);
  const raced = await legacyRecovery(repo, { discard, apply: true, approve: explicit.digest, runGit: async (cwd, args, settings) => {
    if (args[0] === "update-ref" && args.at(-2) === invalid) git(repo, "update-ref", invalid, tip);
    return runGitProcess(cwd, args, settings);
  } });
  assert.equal(raced.action, "partial");
  assert.equal(hasRef(repo, unique.ref), false); assert.equal(git(repo, "rev-parse", invalid), tip, "expected object protects moved refs");
  const finalPreview = await legacyRecovery(repo, { discard: [invalid] });
  assert.equal((await legacyRecovery(repo, { discard: [invalid], approve: finalPreview.digest, apply: true })).ok, true);
  const empty = await legacyRecovery(repo);
  assert.equal((await legacyRecovery(repo, { approve: empty.digest, apply: true })).ok, true, "fresh retry with removed refs is harmless");
  git(repo, "branch", "-m", "main", "topic");
  const alias = "refs/roborepo/abandoned/symbolic";
  git(repo, "symbolic-ref", alias, "refs/heads/topic");
  const noBase = await legacyRecovery(repo);
  assert.equal(noBase.items[0].class, "unknown");
  assert.deepEqual(noBase.proposed, [], "no base means no automatic deletion");
  const approvedAlias = await legacyRecovery(repo, { discard: [alias] });
  const removedAlias = await legacyRecovery(repo, { discard: [alias], apply: true, approve: approvedAlias.digest });
  assert.equal(removedAlias.ok, true, JSON.stringify(removedAlias));
  assert.equal(hasRef(repo, alias), false);
  assert.equal(git(repo, "rev-parse", "refs/heads/topic"), reviewedBase, "discard of the alias preserves its target");
  assert.equal(await legacyRecoveryCount(repo), 0);
  console.log("legacy recovery: reachable/squash proofs, layer protection, exact approval, concurrent ref protection, detached restore passed");
} finally {
  restoreConfig();
  try { fs.rmSync(root, { recursive: true, force: true }); }
  catch (error) { console.error(`Fixture cleanup failed: ${error.message}`); process.exitCode = 1; }
}
