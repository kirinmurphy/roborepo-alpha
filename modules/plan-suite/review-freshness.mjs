// Review completion describes checked implementation; it never supplies human approval.
import { parsePlanMarkdown } from "./index.mjs";
import { git } from "./plan-git.mjs";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function reviewFreshness({ primary, markdown, tip, base, workingPath = primary, available = true }) {
  const parsed = parsePlanMarkdown(markdown);
  const result = parsed.review.result;
  const verdict = (state, reason, details = {}) => ({ state, reason, result, ...details });
  if (!available || !tip) return verdict("unavailable", "the implementation branch cannot be resolved");
  if (!result) return verdict("missing", "the plan has no `### Result` record under `## Review`");
  if (result.status !== "complete") return verdict("incomplete", `the recorded review status is ${result.status || "empty"}`);
  if (parsed.review.findings.open || parsed.notTested.unchecked) {
    return verdict("incomplete", "review findings or required manual checks remain open");
  }
  const dirty = git(workingPath, ["diff", "--name-only", "HEAD", "--", ".", ":(exclude)docs/plans"]);
  const untracked = git(workingPath, ["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude)docs/plans"]);
  if (!dirty.ok || !untracked.ok) return verdict("unavailable", "working implementation changes could not be checked");
  const pending = [...new Set(`${dirty.stdout}\n${untracked.stdout}`.split("\n").filter(Boolean))];
  if (pending.length) return verdict("incomplete", "uncommitted implementation changes remain", { changedPaths: pending });
  for (const [name, commit] of [["reviewed implementation", result.commit], ["base", result.baseCommit]]) {
    if (!FULL_SHA.test(commit) || !git(primary, ["cat-file", "-e", `${commit}^{commit}`]).ok) {
      return verdict("invalid", `the ${name} commit is not a resolvable full commit id`);
    }
  }
  const changed = changedPaths(primary, result.commit, tip);
  if (!changed) return verdict("unavailable", "the reviewed implementation could not be compared with the current tip");
  if (changed.length) return verdict("stale", "implementation changed since review", { changedPaths: changed });
  const baseChanged = changedPaths(primary, result.baseCommit, base);
  if (!baseChanged) return verdict("unavailable", "the reviewed base could not be compared with the current base");
  return verdict("fresh", null, { baseChangedPaths: baseChanged });
}

function changedPaths(primary, from, to) {
  const result = git(primary, ["diff", "--name-only", from, to, "--", ".", ":(exclude)docs/plans"]);
  return result.ok ? result.stdout.split("\n").filter(Boolean) : null;
}
