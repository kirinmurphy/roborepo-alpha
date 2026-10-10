#!/usr/bin/env node
// Git context collection: ref parsing from local plumbing files, the hardened subprocess seam, and
// the per-scan cache. Fixtures are hand-synthesized .git directories rather than real `git init`
// repositories (matching repositories-check.mjs) so the checks stay fast and hermetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectGitContext,
  collectGitForRoots,
  parseAheadBehind,
  parseHeadRef,
  parsePackedRefs,
  parseUpstreamFromConfig,
} from "../../modules/developer-runtime/index.mjs";
import { createScanCache, defaultRunGit } from "../../modules/repositories/index.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "developer-runtime-git-"));
const SHA = "463e0e97300f0ac34bd4beaff454c1ddf9a03526";

try {
  // ---- Pure parsers ----
  assert.deepEqual(parseHeadRef("ref: refs/heads/feature/x\n"), {
    branch: "feature/x",
    ref: "refs/heads/feature/x",
    detached: false,
    head: null,
  });
  assert.deepEqual(parseHeadRef(`${SHA}\n`), { branch: null, ref: null, detached: true, head: SHA });
  assert.equal(parseHeadRef(""), null, "empty HEAD is unreadable, not a silent default");

  const packed = parsePackedRefs(`# pack-refs with: peeled\n${SHA} refs/heads/main\n^${SHA}\n`);
  assert.equal(packed.get("refs/heads/main"), SHA);
  assert.equal(packed.size, 1, "peeled-tag and comment lines are skipped");

  const config = `[branch "main"]\n  remote = origin\n  merge = refs/heads/main\n`;
  assert.equal(parseUpstreamFromConfig(config, "main"), "origin/main");
  assert.equal(parseUpstreamFromConfig(config, "other"), null, "a branch with no section has no upstream");
  assert.equal(
    parseUpstreamFromConfig(`[branch "wip"]\n  remote = .\n  merge = refs/heads/main\n`, "wip"),
    "main",
    "a branch tracking a local branch has no remote-tracking ref",
  );
  assert.deepEqual(parseAheadBehind("3\t5\n"), { behind: 3, ahead: 5 });
  assert.equal(parseAheadBehind("garbage"), null);
  console.log("ok  ref parsers");

  // ---- Branch, commit, and loose-ref resolution ----
  const repo = mkRepo("plain", { head: "ref: refs/heads/main\n", refs: { "refs/heads/main": SHA } });
  const plain = await collectGitContext(repo, { runGit: stubGit({ status: "", revList: "0\t0" }) });
  assert.equal(plain.branch, "main");
  assert.equal(plain.head, SHA);
  assert.equal(plain.shortHead, "463e0e9");
  assert.equal(plain.detached, false);
  assert.equal(plain.isWorktree, false);
  assert.equal(plain.worktreeName, null, "a main checkout has no administrative worktree name");
  console.log("ok  branch and commit from loose refs");

  // ---- Detached HEAD ----
  const detachedRepo = mkRepo("detached", { head: `${SHA}\n` });
  const detached = await collectGitContext(detachedRepo, { runGit: stubGit({ status: "" }) });
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);
  assert.equal(detached.head, SHA, "a detached HEAD still reports its commit");
  console.log("ok  detached HEAD");

  // ---- packed-refs fallback ----
  const packedRepo = mkRepo("packed", {
    head: "ref: refs/heads/main\n",
    packedRefs: `${SHA} refs/heads/main\n`,
  });
  const packedResult = await collectGitContext(packedRepo, { runGit: stubGit({ status: "" }) });
  assert.equal(packedResult.head, SHA, "a branch with no loose ref file resolves via packed-refs");
  console.log("ok  packed-refs fallback");

  // ---- No remote: no upstream, and ahead/behind is never attempted ----
  const noRemote = mkRepo("no-remote", { head: "ref: refs/heads/main\n", refs: { "refs/heads/main": SHA } });
  const noRemoteSpy = spyGit({ status: "" });
  const noRemoteResult = await collectGitContext(noRemote, { runGit: noRemoteSpy.runGit });
  assert.equal(noRemoteResult.upstream, null);
  assert.equal(noRemoteResult.ahead, null);
  assert.equal(noRemoteResult.behind, null);
  assert.ok(
    !noRemoteSpy.calls.some((call) => call[0] === "rev-list"),
    "with no upstream there is nothing to compare against, so rev-list must not run",
  );
  console.log("ok  no remote");

  // ---- Linked worktree: .git is a file, refs shared via commondir ----
  const worktree = mkWorktree("wt", { branch: "wt-branch", sha: SHA });
  const worktreeResult = await collectGitContext(worktree, {
    runGit: stubGit({
      status: "",
      branchSync: "wt-branch\0origin/wt-branch\0origin\0refs/heads/wt-branch\0[ahead 2, behind 1]\n",
    }),
  });
  assert.equal(worktreeResult.isWorktree, true);
  assert.equal(worktreeResult.branch, "wt-branch");
  assert.equal(worktreeResult.head, SHA);
  assert.equal(worktreeResult.upstream, "origin/wt-branch", "upstream comes from the common dir's config");
  assert.deepEqual([worktreeResult.behind, worktreeResult.ahead], [1, 2]);
  assert.equal(worktreeResult.worktreeName, "wt");
  // Git suffixes the administrative name when two worktrees share a directory basename, so the
  // identity must come from the gitdir, never from the checkout path.
  const renamed = mkWorktree("feature", { branch: "feature-branch", sha: SHA, adminName: "feature1" });
  const renamedResult = await collectGitContext(renamed, { runGit: stubGit({ status: "" }) });
  assert.equal(renamedResult.worktreeName, "feature1");
  console.log("ok  linked worktree");

  // ---- Dirty state ----
  const dirty = await collectGitContext(repo, { runGit: stubGit({ status: "M  file.txt\0" }) });
  assert.equal(dirty.dirty, true);
  const clean = await collectGitContext(repo, { runGit: stubGit({ status: "" }) });
  assert.equal(clean.dirty, false);

  // The load-bearing assertion: a failed subprocess must yield null, never false. Reporting "clean"
  // for a repository we could not inspect would be a lie the user acts on.
  const failed = await collectGitContext(repo, { runGit: async () => ({ ok: false, stdout: "", error: "boom" }) });
  assert.equal(failed.dirty, null, "unknown dirty state is null, not false");
  assert.equal(failed.ahead, null);
  assert.equal(failed.behind, null);
  assert.equal(failed.branch, "main", "fs-derived fields survive a subprocess failure");
  console.log("ok  dirty state (null when unknown)");

  // ---- Not a git root ----
  const bare = path.join(tempRoot, "bare");
  fs.mkdirSync(bare, { recursive: true });
  const bareResult = await collectGitContext(bare, { runGit: stubGit({ status: "" }) });
  assert.equal(bareResult.provider.ok, false);
  assert.equal(bareResult.provider.reason, "not-a-git-root");
  assert.equal(bareResult.worktreeName, null);
  assert.equal(await collectGitContext(null, {}), null);
  console.log("ok  non-git root degrades honestly");

  // ---- Never fetch, never invoke hooks ----
  const spy = spyGit({ status: "", revList: "0\t0" });
  const upstreamRepo = mkRepo("upstream", {
    head: "ref: refs/heads/main\n",
    refs: { "refs/heads/main": SHA },
    config: `[remote "origin"]\n  url = git@github.com:o/r.git\n[branch "main"]\n  remote = origin\n  merge = refs/heads/main\n`,
  });
  await collectGitContext(upstreamRepo, { runGit: spy.runGit });
  assert.ok(spy.calls.length >= 2, "both status and rev-list ran");
  // Every subcommand this module may run. All are local reads: drift collection adds symbolic-ref
  // and rev-parse (resolving the base branch), merge-base (where the branch left it), and log
  // (commit timestamps). None of them contacts a remote.
  const READ_ONLY = ["status", "rev-list", "symbolic-ref", "rev-parse", "merge-base", "log", "for-each-ref"];
  for (const call of spy.calls) {
    assert.ok(READ_ONLY.includes(call[0]), `unexpected git subcommand: ${call[0]}`);
    assert.ok(!call.includes("fetch") && !call.includes("pull"), "no network subcommand may appear");
  }
  console.log("ok  only read-only, offline git subcommands run");

  // The allow-list is enforced at the seam itself, so a future edit cannot casually add a fetch.
  const refused = await defaultRunGit(tempRoot, ["fetch", "--all"]);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /non-read-only/);
  const alsoRefused = await defaultRunGit(tempRoot, ["push"]);
  assert.equal(alsoRefused.ok, false);
  console.log("ok  git-exec refuses non-read-only subcommands");

  // ---- Per-scan cache: N instances in one repository cost one collection ----
  const scanCache = createScanCache();
  let collections = 0;
  const counting = async () => {
    collections += 1;
    return { branch: "main" };
  };
  const items = [
    { identity: { projectRoot: repo } },
    { identity: { projectRoot: repo } },
    { identity: { projectRoot: detachedRepo } },
    { identity: { projectRoot: null } },
  ];
  const byRoot = await collectGitForRoots(items, { collectGit: counting, scanCache });
  assert.equal(collections, 2, "two unique roots -> two collections, despite three rooted instances");
  assert.equal(byRoot.get(repo).branch, "main");
  assert.equal(byRoot.has(null), false, "instances with no project root contribute nothing");
  console.log("ok  per-scan cache dedupes by repository root");

  console.log("\ndeveloper-runtime-git checks passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function mkRepo(name, { head, refs = {}, packedRefs = null, config = null }) {
  const repo = path.join(tempRoot, name);
  const gitDir = path.join(repo, ".git");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), head);
  for (const [ref, sha] of Object.entries(refs)) {
    const refPath = path.join(gitDir, ref);
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, `${sha}\n`);
  }
  if (packedRefs) fs.writeFileSync(path.join(gitDir, "packed-refs"), packedRefs);
  if (config) fs.writeFileSync(path.join(gitDir, "config"), config);
  return fs.realpathSync(repo);
}

// A linked worktree: `.git` is a file pointing at a per-worktree gitdir, which in turn holds a
// `commondir` pointer back to the primary repository's git directory.
function mkWorktree(name, { branch, sha, adminName = name }) {
  const primary = path.join(tempRoot, `${name}-primary`);
  const commonDir = path.join(primary, ".git");
  fs.mkdirSync(commonDir, { recursive: true });
  fs.writeFileSync(
    path.join(commonDir, "config"),
    `[remote "origin"]\n  url = git@github.com:o/r.git\n[branch "${branch}"]\n  remote = origin\n  merge = refs/heads/${branch}\n`,
  );

  const worktree = path.join(tempRoot, name);
  const gitDir = path.join(commonDir, "worktrees", adminName);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  const refPath = path.join(gitDir, "refs", "heads", branch);
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(refPath, `${sha}\n`);
  return fs.realpathSync(worktree);
}

function stubGit({ status = "", revList = "0\t0", branchSync = "" }) {
  return async (_cwd, args) => ({
    ok: true,
    stdout: args[0] === "status" ? status : args[0] === "for-each-ref" ? branchSync : revList,
    code: 0,
    error: null,
  });
}

function spyGit(responses) {
  const calls = [];
  const inner = stubGit(responses);
  return {
    calls,
    runGit: async (cwd, args, options) => {
      calls.push(args);
      return inner(cwd, args, options);
    },
  };
}
