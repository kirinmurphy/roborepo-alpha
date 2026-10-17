// Whether a worktree-bound plan's worktree copy has reached the base branch, and what archiving may
// do about it when it has not.
//
// A worktree copy is integrated when the base branch already has every plan version the worktree
// has: the two copies are byte-identical, or the worktree copy's blob is the plan at the branch's
// fork or a plan blob the base branch produced since then. Matching by content needs no path
// tracking, so a copy still in active/ is integrated against a primary copy already in review/.
import fs from "node:fs";
import path from "node:path";
import { blobId, checkOutsideEdits, producedBlobs } from "./plan-authority.mjs";
import { git } from "./plan-git.mjs";
import { assignedWorktreeCopy } from "./worktree-copy.mjs";

// Returns { state, worktree, copy, reason } where state is:
//   "no-worktree"     the plan names no worktree; there is nothing to integrate
//   "unavailable"     the worktree or its copy cannot be used (reason says why)
//   "integrated"      the base branch has every plan version the worktree has
//   "not-integrated"  the worktree holds a version the base branch never had; `primaryConsistent`
//                     says whether the primary copy is one the worktree branch already had, and is
//                     null when Git cannot answer
export function worktreeCopyIntegration(primary, record) {
  if (!record.plan.worktree) return { state: "no-worktree", worktree: null, copy: null, reason: null };
  const { authority, worktree, copy } = assignedWorktreeCopy(primary, record);
  if (authority.source !== "worktree") return { state: "unavailable", worktree, copy: null, reason: authority.reason };

  const primaryBytes = fs.readFileSync(path.join(primary, record.plan.relativePath));
  const copyBytes = Buffer.from(copy.markdown, "utf8");
  if (Buffer.compare(primaryBytes, copyBytes) === 0) return { state: "integrated", worktree, copy, reason: null };
  if (!worktree.branch) return { state: "unavailable", worktree, copy: null, reason: "the worktree's HEAD is detached" };

  const branchRef = `refs/heads/${worktree.branch}`;
  const fork = git(primary, ["merge-base", "HEAD", branchRef]);
  const format = git(primary, ["rev-parse", "--show-object-format"]);
  if (!fork.ok || !format.ok) return { state: "unavailable", worktree, copy: null, reason: "no merge base with the worktree branch" };
  const known = producedBlobs(git(primary, ["log", "--raw", "--no-abbrev", "--format=", `${fork.stdout}..HEAD`, "--", "docs/plans"]).stdout);
  const atFork = git(primary, ["rev-parse", "--verify", "-q", `${fork.stdout}:${copy.relativePath}`]);
  if (atFork.ok) known.add(atFork.stdout);
  if (known.has(blobId(copyBytes, format.stdout))) return { state: "integrated", worktree, copy, reason: null };

  const outside = checkOutsideEdits({
    primary: { checkoutPath: primary, relativePath: record.plan.relativePath, bytes: primaryBytes },
    assigned: { checkoutPath: worktree.path, branch: worktree.branch, bytes: copyBytes },
  });
  const primaryConsistent = outside.state === "consistent" ? true : outside.state === "outside-edit" ? false : null;
  return { state: "not-integrated", worktree, copy, primaryConsistent, reason: null };
}

// The archive copy table: abandoned work never merges, so archiving carries the worktree copy's
// content to the base branch once, one way, and never merges two edited copies.
// Returns { carry: null | markdown, worktreeCopy, refusal } where `refusal` is a reason string.
export function archiveCarry(primary, record) {
  const integration = worktreeCopyIntegration(primary, record);
  if (integration.state === "no-worktree" || integration.state === "integrated") {
    return { carry: null, worktreeCopy: integration.state, refusal: null };
  }
  if (integration.state === "unavailable") return { carry: null, worktreeCopy: `unavailable: ${integration.reason}`, refusal: null };
  if (integration.primaryConsistent) return { carry: integration.copy.markdown, worktreeCopy: "carried", refusal: null };
  return {
    carry: null,
    worktreeCopy: "conflicting",
    refusal: integration.primaryConsistent === false
      ? `conflicting copies: the primary checkout's ${record.plan.relativePath} holds a version worktree ${record.plan.worktree} never had`
      : `conflicting copies could not be ruled out for worktree ${record.plan.worktree}`,
  };
}
