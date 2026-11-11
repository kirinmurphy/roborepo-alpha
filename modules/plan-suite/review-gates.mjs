// The two deterministic gates around review, both reading the plan from the store and judging the
// implementation from its code branch:
//
// - The completion preflight decides whether implementation is finished, which is what moves a plan
//   from Active to Review. It is not QA: a gate cannot prove the requirements were met, so the agent
//   still judges that, /plan-execute's validation loop checks the work first, and /plan-review
//   brings it to the human.
// - Approval freshness decides whether the human approval recorded in `## Review` still describes
//   the implementation. A plans-branch commit never touches a code branch, so it can never make an
//   approval stale.
import fs from "node:fs";
import { domainError, lifecycleFindings, parseFrontmatter, parsePlanMarkdown } from "./index.mjs";
import { LIFECYCLE_MODEL } from "./lifecycle-manifest.mjs";
import { dirtyPaths, git, linkedWorktreeNamed } from "./plan-git.mjs";
import { reviewFreshness } from "./review-freshness.mjs";

// Built work no test covers stays open through review; /plan-close resolves it.
const PREFLIGHT_TOLERATED = new Set(["UNCONFIRMED_NOT_TESTED"]);
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// `primary` is the code repository's main checkout; `record` is the plan's record from the store.
export function completionPreflight({ primary, record, base }) {
  if (!LIFECYCLE_MODEL.worktreeBound.has(record.plan.lifecycle)) {
    throw domainError("INVALID_CHANGE", `Only an active or review plan has an implementation to check; this one is ${record.plan.lifecycle}.`, {
      details: [record.plan.relativePath],
    });
  }
  const markdown = fs.readFileSync(record.absolutePath, "utf8");
  const worktree = linkedWorktreeNamed(primary, record.plan.worktree);
  const checks = [];
  const check = (n, name, ok, observed, fix) => checks.push({ n, name, ok, observed, ...(ok ? {} : { fix }) });

  const assigned = Boolean(worktree);
  check(1, "the assigned worktree exists on this machine", assigned,
    assigned ? `${worktree.name} on ${worktree.branch || "a detached HEAD"}` : (record.plan.worktree ? `no linked worktree is named ${record.plan.worktree}` : "no worktree assigned"),
    record.plan.worktree ? "restore the worktree, or record a reachable one with `roborepo plans start`" : "implement the plan in a worktree started with `roborepo plans start`");

  const { findings, parsed } = lifecycleFindings(markdown, { lifecycle: "review" });
  const open = openTasks(parsed);
  check(2, "no unchecked task outside Not tested", open.length === 0,
    open.length ? open.slice(0, 5).map((task) => `line ${task.line + frontmatterLines(markdown)}: ${task.text}`).join("; ") : "all tasks checked",
    "finish the remaining tasks, or record why each is deferred and remove it from the checklist");

  const blockers = parsed.frontmatter.blocked_by || [];
  check(3, "blocked_by is empty", blockers.length === 0, blockers.length ? blockers.join(", ") : "(none)",
    "resolve each blocker, then clear `blocked_by`");

  const dirty = assigned ? dirtyPaths(worktree.path) : [];
  check(4, "the worktree has no uncommitted changes", assigned && dirty.length === 0,
    assigned ? (dirty.length ? dirty.slice(0, 10).join("; ") : "(clean)") : "no worktree",
    "commit the remaining work in the worktree");

  const own = assigned && worktree.branch ? Number(git(primary, ["rev-list", "--count", `${base}..refs/heads/${worktree.branch}`]).stdout || "0") : 0;
  check(5, "the feature branch has commits of its own", own > 0, `${own} commit${own === 1 ? "" : "s"} not on ${base}`,
    "commit the implementation on the feature branch");

  const remaining = findings.filter((item) => !PREFLIGHT_TOLERATED.has(item.code));
  check(6, "the plan passes the review validator", remaining.length === 0,
    remaining.length ? remaining.map((item) => item.code).join(", ") : "no findings apart from Not tested entries",
    "resolve the listed findings in the plan with `roborepo plans save`");

  return {
    ok: checks.every((item) => item.ok),
    plan: { id: record.plan.id, path: record.plan.relativePath, lifecycle: record.plan.lifecycle },
    worktree: worktree ? { name: worktree.name, path: worktree.path, branch: worktree.branch } : null,
    checks,
  };
}

// Returns { state, ... } where state is "unavailable", "missing", "not-approved", "invalid", "stale",
// or "fresh". `tip` is the implementation the approval must still describe: the assigned worktree's
// branch tip, or the base branch for a plan that names no worktree.
export function approvalFreshness({ primary, record, base }) {
  const markdown = fs.readFileSync(record.absolutePath, "utf8");
  const worktree = linkedWorktreeNamed(primary, record.plan.worktree);
  const approval = readApproval(markdown);
  const branch = worktree?.branch || null;
  const tipRef = branch ? `refs/heads/${branch}` : base;
  const tip = git(primary, ["rev-parse", "--verify", "-q", `${tipRef}^{commit}`]).stdout;
  const review = reviewFreshness({ primary, markdown, tip, base,
    workingPath: worktree?.path || primary, available: !record.plan.worktree || Boolean(branch) });
  const result = { plan: { id: record.plan.id, path: record.plan.relativePath }, branch, tip: tip || null, review, approval };
  // The plan records only its worktree's name, so without that worktree's branch the reviewed
  // implementation cannot be resolved. Comparing against the base branch instead would report every
  // later base commit as an implementation change.
  if (record.plan.worktree && !branch) {
    const cause = worktree ? "has a detached HEAD" : "is not a linked worktree of this repository";
    return { ...result, state: "unavailable", reason: `worktree ${record.plan.worktree} ${cause}, so the reviewed branch cannot be resolved` };
  }
  if (!approval.present) return { ...result, state: "missing", reason: "the plan has no `### Approval` record under `## Review`" };
  if (approval.decision !== "approved") return { ...result, state: "not-approved", reason: `the recorded decision is ${approval.decision || "empty"}` };
  if (!approval.confirmedBy) return { ...result, state: "invalid", reason: "the approval does not say who confirmed it" };
  if (!FULL_SHA.test(approval.commit || "")) return { ...result, state: "invalid", reason: "the reviewed implementation commit is not a full commit id" };
  if (!git(primary, ["cat-file", "-e", `${approval.commit}^{commit}`]).ok) return { ...result, state: "invalid", reason: `commit ${approval.commit} does not exist in this repository` };
  if (!tip) return { ...result, state: "invalid", reason: `${tipRef} does not resolve` };
  const changed = git(primary, ["diff", "--name-only", approval.commit, tip]);
  if (!changed.ok) return { ...result, state: "invalid", reason: `the approved commit could not be compared with ${tipRef}` };
  const paths = changed.stdout.split("\n").filter(Boolean);
  if (paths.length) return { ...result, state: "stale", reason: `implementation changed since approval`, changedPaths: paths.slice(0, 20), changedCount: paths.length };
  return { ...result, state: "fresh", reason: null };
}

// The `### Approval` record under `## Review` (review-record.mjs), or { present: false }.
export function readApproval(markdown) {
  const { approval } = parsePlanMarkdown(markdown).review;
  return approval ? { present: true, ...approval } : { present: false };
}

// Unchecked tasks outside `## Not tested`. Open review findings are tasks too, so an unresolved
// finding keeps implementation incomplete.
function openTasks(parsed) {
  const notTested = new Set(parsed.notTested.entries.map((task) => task.line));
  return parsed.tasks.filter((task) => !task.done && !notTested.has(task.line));
}

// Parsed task lines count from the start of the body, so a line shown to a reader needs the lines
// the frontmatter occupies added back to match the file.
function frontmatterLines(markdown) {
  return markdown.split("\n").length - parseFrontmatter(markdown).body.split("\n").length;
}

// Read-only merge preparation. Approval alone does not establish a committed, clean review packet
// or a review against today's implementation base; none of these checks authorizes a merge.
export function mergeReadiness({ primary, record, base = "main" }) {
  const worktree = linkedWorktreeNamed(primary, record.plan.worktree);
  const assessedTip = worktree?.branch ? git(primary, ["rev-parse", `refs/heads/${worktree.branch}`]).stdout : null;
  const assessedBase = git(primary, ["rev-parse", base]).stdout;
  const markdown = fs.readFileSync(record.absolutePath, "utf8");
  const checks = [];
  const check = (name, ok, observed, fix) => checks.push({ n: checks.length + 1, name, ok: Boolean(ok), observed, ...(ok ? {} : { fix }) });
  const approval = approvalFreshness({ primary, record, base });
  const parsed = parsePlanMarkdown(markdown);
  const unfinished = openTasks(parsed);
  const blockers = parsed.frontmatter.blocked_by || [];
  check("required tasks and blockers resolved", !unfinished.length && !blockers.length,
    [...unfinished.map((task) => task.text), ...blockers].join("; ") || "all required tasks complete; no blockers", "finish required tasks and resolve blockers before merging");
  check("assigned branch available", Boolean(assessedTip), assessedTip || `no linked worktree is named ${record.plan.worktree || "(none)"}`, "restore the assigned implementation worktree");
  check("explicit approval is fresh", approval.state === "fresh", approval.reason || approval.state, "record explicit human approval of the current implementation");
  check("review is complete and fresh", approval.review.state === "fresh", approval.review.reason || approval.review.state, "complete review and required checks for the current implementation");
  const basePaths = approval.review.baseChangedPaths || [];
  check("reviewed base implementation is current", approval.review.state === "fresh" && !basePaths.length, basePaths.join("; ") || "no implementation changes on base", "renew review against the current base implementation");
  const status = worktree ? git(worktree.path, ["status", "--porcelain", "--untracked-files=all"]) : { ok: false };
  check("worktree is clean", status.ok && !status.stdout, status.stdout || (status.ok ? "clean" : "unavailable"), "commit all staged, unstaged, and untracked changes");
  const storeRoot = record.repository.root;
  const committed = git(storeRoot, ["show", `HEAD:${record.plan.relativePath}`]);
  check("review packet is committed", committed.ok && committed.raw === markdown, committed.ok ? "compared to the plans branch" : "unavailable", "save the plan's Result with `roborepo plans save` and its Approval with `roborepo plans approve`");
  const tipNow = worktree?.branch ? git(primary, ["rev-parse", `refs/heads/${worktree.branch}`]).stdout : null;
  check("assessed state stayed stable", fs.readFileSync(record.absolutePath, "utf8") === markdown && linkedWorktreeNamed(primary, record.plan.worktree)?.branch === worktree?.branch && tipNow === assessedTip && git(primary, ["rev-parse", base]).stdout === assessedBase,
    "branch, base, and plan compared again", "rerun readiness after concurrent changes stop");
  return { ok: checks.every((item) => item.ok), assessedTip, assessedBase, branch: worktree?.branch || null, plan: { id: record.plan.id, path: record.plan.relativePath }, checks };
}
