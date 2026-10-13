#!/usr/bin/env node
// Which copy of a plan is authoritative, and whether the primary copy of an active plan holds a
// version its worktree never had. The resolver is pure; the outside-edit check reads real Git state
// from temporary repositories with a primary checkout and a linked worktree.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { blobId, checkOutsideEdits, resolvePlanAuthority } from "../../modules/plan-suite/plan-authority.mjs";

// ---- resolvePlanAuthority: every row of the authority table ----
const active = (worktree) => ({ lifecycle: "active", worktree });
const cases = [
  ["backlog in the primary", { lifecycle: "backlog", worktree: "wt" }, { copy: active("wt") }, "primary", null],
  ["completed in the primary", { lifecycle: "completed", worktree: "wt" }, { copy: active("wt") }, "primary", null],
  ["archived in the primary", { lifecycle: "archived", worktree: "wt" }, { copy: active("wt") }, "primary", null],
  ["active with no worktree", active(""), null, "primary", null],
  ["active with a usable worktree copy", active("wt"), { copy: active("wt") }, "worktree", null],
  ["active, worktree missing", active("wt"), null, "primary", "worktree-missing"],
  ["active, copy missing or unreadable", active("wt"), { copy: null }, "primary", "copy-missing"],
  ["active, copy left active/", active("wt"), { copy: { lifecycle: "completed", worktree: "wt" } }, "primary", "copy-not-active"],
  ["active, copy predates the start transition", active("wt"), { copy: { lifecycle: "backlog", worktree: "" } }, "primary", "copy-not-active"],
  ["active, copy names another worktree", active("wt"), { copy: active("other") }, "primary", "copy-other-worktree"],
];
for (const [name, primary, assigned, source, reason] of cases) {
  assert.deepEqual(resolvePlanAuthority({ primary, assigned }), { source, reason }, name);
}

// ---- checkOutsideEdits against real repositories ----
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plan-authority-")));
const PLAN = "docs/plans/active/p.md";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// Enough lines between the frontmatter and the end that edits to each merge without conflict.
function planText({ priority = "high", status = "Started." } = {}) {
  return `---\nid: p1\npriority: ${priority}\nworktree: wt\n---\n\n# Plan\n\n## Summary\n\nWhy.\n\n## Context\n\nWhat.\n\n## Status\n\n${status}\n`;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A primary checkout whose start transition is committed, and a worktree on branch `wt` from it.
function fixture(name, { objectFormat = "sha1" } = {}) {
  const main = path.join(tempRoot, name, "main");
  const tree = path.join(tempRoot, name, "wt");
  write(path.join(main, PLAN), planText());
  git(main, "init", "-q", "-b", "main", `--object-format=${objectFormat}`);
  git(main, "add", ".");
  git(main, "commit", "-qm", "start");
  git(main, "worktree", "add", "-q", "-b", "wt", tree);
  return { main, tree };
}

function check({ main, tree }, branch = "wt") {
  return checkOutsideEdits({
    primary: { checkoutPath: main, relativePath: PLAN, bytes: fs.readFileSync(path.join(main, PLAN)) },
    assigned: { branch, bytes: fs.readFileSync(path.join(tree, PLAN)) },
  });
}

try {
  const repo = fixture("normal");
  assert.deepEqual(check(repo), { state: "consistent" }, "identical copies are consistent");

  write(path.join(repo.tree, PLAN), planText({ status: "Phase 1 done." }));
  assert.deepEqual(check(repo), { state: "consistent" }, "an uncommitted worktree edit is normal progress");
  git(repo.tree, "commit", "-qam", "progress");
  write(path.join(repo.tree, PLAN), planText({ status: "Phase 2 done." }));
  assert.deepEqual(check(repo), { state: "consistent" }, "nothing since the start: the primary copy equals the merge-base version");

  write(path.join(repo.main, PLAN), planText({ priority: "low" }));
  assert.deepEqual(check(repo), { state: "outside-edit", committed: false }, "an uncommitted primary edit is an outside edit");
  git(repo.main, "commit", "-qam", "edit on main");
  assert.deepEqual(check(repo), { state: "outside-edit", committed: true }, "a committed primary edit is an outside edit");

  git(repo.tree, "commit", "-qam", "more progress");
  git(repo.tree, "merge", "-q", "--no-edit", "main");
  assert.match(fs.readFileSync(path.join(repo.tree, PLAN), "utf8"), /priority: low[\s\S]*Phase 2 done/, "the merge carried main's edit");
  assert.deepEqual(check(repo), { state: "consistent" }, "merging main into the worktree moves the merge base past the edit");

  // Squash merge: main gets a version only the branch's own commits produced.
  const squash = fixture("squash");
  write(path.join(squash.tree, PLAN), planText({ status: "Done." }));
  git(squash.tree, "commit", "-qam", "finish");
  git(squash.main, "merge", "-q", "--squash", "wt");
  git(squash.main, "commit", "-qm", "squash wt");
  write(path.join(squash.tree, PLAN), planText({ status: "Done, with a late note." }));
  assert.deepEqual(check(squash), { state: "consistent" }, "a squash-merged and pulled primary copy equals a blob the branch produced");

  // Rebase merge: the same content arrives on main through different commits.
  const rebase = fixture("rebase");
  write(path.join(rebase.tree, PLAN), planText({ status: "Rebased." }));
  git(rebase.tree, "commit", "-qam", "progress");
  git(rebase.main, "cherry-pick", "wt");
  write(path.join(rebase.tree, PLAN), planText({ status: "Rebased, then more." }));
  assert.deepEqual(check(rebase), { state: "consistent" }, "a rebase-merged primary copy equals a blob the branch produced");

  // Git cannot answer: the result says so instead of guessing.
  const broken = fixture("broken");
  write(path.join(broken.main, PLAN), planText({ priority: "low" }));
  assert.equal(check(broken, null).state, "unchecked", "a detached worktree HEAD cannot be checked");
  assert.equal(check(broken, "no-such-branch").state, "unchecked", "an unresolvable merge base cannot be checked");
  git(broken.main, "checkout", "-q", "--detach");
  const detached = check(broken);
  assert.equal(detached.state, "unchecked", "a detached primary HEAD cannot be checked");
  assert.ok(!detached.reason.includes(tempRoot), "the reason carries no path");

  // The in-process blob id matches Git's for both object formats.
  const sample = Buffer.from(planText({ status: "Hashed ✓" }));
  write(path.join(repo.main, "sample.md"), sample);
  assert.equal(blobId(sample, "sha1"), git(repo.main, "hash-object", "sample.md"), "SHA-1 blob ids match git hash-object");
  const sha256 = fixture("sha256", { objectFormat: "sha256" });
  write(path.join(sha256.main, "sample.md"), sample);
  assert.equal(blobId(sample, "sha256"), git(sha256.main, "hash-object", "sample.md"), "SHA-256 blob ids match git hash-object");
  write(path.join(sha256.tree, PLAN), planText({ status: "Progress." }));
  assert.deepEqual(check(sha256), { state: "consistent" }, "the check reads SHA-256 repositories");
  write(path.join(sha256.main, PLAN), planText({ priority: "low" }));
  assert.deepEqual(check(sha256), { state: "outside-edit", committed: false });

  console.log("plan authority: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
