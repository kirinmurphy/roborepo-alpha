// Merges the base branch into a plan's implementation branch, from that branch's linked worktree.
// /plan-review runs it at the start of every review round, so it does nothing when base has nothing
// new. It never merges the other way, never rewrites local state silently, and never resolves a
// conflict by picking a side.
//
// A conflicted merge is left in progress for an agent or a human to resolve; `continueMerge`
// verifies the resolution and commits it.
import fs from "node:fs";
import path from "node:path";
import { domainError } from "./index.mjs";
import { PLANS_BRANCH } from "./plan-store.mjs";
import { currentBranch, dirtyPaths, git, primaryCheckout, topLevel } from "./plan-git.mjs";

const CONFLICT_MARKER = /^(<{7}|>{7}) /m;

export function syncBase({ cwd = process.cwd(), base = "main", continueMerge = false } = {}) {
  const worktree = topLevel(cwd);
  if (!worktree) throw domainError("INVALID_CHANGE", "Not inside a Git repository.");
  if (worktree === primaryCheckout(cwd)) {
    throw domainError("INVALID_CHANGE", "Run sync-base from the plan's linked worktree, not the primary checkout.", {
      resolution: "cd into the worktree the plan names in `worktree`; sync-base merges the base branch into that worktree's branch.",
    });
  }
  const branch = currentBranch(worktree);
  if (!branch) throw domainError("INVALID_CHANGE", "The worktree's HEAD is detached, so there is no branch to merge into.");
  if (branch === base) throw domainError("INVALID_CHANGE", `The worktree is on ${base} itself; there is nothing to synchronize.`);
  if (branch === PLANS_BRANCH) throw domainError("INVALID_CHANGE", "This is the plans worktree, which never takes code; run sync-base from the plan's implementation worktree.");
  if (!git(worktree, ["rev-parse", "--verify", "-q", `refs/heads/${base}`]).ok) {
    throw domainError("INVALID_CHANGE", `The base branch ${base} does not exist locally.`);
  }
  assertBaseCurrent(worktree, base);

  const merging = git(worktree, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]).ok;
  if (continueMerge) return continueSync({ worktree, branch, base, merging });
  if (merging) {
    throw domainError("INVALID_CHANGE", "A merge is already in progress in this worktree.", {
      resolution: "Resolve the conflicts, stage the result, run the repository's checks, then run sync-base --continue.",
    });
  }
  const dirty = dirtyPaths(worktree);
  if (dirty.length) {
    throw domainError("INVALID_CHANGE", "The worktree has uncommitted changes, so base was not merged.", {
      resolution: "Commit the work in progress first; sync-base never merges over uncommitted changes.",
      details: dirty,
    });
  }

  const before = git(worktree, ["rev-parse", "HEAD"]).stdout;
  if (git(worktree, ["merge-base", "--is-ancestor", base, "HEAD"]).ok) {
    return { state: "up-to-date", branch, base, before, commit: before, conflicts: [] };
  }
  const merged = git(worktree, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${base} into ${branch}`, base]);
  if (merged.ok) return { state: "merged", branch, base, before, commit: git(worktree, ["rev-parse", "HEAD"]).stdout, conflicts: [] };

  const conflicted = unmergedPaths(worktree);
  if (!conflicted.length) {
    throw domainError("MOVE_FAILED", `git merge ${base} failed before it could start.`, { details: [merged.stderr] });
  }
  return { state: "conflicts", branch, base, before, commit: null, conflicts: conflicted };
}

function continueSync({ worktree, branch, base, merging }) {
  if (!merging) throw domainError("INVALID_CHANGE", "No merge is in progress, so there is nothing to continue.");
  const conflicts = unmergedPaths(worktree);
  if (conflicts.length) {
    throw domainError("INVALID_CHANGE", "Some conflicts are still unresolved.", {
      resolution: "Resolve each path, stage it, and run sync-base --continue again.",
      details: conflicts,
    });
  }
  const unstaged = git(worktree, ["diff", "--name-only"]).stdout.split("\n").filter(Boolean);
  if (unstaged.length) {
    throw domainError("INVALID_CHANGE", "The resolution has unstaged changes.", {
      resolution: "Stage the resolved content (or discard the extra edits), then run sync-base --continue again.",
      details: unstaged,
    });
  }
  const marked = git(worktree, ["diff", "--cached", "--name-only", "--diff-filter=AM"]).stdout.split("\n").filter(Boolean)
    .filter((file) => CONFLICT_MARKER.test(readOrEmpty(path.join(worktree, file))));
  if (marked.length) {
    throw domainError("INVALID_CHANGE", "Conflict markers remain in staged files.", {
      resolution: "Finish resolving these files, stage them, and run sync-base --continue again.",
      details: marked,
    });
  }
  return commitMerge(worktree, branch, base);
}

function commitMerge(worktree, branch, base) {
  const committed = git(worktree, ["commit", "--quiet", "--no-edit"]);
  if (!committed.ok) throw domainError("MOVE_FAILED", "The merge commit failed.", { details: [committed.stderr] });
  const commit = git(worktree, ["rev-parse", "HEAD"]).stdout;
  const parents = git(worktree, ["rev-list", "--parents", "-n", "1", commit]).stdout.split(" ").length - 1;
  if (parents !== 2 || !git(worktree, ["merge-base", "--is-ancestor", base, commit]).ok) {
    throw domainError("MOVE_FAILED", `The commit on ${branch} does not merge ${base}.`, { details: [commit] });
  }
  return { state: "merged", branch, base, commit, conflicts: [] };
}

// Tracking information is only as fresh as the last fetch; a local base behind it is reported
// rather than updated, because updating it would move a branch someone else may be using.
function assertBaseCurrent(worktree, base) {
  const upstream = git(worktree, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${base}@{upstream}`]);
  if (!upstream.ok || !upstream.stdout) return;
  const behind = Number(git(worktree, ["rev-list", "--count", `${base}..${upstream.stdout}`]).stdout || "0");
  if (behind > 0) {
    throw domainError("INVALID_CHANGE", `The local ${base} is ${behind} commit${behind === 1 ? "" : "s"} behind ${upstream.stdout} as of the last fetch.`, {
      resolution: `Ask the user to update ${base} in the primary checkout (for example \`git pull --ff-only\`), then run sync-base again.`,
    });
  }
}

function unmergedPaths(worktree) {
  return [...new Set(git(worktree, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean))];
}

function readOrEmpty(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
