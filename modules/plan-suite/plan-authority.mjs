// Which copy of a plan is authoritative, and whether the other copy was edited out of turn.
//
// The primary checkout's copy decides which lifecycle stage a plan is in, because every lifecycle
// transition is committed there. While a plan is in a worktree-bound stage (Active or Review) and
// its assigned worktree holds a usable copy, that worktree's copy decides what the plan says. Both
// answers are derived from current Git and filesystem state on every call; nothing is stored, so
// any RoboRepo instance, from any checkout, reaches the same answer.
import crypto from "node:crypto";
import { defaultRunGitSync } from "../repositories/git-exec.mjs";
import { LIFECYCLE_MODEL } from "./lifecycle-manifest.mjs";

// `primary` and `assigned.copy` are { lifecycle, worktree } read from each copy's path and
// frontmatter. `assigned` is null when Git has no linked worktree by the primary copy's `worktree`
// name, and `assigned.copy` is null when that worktree has no readable copy of the plan.
// Returns { source: "primary" | "worktree", reason }, where `reason` explains a fallback to the
// primary copy that the plan should hear about, and is null otherwise.
export function resolvePlanAuthority({ primary, assigned }) {
  if (!isWorktreeBound(primary?.lifecycle) || !primary.worktree) return { source: "primary", reason: null };
  if (!assigned) return { source: "primary", reason: "worktree-missing" };
  const copy = assigned.copy;
  if (!copy) return { source: "primary", reason: "copy-missing" };
  // A worktree that does not yet contain the start commit still holds the plan in
  // ready/ or without its worktree name, so it becomes authoritative only once it has that commit.
  // Its copy may sit in active/ while the primary copy is already in review/: the primary moves
  // first, and the worktree receives the rename at its next base synchronization.
  if (!isWorktreeBound(copy.lifecycle)) return { source: "primary", reason: "copy-not-active" };
  if (copy.worktree !== primary.worktree) return { source: "primary", reason: "copy-other-worktree" };
  return { source: "worktree", reason: null };
}

// Active and Review: the stages whose assigned worktree holds the authoritative copy and is in use.
export function isWorktreeBound(lifecycle) {
  return LIFECYCLE_MODEL.worktreeBound.has(lifecycle);
}

// Whether the non-authoritative primary copy of a worktree-bound plan holds a version its worktree never
// had. The primary copy is consistent when its bytes equal the plan at the merge base of the
// primary HEAD and the worktree branch, a plan blob the branch's own commits produced, or the
// worktree's working bytes. Matching by content needs no path tracking: an equal blob carries the
// same `id`.
//
// `primary` is { checkoutPath, relativePath, bytes }; `assigned` is { checkoutPath, branch, bytes },
// with a null branch for a detached worktree. Returns { state: "consistent" }, { state:
// "outside-edit", committed }, or { state: "unchecked", reason } when Git cannot answer. Reasons
// never carry paths.
export function checkOutsideEdits({ primary, assigned, runGit = defaultRunGitSync }) {
  if (Buffer.compare(primary.bytes, assigned.bytes) === 0) return { state: "consistent" };
  const branch = assigned.branch === REFTABLE_HEAD_BRANCH ? checkedOutBranch(assigned.checkoutPath, runGit) : assigned.branch;
  if (!branch) return unchecked("the worktree's HEAD is detached");
  const git = (args) => runGit(primary.checkoutPath, args);
  if (!git(["symbolic-ref", "-q", "HEAD"]).ok) return unchecked("the primary checkout's HEAD is detached");
  const format = git(["rev-parse", "--show-object-format"]);
  if (!format.ok) return unchecked("the object format could not be read");
  const branchRef = `refs/heads/${branch}`;
  const base = git(["merge-base", "HEAD", branchRef]);
  if (!base.ok) return unchecked("no merge base with the worktree branch");
  const baseCommit = base.stdout.trim();
  const history = git(["log", "--raw", "--no-abbrev", "--format=", `${baseCommit}..${branchRef}`, "--", "docs/plans"]);
  if (!history.ok) return unchecked("the worktree branch's plan history could not be read");

  const primaryBlob = blobId(primary.bytes, format.stdout.trim());
  const known = producedBlobs(history.stdout);
  const atBase = git(["rev-parse", "--verify", "-q", `${baseCommit}:${primary.relativePath}`]);
  if (atBase.ok) known.add(atBase.stdout.trim());
  if (known.has(primaryBlob)) return { state: "consistent" };
  const atHead = git(["rev-parse", "--verify", "-q", `HEAD:${primary.relativePath}`]);
  return { state: "outside-edit", committed: atHead.ok && atHead.stdout.trim() === primaryBlob };
}

// Git's object id for a blob, computed in process because `hash-object` is not on the read-only
// allow-list. No clean filters or line-ending conversion apply, so a repository whose filters
// rewrite Markdown can see a false outside edit; the finding it causes is advisory.
export function blobId(bytes, objectFormat = "sha1") {
  const algorithm = objectFormat === "sha256" ? "sha256" : "sha1";
  return crypto.createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

// `git log --raw` lines read ":<mode> <mode> <old> <new> <status>\t<path>"; the new blob is the
// version that commit produced. An all-zero id is a deletion.
export function producedBlobs(rawLog) {
  const blobs = new Set();
  for (const line of rawLog.split("\n")) {
    const fields = line.startsWith(":") ? line.slice(1).split(/\s+/) : [];
    const produced = fields[3];
    if (produced && !/^0+$/.test(produced)) blobs.add(produced);
  }
  return blobs;
}

// A reftable repository keeps HEAD in the reftable and writes `ref: refs/heads/.invalid` to every
// HEAD file, so a branch read from that file is this placeholder; `.invalid` can never name a real
// branch. Only Git can say which branch such a worktree has checked out.
const REFTABLE_HEAD_BRANCH = ".invalid";

function checkedOutBranch(checkoutPath, runGit) {
  const head = checkoutPath ? runGit(checkoutPath, ["symbolic-ref", "-q", "HEAD"]) : { ok: false };
  const ref = head.ok ? head.stdout.trim() : "";
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

function unchecked(reason) {
  return { state: "unchecked", reason };
}
