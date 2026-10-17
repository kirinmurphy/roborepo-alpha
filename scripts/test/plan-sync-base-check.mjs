#!/usr/bin/env node
// `roborepo plans sync-base`: merging the base branch into a plan's feature branch from its linked
// worktree. Covers a branch already up to date, a clean merge, a conflict that pauses without losing
// work and then continues, the plan rename Git fails to detect, and every refusal.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createPlanFixture, planDoc } from "./lib/plan-git-fixture.mjs";

const fx = createPlanFixture("roborepo-plan-sync-base-");
const { git, roborepo, json, repository, worktree, commit } = fx;
const sync = (cwd, ...args) => roborepo(["plans", "sync-base", ...args, "--json"], { cwd });
const read = (file) => fs.readFileSync(file, "utf8");

function refused(result, label, pattern) {
  assert.equal(result.status, 1, `${label} refuses\n${result.stdout}${result.stderr}`);
  const body = json(result, label);
  assert.match(`${body.error.message}\n${body.error.resolution || ""}`, pattern, label);
}

try {
  const root = repository("repo", {
    "docs/plans/active/test-sync.md": planDoc({ id: "sync0001" }),
    "src/shared.txt": "line one\n",
    "src/other.txt": "other\n",
  });
  const wt = worktree(root, "feat/sync");

  // Nothing new on base: a later review round reruns safely and changes nothing.
  const before = git(wt.path, "rev-parse", "HEAD");
  const idle = json(sync(wt.path), "up to date");
  assert.equal(idle.state, "up-to-date");
  assert.equal(git(wt.path, "rev-parse", "HEAD"), before, "an up-to-date sync makes no commit");

  // Refusals: the primary checkout, uncommitted work, and a base behind its upstream.
  refused(sync(root), "sync from the primary checkout", /linked worktree/);
  fs.writeFileSync(path.join(wt.path, "wip.txt"), "uncommitted\n");
  commit(root, "Base moves", { "src/other.txt": "other, changed on base\n" });
  refused(sync(wt.path), "sync over uncommitted work", /uncommitted changes/);
  fs.rmSync(path.join(wt.path, "wip.txt"));

  const ahead = commit(root, "Upstream-only commit", { "src/upstream.txt": "fetched\n" });
  git(root, "reset", "--quiet", "--hard", "HEAD^");
  git(root, "remote", "add", "origin", root);
  git(root, "update-ref", "refs/remotes/origin/main", ahead);
  git(root, "config", "branch.main.remote", "origin");
  git(root, "config", "branch.main.merge", "refs/heads/main");
  refused(sync(wt.path), "sync from a stale base", /1 commit behind origin\/main/);
  assert.equal(git(wt.path, "rev-parse", "HEAD"), before, "a refusal merges nothing");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "main"));

  // A clean merge brings base in with a two-parent commit; base never receives the branch.
  commit(wt.path, "Feature work", { "src/feature.txt": "feature\n" });
  const mainBefore = git(root, "rev-parse", "main");
  const merged = json(sync(wt.path), "clean merge");
  assert.equal(merged.state, "merged");
  assert.equal(git(wt.path, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "a merge commit");
  assert.equal(read(path.join(wt.path, "src/other.txt")), "other, changed on base\n");
  assert.equal(git(root, "rev-parse", "main"), mainBefore, "the base branch is never moved");

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
  const continued = json(sync(wt.path, "--continue"), "continue");
  assert.equal(continued.state, "merged");
  assert.equal(git(wt.path, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3);
  assert.equal(read(path.join(wt.path, "src/shared.txt")), "line one from base and the branch\n", "the resolution is what was committed");

  // The plan moved on base while the worktree edited it. When base also rewrote it enough that Git
  // cannot pair the rename, the worktree's content lands at base's new path.
  const planPath = "docs/plans/active/test-sync.md";
  commit(wt.path, "Progress in the worktree", { [planPath]: `${read(path.join(wt.path, planPath))}\nWorktree progress.\n` });
  fs.mkdirSync(path.join(root, "docs/plans/review"), { recursive: true });
  git(root, "mv", "--", planPath, "docs/plans/review/test-sync.md");
  const rewritten = `---\nid: sync0001\npriority: medium\nnext_action:\n---\n\n# Rewritten\n\n${"Entirely different text on base.\n".repeat(40)}`;
  fs.writeFileSync(path.join(root, "docs/plans/review/test-sync.md"), rewritten);
  git(root, "add", "--", "docs/plans/review/test-sync.md");
  git(root, "commit", "--quiet", "-m", "Move and rewrite the plan on base");
  const renamed = json(sync(wt.path), "rename conflict");
  assert.equal(renamed.state, "merged", `the plan's modify/delete conflict is resolved\n${JSON.stringify(renamed)}`);
  assert.deepEqual(renamed.resolved, [{ from: planPath, to: "docs/plans/review/test-sync.md" }]);
  assert.ok(!fs.existsSync(path.join(wt.path, planPath)), "the old path is removed");
  assert.match(read(path.join(wt.path, "docs/plans/review/test-sync.md")), /Worktree progress\./, "the worktree's content is kept at the new path");

  console.log("plan sync-base: ok");
} finally {
  fx.cleanup();
}
