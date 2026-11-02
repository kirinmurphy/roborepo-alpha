#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolateGitConfig } from "./lib/git-config.mjs";
import { collectBranchSyncFacts } from "../../modules/repositories/branch-sync.mjs";
import { defaultRunGit } from "../../modules/repositories/git-exec.mjs";
import { refreshRemote, pushBranchToUpstream } from "../../modules/repositories/git-remote-operations.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-branch-sync-"));
isolateGitConfig(tempRoot);

try {
  const { work, linked } = createFixture();
  const facts = await collectBranchSyncFacts(work);
  const byName = new Map(facts.branches.map((branch) => [branch.name, branch]));

  assert.deepEqual(pick(byName.get("main")), { ahead: 0, behind: 0, trackingState: "ok" });
  assert.deepEqual(pick(byName.get("ahead")), { ahead: 1, behind: 0, trackingState: "ok" });
  assert.deepEqual(pick(byName.get("behind")), { ahead: 0, behind: 1, trackingState: "ok" });
  assert.deepEqual(pick(byName.get("diverged")), { ahead: 1, behind: 1, trackingState: "ok" });
  assert.equal(byName.get("no-upstream").trackingState, "no_upstream");
  assert.equal(byName.get("local-child").trackingState, "local_upstream");
  assert.equal(byName.get("gone").trackingState, "gone");

  const unknownFacts = await collectBranchSyncFacts(work, { runGit: async () => ({
    ok: true,
    stdout: "unknown\0origin/main\0origin\0refs/heads/main\0[devant 1]\n",
  }) });
  assert.deepEqual(pick(unknownFacts.branches[0]), { ahead: null, behind: null, trackingState: "unknown" });

  const linkedFacts = await collectBranchSyncFacts(linked);
  assert.equal(linkedFacts.branches.find((branch) => branch.name === "ahead").ahead, 1);

  const refusedFetch = await defaultRunGit(work, ["fetch", "origin"]);
  assert.equal(refusedFetch.ok, false);
  const refusedPush = await defaultRunGit(work, ["push", "origin", "main"]);
  assert.equal(refusedPush.ok, false);

  const refreshed = await refreshRemote(work, "origin");
  assert.equal(refreshed.ok, true, refreshed.error);
  const pushed = await pushBranchToUpstream(work, "ahead", byName.get("ahead"));
  assert.equal(pushed.ok, true, pushed.error);
  const afterPush = await collectBranchSyncFacts(work);
  assert.equal(afterPush.branches.find((branch) => branch.name === "ahead").ahead, 0);

  console.log("repositories-branch-sync-check passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function createFixture() {
  const origin = path.join(tempRoot, "origin.git");
  const seed = path.join(tempRoot, "seed");
  const work = path.join(tempRoot, "work");
  const linked = path.join(tempRoot, "linked");

  run("git", ["init", "--bare", "--initial-branch=main", origin]);
  run("git", ["init", "--initial-branch=main", seed]);
  write(seed, "file.txt", "base\n");
  run("git", ["add", "."], { cwd: seed });
  commit(seed, "base");
  run("git", ["remote", "add", "origin", origin], { cwd: seed });
  run("git", ["push", "-u", "origin", "main"], { cwd: seed });

  run("git", ["checkout", "-b", "behind"], { cwd: seed });
  write(seed, "behind.txt", "remote\n");
  run("git", ["add", "."], { cwd: seed });
  commit(seed, "remote behind");
  run("git", ["push", "-u", "origin", "behind"], { cwd: seed });

  run("git", ["checkout", "main"], { cwd: seed });
  run("git", ["checkout", "-b", "diverged"], { cwd: seed });
  write(seed, "remote-diverged.txt", "remote\n");
  run("git", ["add", "."], { cwd: seed });
  commit(seed, "remote diverged");
  run("git", ["push", "-u", "origin", "diverged"], { cwd: seed });

  run("git", ["clone", origin, work]);
  run("git", ["switch", "-c", "ahead", "origin/main"], { cwd: work });
  write(work, "ahead.txt", "local\n");
  run("git", ["add", "."], { cwd: work });
  commit(work, "local ahead");

  run("git", ["switch", "-c", "behind", "origin/main"], { cwd: work });
  run("git", ["branch", "--set-upstream-to", "origin/behind"], { cwd: work });

  run("git", ["switch", "-c", "diverged", "origin/main"], { cwd: work });
  run("git", ["branch", "--set-upstream-to", "origin/diverged"], { cwd: work });
  write(work, "local-diverged.txt", "local\n");
  run("git", ["add", "."], { cwd: work });
  commit(work, "local diverged");

  run("git", ["switch", "-c", "no-upstream", "origin/main"], { cwd: work });
  run("git", ["branch", "--unset-upstream"], { cwd: work });
  run("git", ["switch", "-c", "local-parent", "origin/main"], { cwd: work });
  run("git", ["switch", "-c", "local-child", "origin/main"], { cwd: work });
  run("git", ["branch", "--set-upstream-to", "local-parent"], { cwd: work });
  run("git", ["switch", "-c", "gone", "origin/main"], { cwd: work });
  run("git", ["config", "branch.gone.remote", "origin"], { cwd: work });
  run("git", ["config", "branch.gone.merge", "refs/heads/gone"], { cwd: work });
  run("git", ["switch", "main"], { cwd: work });
  run("git", ["worktree", "add", linked, "ahead"], { cwd: work });

  return { work, linked };
}

function pick(branch) {
  return {
    ahead: branch.ahead,
    behind: branch.behind,
    trackingState: branch.trackingState,
  };
}

function write(repo, file, content) {
  fs.writeFileSync(path.join(repo, file), content);
}

function commit(repo, message) {
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message], { cwd: repo });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
