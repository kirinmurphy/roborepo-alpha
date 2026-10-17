// The one lifecycle transition operation: every committed move between lifecycle folders runs here,
// in the primary checkout, so the portal and every checkout agree on which stage a plan is in.
//
// It resolves the plan, checks the move against the lifecycle manifest, applies that transition's
// rules (transition-rules.mjs), validates the destination, renames the plan with `git mv`, commits
// only the plan's old and new paths, and approves the result only after fresh post-commit checks
// (transition-checks.mjs). Unrelated staged or unstaged work in the primary checkout is never
// touched. A refused move mutates nothing, a repeated move commits nothing, and nothing is pushed.
import fs from "node:fs";
import path from "node:path";
import {
  buildRepositoryPlanSnapshot,
  domainError,
  lifecycleFindings,
  lifecycleMoveDestination,
  selectRepositoryPlan,
} from "./index.mjs";
import { LIFECYCLE_MODEL } from "./lifecycle-manifest.mjs";
import { buildRepairPrompt } from "./repair-prompt.mjs";
import { currentBranch, dirtyPaths, findLinkedWorktree, git, gitOrThrow, linksToPath, primaryCheckout, topLevel } from "./plan-git.mjs";
import { TRANSITION_RULES } from "./transition-rules.mjs";
import { validateTransition } from "./transition-checks.mjs";

// Findings a destination tolerates. Built work no test covers accumulates while a plan is worked and
// is resolved before completion, so it never blocks a move into Active or Review.
const TOLERATED = { active: new Set(["UNCONFIRMED_NOT_TESTED"]), review: new Set(["UNCONFIRMED_NOT_TESTED"]) };
// Archiving is explicit termination, not a claim that the plan is sound, so only the archived
// destination's own rules gate it; the document-wide structure rules do not.
const GATE_KINDS = { archived: new Set(["lifecycle"]) };

export async function transitionPlan(options) {
  const { cwd = process.cwd(), selector, transition: transitionId, base = "main" } = options;
  const transition = LIFECYCLE_MODEL.transition(transitionId);
  if (!transition) throw domainError("INVALID_CHANGE", `Unknown plan transition: ${transitionId}.`);
  const rules = TRANSITION_RULES[transition.id];
  if (!selector) throw domainError("INVALID_CHANGE", "A plan id or path is required.");
  const missing = rules.requires?.(options);
  if (missing) throw domainError("INVALID_CHANGE", missing);

  const primary = primaryCheckout(cwd);
  assertRunningInPrimary(cwd, primary, transition.id);
  assertOnBaseBranch(primary, base);
  const target = transition.id === "start" ? findLinkedWorktree(primary, options.worktree) : null;
  const record = selectRepositoryPlan(buildRepositoryPlanSnapshot({ cwd: primary }), selector, { cwd });
  const from = record.plan.lifecycle;
  const fromPath = record.plan.relativePath;
  const atDestination = from === transition.to;
  const base0 = git(primary, ["rev-parse", base]).stdout;

  if (!atDestination && !transition.from.includes(from)) refuseSource(record, transition, from);
  if (atDestination && !rules.carriesEdits && !rules.reassigns) {
    return result({ primary, cwd, base, transition, record, fromPath, toPath: fromPath, commit: null, options, target, rules, evidence: {} });
  }

  const toPath = atDestination ? fromPath : path.relative(primary,
    lifecycleMoveDestination(fs.realpathSync(primary), fs.realpathSync(record.absolutePath), transition.to).destination).split(path.sep).join("/");
  const paths = atDestination ? [fromPath] : [fromPath, toPath];
  if (!git(primary, ["ls-files", "--error-unmatch", "--", fromPath]).ok) {
    throw domainError("INVALID_CHANGE", `${fromPath} is not committed, so it cannot be moved.`, {
      resolution: "Commit the plan on the base branch first.",
    });
  }
  const dirty = dirtyPaths(primary, paths);
  if (dirty.length && !rules.carriesEdits) {
    throw domainError("INVALID_CHANGE", "The plan has uncommitted changes in the primary checkout.", {
      resolution: "Ask the user how to handle them; this transition commits only the move, never someone else's edit to the plan.",
      details: dirty,
    });
  }

  const current = fs.readFileSync(path.join(primary, fromPath), "utf8");
  // A repeated move of a plan already at its destination skips the gates that judged the move; it
  // only commits the command's own pending edits, if any.
  const prepared = atDestination && !rules.reassigns
    ? { content: current, evidence: {} }
    : await (rules.prepare ? rules.prepare({ primary, record, content: current, options, base, today: today() }) : { content: current });
  const content = prepared.content;
  assertDestinationReady(record, transition.to, content);

  const committed = git(primary, ["show", `HEAD:${fromPath}`]);
  if (atDestination && committed.ok && committed.raw === content && dirty.length === 0) {
    return result({ primary, cwd, base, transition, record, fromPath, toPath, commit: null, options, target, rules, evidence: prepared.evidence || {} });
  }

  if (!atDestination) {
    // A repository that predates a lifecycle folder (ready/ and review/, say) gets it on first use.
    fs.mkdirSync(path.join(primary, path.dirname(toPath)), { recursive: true });
    gitOrThrow(primary, ["mv", "--", fromPath, toPath]);
  }
  fs.writeFileSync(path.join(primary, toPath), content);
  gitOrThrow(primary, ["add", "--", toPath]);
  gitOrThrow(primary, ["commit", "--quiet", "--only", "-m", rules.message(record.plan.id || fromPath, options), "--", ...paths]);
  const commit = git(primary, ["rev-parse", "HEAD"]).stdout;
  const fastForward = target ? fastForwardTarget(target.path, base, base0) : undefined;
  return result({ primary, cwd, base, transition, record, fromPath, toPath, commit, options, target, rules, evidence: { ...(prepared.evidence || {}), ...(fastForward ? { fastForward } : {}) } });
}

function result({ primary, cwd, base, transition, record, fromPath, toPath, commit, options, target, rules, evidence }) {
  const checks = validateTransition({
    cwd,
    primary,
    base,
    id: record.plan.id,
    fromPath,
    toPath,
    commit,
    worktree: target ? { name: options.worktree, path: target.path } : null,
    bodyUnchanged: Boolean(rules.bodyUnchanged),
  });
  return {
    verdict: checks.every((check) => check.ok) ? "APPROVED" : "REFUSED",
    transition: transition.id,
    plan: { id: record.plan.id, from: fromPath, path: toPath, lifecycle: { from: record.plan.lifecycle, to: transition.to } },
    ...(target ? { worktree: { name: options.worktree, path: target.path, branch: target.branch } } : {}),
    base,
    commit,
    alreadyRecorded: commit === null,
    ...evidence,
    staleLinks: fromPath === toPath ? [] : linksToPath(primary, fromPath),
    checks,
  };
}

function assertDestinationReady(record, lifecycle, content) {
  const tolerated = TOLERATED[lifecycle] || new Set();
  const kinds = GATE_KINDS[lifecycle];
  const findings = lifecycleFindings(content, { lifecycle }).findings
    .filter((item) => !tolerated.has(item.code) && (!kinds || kinds.has(item.kind)));
  if (!findings.length) return;
  throw domainError("LIFECYCLE_REQUIREMENTS", `"${record.plan.title}" does not meet the ${lifecycle} requirements, so it was not moved.`, {
    resolution: "Resolve the listed findings in the plan, then run the transition again.",
    details: findings.map((item) => `${item.code}: ${item.message}`),
    findings,
    repair: {
      prompt: buildRepairPrompt({
        repository: record.repository,
        plan: record.plan,
        sourceLifecycle: record.plan.lifecycle,
        destinationLifecycle: lifecycle,
        findings,
      }),
      planId: record.plan.id,
    },
  });
}

function refuseSource(record, transition, from) {
  const available = LIFECYCLE_MODEL.transitionsFrom(from).map((item) => `${item.id} (${item.commands.map((command) => `/${command}`).join(" or ")})`);
  throw domainError("INVALID_CHANGE", `The ${transition.id} transition moves a plan from ${transition.from.join(" or ")} to ${transition.to}; this one is ${from}.`, {
    resolution: available.length ? `From ${from}, the plan can take: ${available.join(", ")}.` : `A ${from} plan has no further transitions.`,
    details: [record.plan.relativePath],
  });
}

function assertRunningInPrimary(cwd, primary, transitionId) {
  const here = topLevel(cwd);
  if (here !== primary) {
    throw domainError("INVALID_CHANGE", `Run plans ${transitionId} from the primary checkout.`, {
      resolution: `cd ${primary} and run it again; lifecycle transitions commit to the base branch there.`,
      details: [`current checkout: ${here}`],
    });
  }
}

// Only the branch matters: unrelated work in the primary checkout stays where it is, because the
// commit names the plan's two paths and nothing else.
function assertOnBaseBranch(primary, base) {
  const branch = currentBranch(primary);
  if (branch !== base) {
    throw domainError("INVALID_CHANGE", `The primary checkout is on ${branch || "a detached HEAD"}, not ${base}.`, {
      resolution: "Ask the user before switching branches; lifecycle transitions commit only on the base branch.",
    });
  }
}

// Brings a worktree branch that has no commits of its own up to the start commit, so the branch
// carries the plan's start state. A branch with its own commits, or uncommitted edits, is left alone:
// its copy of the plan predates the transition and the result says so.
function fastForwardTarget(targetPath, base, baseBefore) {
  const head = git(targetPath, ["rev-parse", "HEAD"]).stdout;
  if (head === git(targetPath, ["rev-parse", base]).stdout) return { applied: false, reason: "already at the base branch" };
  const ownCommits = Number(git(targetPath, ["rev-list", "--count", `${base}..HEAD`]).stdout || "0");
  if (ownCommits > 0) return { applied: false, reason: "worktree branch has its own commits; its plan copy predates the transition" };
  if (dirtyPaths(targetPath).length) return { applied: false, reason: "worktree has uncommitted changes; its plan copy predates the transition" };
  const merged = git(targetPath, ["merge", "--ff-only", "--quiet", base]);
  if (!merged.ok) return { applied: false, reason: `fast-forward failed: ${merged.stderr}` };
  return { applied: true, from: head || baseBefore };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
