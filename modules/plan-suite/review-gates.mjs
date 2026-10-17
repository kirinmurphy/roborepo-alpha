// The two deterministic gates around review, both read from a plan's authoritative copy:
//
// - The completion preflight decides whether implementation is finished, which is what moves a plan
//   from Active to Review. It is not QA: a gate cannot prove the requirements were met, so the agent
//   still judges that, and /plan-review performs the independent check afterwards.
// - Approval freshness decides whether the human approval recorded in `## Review` still describes
//   the implementation. Plan documents are not implementation content, so only the tree outside
//   docs/plans is compared.
import { domainError, lifecycleFindings, parseFrontmatter, parsePlanMarkdown } from "./index.mjs";
import { isWorktreeBound } from "./plan-authority.mjs";
import { dirtyPaths, git } from "./plan-git.mjs";
import { authoritativeMarkdown } from "./worktree-copy.mjs";

const PLANS_DIR = "docs/plans";
// Built work no test covers stays open through review; /plan-close resolves it.
const PREFLIGHT_TOLERATED = new Set(["UNCONFIRMED_NOT_TESTED"]);
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// `record` is the primary checkout's record of a plan in Active or Review.
export function completionPreflight({ primary, record, base }) {
  if (!isWorktreeBound(record.plan.lifecycle)) {
    throw domainError("INVALID_CHANGE", `Only an active or review plan has an implementation to check; this one is ${record.plan.lifecycle}.`, {
      details: [record.plan.relativePath],
    });
  }
  const resolved = authoritativeMarkdown(primary, record);
  const { worktree, authority } = resolved;
  const checks = [];
  const check = (n, name, ok, observed, fix) => checks.push({ n, name, ok, observed, ...(ok ? {} : { fix }) });

  const assigned = authority.source === "worktree";
  check(1, "the assigned worktree holds the plan", assigned,
    assigned ? `${worktree.name} on ${worktree.branch || "a detached HEAD"}` : (record.plan.worktree ? `worktree ${record.plan.worktree}: ${authority.reason}` : "no worktree assigned"),
    record.plan.worktree ? "restore the worktree, or record a reachable one with `roborepo plans start`" : "implement the plan in a worktree started with `roborepo plans start`");

  const { findings, parsed } = lifecycleFindings(resolved.markdown, { lifecycle: "review" });
  const open = openTasks(parsed);
  check(2, "no unchecked task outside Not tested", open.length === 0,
    open.length ? open.slice(0, 5).map((task) => `line ${task.line + frontmatterLines(resolved.markdown)}: ${task.text}`).join("; ") : "all tasks checked",
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
    "resolve the listed findings in the worktree's copy of the plan");

  return {
    ok: checks.every((item) => item.ok),
    plan: { id: record.plan.id, path: resolved.relativePath, lifecycle: record.plan.lifecycle },
    worktree: worktree ? { name: worktree.name, path: worktree.path, branch: worktree.branch } : null,
    checks,
  };
}

// Returns { state, ... } where state is "unavailable", "missing", "not-approved", "invalid", "stale",
// or "fresh". `tip` is the implementation the approval must still describe: the assigned worktree's
// branch tip, or the base branch for a plan that names no worktree.
export function approvalFreshness({ primary, record, base }) {
  const resolved = authoritativeMarkdown(primary, record);
  const approval = readApproval(resolved.markdown);
  const branch = resolved.worktree?.branch || null;
  const tipRef = branch ? `refs/heads/${branch}` : base;
  const tip = git(primary, ["rev-parse", "--verify", "-q", `${tipRef}^{commit}`]).stdout;
  const result = { plan: { id: record.plan.id, path: resolved.relativePath }, branch, tip: tip || null, approval };
  // The plan records only its worktree's name, so without that worktree's branch neither the reviewed
  // implementation nor the authoritative copy can be resolved. Comparing against the base branch
  // instead would report every later base commit as an implementation change.
  if (record.plan.worktree && !branch) {
    const cause = resolved.worktree ? "has a detached HEAD" : "is not a linked worktree of this repository";
    return { ...result, state: "unavailable", reason: `worktree ${record.plan.worktree} ${cause}, so the reviewed branch cannot be resolved` };
  }
  if (!approval.present) return { ...result, state: "missing", reason: "the plan has no `### Approval` record under `## Review`" };
  if (approval.decision !== "approved") return { ...result, state: "not-approved", reason: `the recorded decision is ${approval.decision || "empty"}` };
  if (!approval.confirmedBy) return { ...result, state: "invalid", reason: "the approval does not say who confirmed it" };
  if (!FULL_SHA.test(approval.commit || "")) return { ...result, state: "invalid", reason: "the reviewed implementation commit is not a full commit id" };
  if (!git(primary, ["cat-file", "-e", `${approval.commit}^{commit}`]).ok) return { ...result, state: "invalid", reason: `commit ${approval.commit} does not exist in this repository` };
  if (!tip) return { ...result, state: "invalid", reason: `${tipRef} does not resolve` };
  const changed = git(primary, ["diff", "--name-only", approval.commit, tip, "--", ".", `:(exclude)${PLANS_DIR}`]);
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
