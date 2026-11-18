// Merges the base branch into a plan's implementation branch, from that branch's linked worktree.
// /plan-execute runs it before handing a plan off and /plan-review at the start of every review
// round, so it does nothing when base has nothing new. It never merges the other way and never
// resolves a conflict by picking a side.
//
// First it refreshes the local base from its upstream, so the feature branch takes what the pull
// request will be compared against. It moves the base only by a pure fast-forward, and only when
// the checkout holding the base has no uncommitted changes; otherwise it refuses and leaves the
// base for the user.
//
// A conflicted merge is left in progress for an agent or a human to resolve; `continueMerge`
// verifies the resolution and commits it.
import fs from "node:fs";
import path from "node:path";
import { fetchTrackingRefs } from "../delivery/operations.mjs";
import { domainError } from "./index.mjs";
import { PLANS_BRANCH } from "./plan-store.mjs";
import { currentBranch, dirtyPaths, git, primaryCheckout, topLevel } from "./plan-git.mjs";

const CONFLICT_MARKER = /^(<{7}|>{7}) /m;

export async function syncBase({ cwd = process.cwd(), base = "main", continueMerge = false } = {}) {
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
  const merging = git(worktree, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]).ok;
  // A paused merge already chose its base commit; a later sync-base picks up anything newer.
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

  const baseUpdate = await refreshBase(worktree, base);

  const before = git(worktree, ["rev-parse", "HEAD"]).stdout;
  if (git(worktree, ["merge-base", "--is-ancestor", base, "HEAD"]).ok) {
    return { state: "up-to-date", branch, base, baseUpdate, before, commit: before, conflicts: [] };
  }
  const merged = git(worktree, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${base} into ${branch}`, base]);
  if (merged.ok) return { state: "merged", branch, base, baseUpdate, before, commit: git(worktree, ["rev-parse", "HEAD"]).stdout, conflicts: [] };

  const conflicted = unmergedPaths(worktree);
  if (!conflicted.length) {
    throw domainError("MOVE_FAILED", `git merge ${base} failed before it could start.`, { details: [merged.stderr] });
  }
  return { state: "conflicts", branch, base, baseUpdate, before, commit: null, conflicts: conflicted };
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

// Fetches the base's upstream and fast-forwards the local base to it. Returns what happened, or
// null when the base tracks nothing. A failed fetch falls back to the last fetched state, so an
// offline run still merges what it has.
async function refreshBase(worktree, base) {
  const upstream = git(worktree, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${base}@{upstream}`]);
  if (!upstream.ok || !upstream.stdout) return null;
  const remote = git(worktree, ["config", "--get", `branch.${base}.remote`]).stdout;
  let fetched = false;
  if (remote && remote !== ".") {
    fetched = await fetchTrackingRefs(worktree, remote).then(() => true, () => false);
  }
  const from = git(worktree, ["rev-parse", `refs/heads/${base}`]).stdout;
  const to = git(worktree, ["rev-parse", upstream.stdout]).stdout;
  const report = { upstream: upstream.stdout, fetched, from, to, moved: false };
  if (from === to || git(worktree, ["merge-base", "--is-ancestor", to, from]).ok) return { ...report, to: from };

  const behind = Number(git(worktree, ["rev-list", "--count", `${base}..${to}`]).stdout || "0");
  const stale = `The local ${base} is ${behind} commit${behind === 1 ? "" : "s"} behind ${upstream.stdout}`;
  if (!git(worktree, ["merge-base", "--is-ancestor", from, to]).ok) {
    throw domainError("INVALID_CHANGE", `${stale} and has commits of its own, so it cannot be fast-forwarded.`, {
      resolution: `Ask the user to reconcile ${base} with ${upstream.stdout} in the checkout that holds it, then run sync-base again.`,
    });
  }
  const holder = checkoutHolding(worktree, base);
  if (holder) {
    const dirty = dirtyPaths(holder);
    if (dirty.length) {
      throw domainError("INVALID_CHANGE", `${stale}, and the checkout that has ${base} checked out has uncommitted changes, so it was not fast-forwarded.`, {
        resolution: `Ask the user to commit or clear the changes in ${holder} (or update ${base} there with \`git pull --ff-only\`), then run sync-base again.`,
        details: dirty,
      });
    }
    const forwarded = git(holder, ["merge", "--ff-only", "--quiet", to]);
    if (!forwarded.ok) throw domainError("MOVE_FAILED", `Fast-forwarding ${base} in ${holder} failed.`, { details: [forwarded.stderr] });
  } else {
    // The old-value argument makes the update refuse if another process moved the base meanwhile.
    const updated = git(worktree, ["update-ref", "-m", `sync-base: fast-forward to ${upstream.stdout}`, `refs/heads/${base}`, to, from]);
    if (!updated.ok) throw domainError("MOVE_FAILED", `Fast-forwarding ${base} failed.`, { details: [updated.stderr] });
  }
  return { ...report, moved: true };
}

// The checkout that has `branch` checked out, or null when none does.
function checkoutHolding(cwd, branch) {
  const entries = git(cwd, ["worktree", "list", "--porcelain"]).stdout.split("\n\n");
  const entry = entries.find((item) => item.split("\n").includes(`branch refs/heads/${branch}`));
  const found = entry && /^worktree (.+)$/m.exec(entry)?.[1];
  return found && fs.existsSync(found) ? fs.realpathSync(found) : null;
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
