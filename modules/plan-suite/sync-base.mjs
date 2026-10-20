// Merges the base branch into a plan's implementation branch, from that branch's linked worktree.
// /plan-review runs it at the start of every review round, so it does nothing when base has nothing
// new. It never merges the other way, never rewrites local state silently, and never resolves a
// conflict by picking a side, with one deterministic exception: the plan document itself, when Git
// misses the rename the primary checkout committed (see resolvePlanRenameConflicts).
//
// A conflicted merge is left in progress for an agent or a human to resolve; `continueMerge`
// verifies the resolution and commits it.
import fs from "node:fs";
import path from "node:path";
import { domainError, parseFrontmatter } from "./index.mjs";
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
    return { state: "up-to-date", branch, base, before, commit: before, conflicts: [], resolved: [] };
  }
  const merged = git(worktree, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${base} into ${branch}`, base]);
  if (merged.ok) return { state: "merged", branch, base, before, commit: git(worktree, ["rev-parse", "HEAD"]).stdout, conflicts: [], resolved: [] };

  const conflicted = unmergedPaths(worktree);
  if (!conflicted.length) {
    throw domainError("MOVE_FAILED", `git merge ${base} failed before it could start.`, { details: [merged.stderr] });
  }
  const resolved = resolvePlanRenameConflicts(worktree);
  const conflicts = unmergedPaths(worktree);
  if (conflicts.length) return { state: "conflicts", branch, base, before, commit: null, conflicts, resolved };
  return { ...commitMerge(worktree, branch, base), before, resolved };
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
  return { ...commitMerge(worktree, branch, base), resolved: [] };
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

// The primary checkout commits a plan's moves before the worktree sees them, so a sync can bring a
// rename of a plan the worktree has edited. When rename detection misses it, Git reports the old
// path as modified here and deleted on base. The worktree's copy is authoritative, so its content
// goes to the path base gave the plan (found by its `id`), and the old path is removed.
function resolvePlanRenameConflicts(worktree) {
  const resolved = [];
  const status = git(worktree, ["status", "--porcelain=v1", "--", "docs/plans"]).raw.split("\n").filter(Boolean);
  const theirs = git(worktree, ["ls-tree", "-r", "--name-only", "MERGE_HEAD", "--", "docs/plans"]).stdout.split("\n").filter(Boolean);
  for (const line of status) {
    if (line.slice(0, 2) !== "UD") continue;
    const oldPath = line.slice(3);
    const ours = git(worktree, ["show", `:2:${oldPath}`]);
    const id = ours.ok ? parseFrontmatter(ours.raw).frontmatter.id : "";
    if (!id) continue;
    const newPath = theirs.find((candidate) => candidate !== oldPath && path.basename(candidate) === path.basename(oldPath)
      && parseFrontmatter(git(worktree, ["show", `MERGE_HEAD:${candidate}`]).raw).frontmatter.id === id);
    if (!newPath) continue;
    fs.writeFileSync(path.join(worktree, newPath), ours.raw);
    if (!git(worktree, ["add", "--", newPath]).ok || !git(worktree, ["rm", "--quiet", "--", oldPath]).ok) continue;
    resolved.push({ from: oldPath, to: newPath });
  }
  return resolved;
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
