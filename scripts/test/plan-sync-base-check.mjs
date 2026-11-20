#!/usr/bin/env node
// `roborepo plans sync-base`: merging the base branch into a plan's feature branch from its linked
// worktree. Covers a branch already up to date, a clean merge, a stale base fast-forwarded from its
// upstream (checked out clean, checked out dirty, checked out nowhere, diverged, fetch failing,
// tracking ref missing, local upstream, symbolic base), a
// conflict that pauses without losing work and then continues, and every refusal.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createPlanFixture } from "./lib/plan-git-fixture.mjs";

const fx = createPlanFixture("roborepo-plan-sync-base-");
const { git, roborepo, json, repository, worktree, commit, clone } = fx;
const sync = (cwd, ...args) => roborepo(["plans", "sync-base", ...args, "--json"], { cwd });
const read = (file) => fs.readFileSync(file, "utf8");

function refused(result, label, pattern) {
  assert.equal(result.status, 1, `${label} refuses\n${result.stdout}${result.stderr}`);
  const body = json(result, label);
  assert.match(`${body.error.message}\n${body.error.resolution || ""}`, pattern, label);
}

try {
  const root = repository("repo", {
    "src/shared.txt": "line one\n",
    "src/other.txt": "other\n",
  });
  const wt = worktree(root, "feat/sync");

  // Nothing new on base: a later review round reruns safely and changes nothing.
  const before = git(wt.path, "rev-parse", "HEAD");
  const idle = json(sync(wt.path), "up to date");
  assert.equal(idle.state, "up-to-date");
  assert.equal(git(wt.path, "rev-parse", "HEAD"), before, "an up-to-date sync makes no commit");

  // Refusals: the primary checkout and uncommitted work.
  refused(sync(root), "sync from the primary checkout", /linked worktree/);
  fs.writeFileSync(path.join(wt.path, "wip.txt"), "uncommitted\n");
  commit(root, "Base moves", { "src/other.txt": "other, changed on base\n" });
  refused(sync(wt.path), "sync over uncommitted work", /uncommitted changes/);
  fs.rmSync(path.join(wt.path, "wip.txt"));

  // A clean merge brings base in with a two-parent commit; base never receives the branch.
  commit(wt.path, "Feature work", { "src/feature.txt": "feature\n" });
  const mainBefore = git(root, "rev-parse", "main");
  const merged = json(sync(wt.path), "clean merge");
  assert.equal(merged.state, "merged");
  assert.equal(git(wt.path, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "a merge commit");
  assert.equal(read(path.join(wt.path, "src/other.txt")), "other, changed on base\n");
  assert.equal(git(root, "rev-parse", "main"), mainBefore, "the base branch is never moved");

  // A base behind its upstream is fetched and fast-forwarded first, so the branch takes what its
  // pull request is compared against. Another machine pushes the upstream commits.
  git(root, "config", "branch.main.remote", "origin");
  git(root, "config", "branch.main.merge", "refs/heads/main");
  git(root, "push", "--quiet", "origin", "main");
  const other = clone(root, "other-machine");
  const pushUpstream = (message, files) => {
    commit(other, message, files);
    git(other, "push", "--quiet", "origin", "main");
    return git(other, "rev-parse", "HEAD");
  };

  // The checkout holding main has uncommitted changes: main stays put and nothing merges.
  const mainStale = git(root, "rev-parse", "main");
  const branchBefore = git(wt.path, "rev-parse", "HEAD");
  const upstreamOne = pushUpstream("Upstream commit one", { "src/upstream-one.txt": "one\n" });
  fs.writeFileSync(path.join(root, "scratch.txt"), "the user's work\n");
  refused(sync(wt.path), "fast-forward over a dirty base checkout", /1 commit behind origin\/main.*uncommitted changes/s);
  assert.equal(git(root, "rev-parse", "main"), mainStale, "a dirty base checkout is never moved");
  assert.equal(git(wt.path, "rev-parse", "HEAD"), branchBefore, "a refusal merges nothing");
  fs.rmSync(path.join(root, "scratch.txt"));

  // A clean checkout on main: fast-forwarded there, working tree included, then merged.
  const forwarded = json(sync(wt.path), "fast-forward in the base checkout");
  assert.equal(forwarded.state, "merged");
  assert.deepEqual(
    { moved: forwarded.baseUpdate.moved, fetch: forwarded.baseUpdate.fetch, from: forwarded.baseUpdate.from, to: forwarded.baseUpdate.to },
    { moved: true, fetch: "fetched", from: mainStale, to: upstreamOne },
  );
  assert.equal(git(root, "rev-parse", "main"), upstreamOne, "main is fast-forwarded to its upstream");
  assert.equal(read(path.join(root, "src/upstream-one.txt")), "one\n", "the base checkout's files follow the fast-forward");
  assert.equal(git(root, "status", "--porcelain", "--untracked-files=all"), "", "the base checkout's files and index match its branch");
  assert.equal(read(path.join(wt.path, "src/upstream-one.txt")), "one\n", "the branch takes the upstream commit");

  // main checked out nowhere: the ref itself is fast-forwarded and the detached checkout stays put.
  git(root, "switch", "--quiet", "--detach");
  const upstreamTwo = pushUpstream("Upstream commit two", { "src/upstream-two.txt": "two\n" });
  const unattached = json(sync(wt.path), "fast-forward of an unchecked-out base");
  assert.equal(unattached.baseUpdate.moved, true);
  assert.equal(git(root, "rev-parse", "main"), upstreamTwo, "the main ref is fast-forwarded");
  assert.equal(git(root, "rev-parse", "HEAD"), upstreamOne, "a detached checkout is not moved");
  git(root, "switch", "--quiet", "main");

  // main has a commit of its own: not a fast-forward, so it refuses and leaves main alone.
  const localOnly = commit(root, "Local-only base commit", { "src/local-only.txt": "local\n" });
  pushUpstream("Upstream commit three", { "src/upstream-three.txt": "three\n" });
  const beforeDiverged = git(wt.path, "rev-parse", "HEAD");
  refused(sync(wt.path), "a diverged base", /cannot be fast-forwarded/);
  assert.equal(git(root, "rev-parse", "main"), localOnly, "a diverged base is never moved");
  assert.equal(git(wt.path, "rev-parse", "HEAD"), beforeDiverged, "a refusal merges nothing");
  git(root, "reset", "--quiet", "--hard", "HEAD^");

  // The fetch fails: the last fetched upstream is still used, and the report says it was not fresh.
  const originUrl = git(root, "remote", "get-url", "origin");
  git(root, "remote", "set-url", "origin", path.join(fx.tmp, "remotes", "missing.git"));
  const offline = json(sync(wt.path), "fast-forward from the last fetch");
  assert.equal(offline.baseUpdate.fetch, "failed", "a failed fetch is reported");
  assert.equal(offline.baseUpdate.moved, true, "the last fetched upstream still fast-forwards main");
  assert.equal(git(root, "rev-parse", "main"), git(root, "rev-parse", "refs/remotes/origin/main"));
  git(root, "remote", "set-url", "origin", originUrl);

  // A missing tracking ref is recreated by the fetch rather than read as "no upstream".
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  const upstreamFour = pushUpstream("Upstream commit four", { "src/upstream-four.txt": "four\n" });
  const recreated = json(sync(wt.path), "fast-forward after the tracking ref was removed");
  assert.equal(recreated.baseUpdate.fetch, "fetched");
  assert.equal(git(root, "rev-parse", "main"), upstreamFour, "main reaches the refetched upstream");

  // A local upstream needs no fetch and is reported as local, not as a failed fetch.
  git(root, "branch", "--quiet", "trunk", "main");
  git(root, "config", "branch.main.remote", ".");
  git(root, "config", "branch.main.merge", "refs/heads/trunk");
  assert.equal(json(sync(wt.path), "local upstream").baseUpdate.fetch, "local");
  git(root, "config", "branch.main.remote", "origin");
  git(root, "config", "branch.main.merge", "refs/heads/main");

  // A symbolic base could advance a checked-out branch behind its checkout's back; it is refused.
  git(root, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
  refused(sync(wt.path, "--base", "alias"), "a symbolic base", /symbolic ref/);
  git(root, "update-ref", "--no-deref", "-d", "refs/heads/alias");

  // A conflict pauses with the merge in progress; nothing is discarded or chosen.
  commit(root, "Base edits shared", { "src/shared.txt": "line one from base\n" });
  commit(wt.path, "Branch edits shared", { "src/shared.txt": "line one from the branch\n" });
  const paused = sync(wt.path);
  assert.equal(paused.status, 1, "conflicts exit 1");
  const conflicted = json(paused, "conflict");
  assert.equal(conflicted.state, "conflicts");
  assert.deepEqual(conflicted.conflicts, ["src/shared.txt"]);
  assert.match(read(path.join(wt.path, "src/shared.txt")), /<<<<<<< /, "both sides are left for semantic resolution");
  refused(sync(wt.path), "a second sync during a merge", /already in progress/);
  refused(sync(wt.path, "--continue"), "continue with unresolved paths", /still unresolved/);
  git(wt.path, "add", "--", "src/shared.txt");
  refused(sync(wt.path, "--continue"), "continue with conflict markers", /Conflict markers remain/);
  fs.writeFileSync(path.join(wt.path, "src/shared.txt"), "line one from base and the branch\n");
  git(wt.path, "add", "--", "src/shared.txt");
  // The base moving while the merge is paused does not invalidate the resolution.
  commit(root, "Base moves during the pause", { "src/later.txt": "later\n" });
  const continued = json(sync(wt.path, "--continue"), "continue");
  assert.equal(continued.state, "merged");
  assert.equal(git(wt.path, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3);
  assert.equal(read(path.join(wt.path, "src/shared.txt")), "line one from base and the branch\n", "the resolution is what was committed");

  console.log("plan sync-base: ok");
} finally {
  fx.cleanup();
}
