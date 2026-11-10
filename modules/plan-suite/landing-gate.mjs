// Whether a plan's implementation reached the base branch. /plan-close records the absorbing commit
// under `## Verification` as `- Absorbing commit: <full commit id>`, so the landed check, the close
// transition, and plan-scoped worktree cleanup verify that one commit instead of rescanning base
// history. A recorded commit that no longer absorbs the branch falls back to the full scan.
import fs from "node:fs";
import { inspectBranchLanding, inspectCommitLanding } from "../repositories/worktree-landed.mjs";
import { linkedWorktreeNamed } from "./plan-git.mjs";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Past the completion preflight, which refuses a branch with no commits of its own.
const PREFLIGHT_PASSED = new Set(["review", "completed"]);
const ABSORBING_LINE = /^\s*[-*]\s+Absorbing commit:\s*`?([0-9a-f]+)`?\s*$/i;

// The full commit id on the first `- Absorbing commit:` line of the top-level `## Verification`
// section, or null when there is none or it is not a full id.
export function recordedAbsorbingCommit(markdown) {
  const lines = String(markdown || "").split("\n");
  const start = lines.findIndex((line) => /^##\s+verification\s*$/i.test(line));
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const match = ABSORBING_LINE.exec(line);
    if (match) return FULL_SHA.test(match[1].toLowerCase()) ? match[1].toLowerCase() : null;
  }
  return null;
}

// `markdown` is the plan's text, where /plan-close writes its verification; it defaults to the file
// in the store. `branch` skips resolving the plan's worktree when the caller already has it.
export async function planLanding({ primary, record, base, branch = null, markdown = null }) {
  if (!record.plan.worktree) return { landed: true, reason: "implemented on the base branch", absorbingCommit: null };
  const resolvedBranch = branch || linkedWorktreeNamed(primary, record.plan.worktree)?.branch || null;
  if (!resolvedBranch) {
    return { landed: false, reason: `worktree ${record.plan.worktree} has no resolvable branch`, absorbingCommit: null };
  }
  const content = markdown ?? fs.readFileSync(record.absolutePath, "utf8");
  const baseRef = `refs/heads/${base}`;
  const landing = await inspectBranchLanding(primary, resolvedBranch, { base: baseRef, recorded: recordedAbsorbingCommit(content) });
  // A fast-forward merge puts a branch's commits on the base's own line, which the generic branch
  // check can't tell from a branch that never had work. The preflight already ruled that out here, so
  // the tip being reachable from the base proves it landed.
  if (landing.reason === "no own work" && PREFLIGHT_PASSED.has(record.plan.lifecycle)) {
    return inspectCommitLanding(primary, landing.tip, { base: baseRef });
  }
  return landing;
}
