// Merges the base branch into a plan's implementation branch, from that branch's linked worktree.
// /plan-execute runs it before handing a plan off and /plan-review at the start of every review
// round, so it does nothing when base has nothing new, or when base already absorbed the branch. It
// never merges the other way and never resolves a conflict by picking a side.
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
import { inspectBranchLanding } from "../repositories/worktree-landed.mjs";
import { domainError } from "./index.mjs";
import { PLANS_BRANCH } from "./plan-store.mjs";
import { currentBranch, git, primaryCheckout, topLevel } from "./plan-git.mjs";

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
  if (git(worktree, ["symbolic-ref", "-q", `refs/heads/${base}`]).ok) {
    throw domainError("INVALID_CHANGE", `The base ${base} is a symbolic ref; pass the branch it points to.`);
  }
  const merging = git(worktree, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]).ok;
  // A paused merge already chose its base commit; a later sync-base picks up anything newer.
  if (continueMerge) return continueSync({ worktree, branch, base, merging });
  if (merging) {
    throw domainError("INVALID_CHANGE", "A merge is already in progress in this worktree.", {
      resolution: "Resolve the conflicts, stage the result, run the repository's checks, then run sync-base --continue.",
    });
  }
  const dirty = cleanStatus(worktree);
  if (dirty.length) {
    throw domainError("INVALID_CHANGE", "The worktree has uncommitted changes, so base was not merged.", {
      resolution: "Commit the work in progress first; sync-base never merges over uncommitted changes.",
      details: dirty,
    });
  }

  const baseUpdate = await refreshBase(worktree, base);
  // The fetch can take a while; the worktree must still be on the same clean branch to merge.
  if (currentBranch(worktree) !== branch || git(worktree, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]).ok || cleanStatus(worktree).length) {
    throw domainError("INVALID_CHANGE", `The worktree changed while ${base} was refreshed, so base was not merged.`, {
      resolution: `Return the worktree to ${branch} with no uncommitted changes, then run sync-base again.`,
    });
  }

  // Merge the exact commit just compared, not the base ref, which another process may move.
  const baseCommit = baseUpdate?.to || git(worktree, ["rev-parse", `refs/heads/${base}`]).stdout;
  const before = git(worktree, ["rev-parse", "HEAD"]).stdout;
  if (git(worktree, ["merge-base", "--is-ancestor", baseCommit, "HEAD"]).ok) {
    return { state: "up-to-date", branch, base, baseUpdate, before, commit: before, conflicts: [] };
  }
  // Once the branch's pull request has merged, base already holds its work. Merging base back in
  // would only add a commit the reviewed approval does not cover.
  const landing = await inspectBranchLanding(worktree, branch, { base: `refs/heads/${base}` });
  if (landing.landed) {
    return { state: "landed", branch, base, baseUpdate, before, commit: before, absorbingCommit: landing.absorbingCommit, conflicts: [] };
  }
  const merged = git(worktree, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${base} into ${branch}`, baseCommit]);
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
  // The paused merge's own base commit: another sync can move the base ref while it waits.
  const mergeHead = git(worktree, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]).stdout;
  const committed = git(worktree, ["commit", "--quiet", "--no-edit"]);
  if (!committed.ok) throw domainError("MOVE_FAILED", "The merge commit failed.", { details: [committed.stderr] });
  const commit = git(worktree, ["rev-parse", "HEAD"]).stdout;
  const parents = git(worktree, ["rev-list", "--parents", "-n", "1", commit]).stdout.split(" ").length - 1;
  if (parents !== 2 || !mergeHead || !git(worktree, ["merge-base", "--is-ancestor", mergeHead, commit]).ok) {
    throw domainError("MOVE_FAILED", `The commit on ${branch} does not merge ${base}.`, { details: [commit] });
  }
  return { state: "merged", branch, base, commit, conflicts: [] };
}

// Fetches the base's upstream and fast-forwards the local base to it. Returns what happened, or
// null when the base tracks nothing. `fetch` is "fetched", "failed" (the comparison used the last
// fetched commit, so an offline run still merges what it has), or "local" (the upstream is a local
// branch, which needs no fetch).
async function refreshBase(worktree, base) {
  const upstream = upstreamOf(worktree, base);
  if (!upstream) return null;
  let fetch = "local";
  if (upstream.remote !== ".") {
    fetch = await fetchTrackingRefs(worktree, upstream.remote).then(() => "fetched", () => "failed");
  }
  const from = git(worktree, ["rev-parse", `refs/heads/${base}`]).stdout;
  const to = git(worktree, ["rev-parse", "--verify", "-q", `${upstream.ref}^{commit}`]).stdout;
  if (!to) {
    throw domainError("INVALID_CHANGE", `${base}'s upstream ${upstream.name} could not be verified: ${fetch === "failed" ? "the fetch failed and no fetched copy exists" : "it does not exist"}.`, {
      resolution: `Ask the user to check ${base}'s upstream (\`git branch -vv\`) and network access, then run sync-base again.`,
    });
  }
  const report = { upstream: upstream.name, fetch, from, to, moved: false };
  if (from === to || git(worktree, ["merge-base", "--is-ancestor", to, from]).ok) return { ...report, to: from };

  const behind = Number(git(worktree, ["rev-list", "--count", `${from}..${to}`]).stdout || "0");
  const stale = `The local ${base} is ${behind} commit${behind === 1 ? "" : "s"} behind ${upstream.name}`;
  if (!git(worktree, ["merge-base", "--is-ancestor", from, to]).ok) {
    throw domainError("INVALID_CHANGE", `${stale} and has commits of its own, so it cannot be fast-forwarded.`, {
      resolution: `Ask the user to reconcile ${base} with ${upstream.name} in the checkout that holds it, then run sync-base again.`,
    });
  }
  const holder = checkoutHolding(worktree, base);
  if (holder) {
    const dirty = cleanStatus(holder);
    if (dirty.length) {
      throw domainError("INVALID_CHANGE", `${stale}, and the checkout that has ${base} checked out has uncommitted changes, so it was not fast-forwarded.`, {
        resolution: `Ask the user to commit or clear the changes in ${holder} (or update ${base} there with \`git pull --ff-only\`), then run sync-base again.`,
        details: dirty,
      });
    }
    // Recheck right before moving: the holder must still be on the base at the commit compared.
    const onBase = git(holder, ["symbolic-ref", "-q", "HEAD"]).stdout === `refs/heads/${base}`;
    if (!onBase || git(holder, ["rev-parse", "HEAD"]).stdout !== from) {
      throw domainError("INVALID_CHANGE", `The checkout holding ${base} changed while it was checked, so ${base} was not fast-forwarded.`, {
        resolution: "Run sync-base again.",
      });
    }
    // Git cannot lock a checkout against a branch switch, and `merge --ff-only` moves whatever
    // branch HEAD names at that instant. So the base ref moves on its own, guarded by its old
    // value, and the checkout's files follow with a two-tree read-tree, which moves no ref and
    // refuses to overwrite local changes. A switch in between can at worst leave uncommitted
    // changes in the other checkout; it can never advance another branch.
    moveRef(worktree, base, to, from, upstream.name);
    if (git(holder, ["symbolic-ref", "-q", "HEAD"]).stdout !== `refs/heads/${base}`) {
      throw domainError("MOVE_FAILED", `${base} was fast-forwarded to ${to}, but ${holder} switched branches meanwhile, so its files were not updated.`, {
        resolution: `Ask the user to check out ${base} in ${holder} again; nothing else was changed.`,
      });
    }
    const files = git(holder, ["read-tree", "-u", "-m", from, to]);
    if (!files.ok) {
      // Put the ref back so the checkout and its branch agree again.
      const undone = git(worktree, ["update-ref", "-m", "sync-base: undo fast-forward", `refs/heads/${base}`, from, to]);
      if (!undone.ok) {
        throw domainError("MOVE_FAILED", `Updating the files in ${holder} failed, and ${base} could not be put back: it is at ${to} while the checkout's files are still at ${from}.`, {
          resolution: `Ask the user to run \`git -C ${holder} reset --keep ${from}\` (or check out ${base} again) so the branch and its files agree.`,
          details: [files.stderr, undone.stderr],
        });
      }
      throw domainError("MOVE_FAILED", `Updating the files in ${holder} failed, so ${base} was put back at ${from}.`, { details: [files.stderr] });
    }
  } else {
    moveRef(worktree, base, to, from, upstream.name);
  }
  return { ...report, moved: true };
}

// Moves only refs/heads/<base>, and only from `from`: the old-value argument makes the update refuse
// if another process moved the base meanwhile.
function moveRef(worktree, base, to, from, upstreamName) {
  const updated = git(worktree, ["update-ref", "-m", `sync-base: fast-forward to ${upstreamName}`, `refs/heads/${base}`, to, from]);
  if (!updated.ok) throw domainError("MOVE_FAILED", `Fast-forwarding ${base} failed.`, { details: [updated.stderr] });
}

// The base's configured upstream, resolved to the ref the guarded fetch refreshes
// (`refs/remotes/<remote>/<branch>`) rather than through the remote's own refspecs, which may map
// elsewhere or point at a ref that does not exist yet.
function upstreamOf(worktree, base) {
  const remote = git(worktree, ["config", "--get", `branch.${base}.remote`]).stdout;
  const merge = git(worktree, ["config", "--get", `branch.${base}.merge`]).stdout;
  if (!remote || !merge.startsWith("refs/heads/")) return null;
  const branch = merge.slice("refs/heads/".length);
  if (remote === ".") return { remote, ref: merge, name: branch };
  return { remote, ref: `refs/remotes/${remote}/${branch}`, name: `${remote}/${branch}` };
}

// Status paths for a checkout, refusing when Git cannot report them: empty output from a failed
// status would otherwise read as clean.
function cleanStatus(cwd) {
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (!status.ok) throw domainError("MOVE_FAILED", `Git could not read the status of ${cwd}.`, { details: [status.stderr] });
  return status.raw.split("\n").filter(Boolean);
}

// The checkout that has `branch` checked out, or null after a successful inventory finds none. A
// registered holder whose folder cannot be reached (an unmounted drive) refuses rather than reading
// as absent, since moving the ref alone would leave that checkout's files behind.
function checkoutHolding(cwd, branch) {
  const list = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!list.ok) throw domainError("MOVE_FAILED", "git worktree list failed.", { details: [list.stderr] });
  const entry = list.stdout.split("\n\n").find((item) => item.split("\n").includes(`branch refs/heads/${branch}`));
  if (!entry) return null;
  const found = /^worktree (.+)$/m.exec(entry)?.[1];
  if (!found || !fs.existsSync(found)) {
    throw domainError("INVALID_CHANGE", `${branch} is checked out in a worktree that cannot be reached, so it was not fast-forwarded.`, {
      resolution: `Ask the user to make ${found || "that worktree"} available or update ${branch} there, then run sync-base again.`,
    });
  }
  return fs.realpathSync(found);
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
