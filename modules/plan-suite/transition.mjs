// The one lifecycle transition operation: every committed move between lifecycle folders runs here,
// in the primary checkout, so the portal and every checkout agree on which stage a plan is in.
//
// It resolves the plan, checks the move against the lifecycle manifest, applies that transition's
// rules (transition-rules.mjs), validates the destination, renames the plan with `git mv`, commits
// only the plan's old and new paths, and approves the result only after fresh post-commit checks
// (transition-checks.mjs). Archiving alone also clears the plan from the prerequisites of unfinished
// plans, in the same commit, so nothing is left waiting on work that will never happen. Unrelated staged or unstaged work in the primary checkout is never
// touched. A refused move mutates nothing, a repeated move commits nothing, and nothing is pushed.
import fs from "node:fs";
import path from "node:path";
import {
  buildRepositoryPlanSnapshot,
  domainError,
  lifecycleFindings,
  lifecycleMoveDestination,
  removeFrontmatterListEntry,
  selectRepositoryPlan,
} from "./index.mjs";
import { LIFECYCLE_MODEL } from "./lifecycle-manifest.mjs";
import { namingGateFindings, pathFreeFileError } from "./naming.mjs";
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
// Moving a plan into implementation is the last cheap moment to fix its filename: inbound links and
// worktree records accumulate from here on. Later transitions never revisit it.
const NAMING_GATED_TRANSITIONS = new Set(["promote", "start"]);
const UNCOMMITTED_MOVE_RESOLUTION = "Run `git status` in the repo. Fix what stopped the commit and commit the staged move, or restore those files to undo it.";

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
  const snapshot = buildRepositoryPlanSnapshot({ cwd: primary });
  const record = selectRepositoryPlan(snapshot, selector, { cwd });
  const from = record.plan.lifecycle;
  const fromPath = record.plan.relativePath;
  const atDestination = from === transition.to;
  const base0 = git(primary, ["rev-parse", base]).stdout;

  if (!atDestination && !transition.from.includes(from)) refuseSource(record, transition, from);
  // An earlier run's commit failed after its rename, so the plan only reads as being here. Recording it
  // as done would be false, and committing here would land only half of that move.
  if (atDestination && !git(primary, ["cat-file", "-e", `HEAD:${fromPath}`]).ok) {
    throw domainError("MOVE_NOT_COMMITTED", `The plan's move to ${fromPath} was not committed.`, { resolution: UNCOMMITTED_MOVE_RESOLUTION });
  }
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

  const references = rules.clearsReferences ? planReferences(primary, snapshot, record) : { cleared: [], left: [] };

  const current = fs.readFileSync(path.join(primary, fromPath), "utf8");
  // A repeated move of a plan already at its destination skips the gates that judged the move; it
  // only commits the command's own pending edits, if any.
  const prepared = atDestination && !rules.reassigns
    ? { content: current, evidence: {} }
    : await (rules.prepare ? rules.prepare({ primary, record, content: current, options, base, today: today() }) : { content: current });
  const content = prepared.content;
  assertDestinationReady(record, transition.to, content, NAMING_GATED_TRANSITIONS.has(transition.id)
    ? namingGateFindings({ repositoryRoot: primary, filename: path.basename(fromPath), lifecycle: from })
    : []);

  const committed = git(primary, ["show", `HEAD:${fromPath}`]);
  if (atDestination && committed.ok && committed.raw === content && dirty.length === 0) {
    return result({ primary, cwd, base, transition, record, fromPath, toPath, commit: null, options, target, rules, evidence: prepared.evidence || {} });
  }

  assertPlanWritable(primary, fromPath);
  const clearedDependents = prepareClearedReferences(primary, references.cleared, record.plan.id);

  if (!atDestination) {
    // A repository that predates a lifecycle folder (ready/ and review/, say) gets it on first use.
    fs.mkdirSync(path.join(primary, path.dirname(toPath)), { recursive: true });
    gitOrThrow(primary, ["mv", "--", fromPath, toPath]);
  }
  try {
    fs.writeFileSync(path.join(primary, toPath), content);
    for (const dependent of clearedDependents) fs.writeFileSync(dependent.file, dependent.markdown);
    gitOrThrow(primary, ["add", "--", toPath, ...references.cleared]);
    gitOrThrow(primary, ["commit", "--quiet", "--only", "-m", rules.message(path.basename(fromPath, ".md"), options), "--", ...paths, ...references.cleared]);
  } catch (err) {
    if (atDestination) throw err;
    // Past the rename the plan already sits at its new path, so saying the move failed would be false.
    // It isn't undone here: this path can carry uncommitted plan edits that a rollback would lose.
    throw domainError("MOVE_NOT_COMMITTED", `The plan moved to ${toPath}, but the move was not committed.`, {
      resolution: UNCOMMITTED_MOVE_RESOLUTION,
      details: err.details ?? [pathFreeFileError(err)],
    });
  }
  const commit = git(primary, ["rev-parse", "HEAD"]).stdout;
  const fastForward = target ? fastForwardTarget(target.path, base, base0) : undefined;
  return result({ primary, cwd, base, transition, record, fromPath, toPath, commit, options, target, rules, dependentPaths: references.cleared, evidence: { ...(prepared.evidence || {}), ...(fastForward ? { fastForward } : {}), ...(rules.clearsReferences ? { references } : {}) } });
}

// The unfinished plans that name this one as a prerequisite. A plan bound to a worktree is left alone:
// its worktree copy is the authoritative one, and editing the base copy behind it would read as a
// conflicting copy later. Completed and archived plans keep their history. A dependent with
// uncommitted edits refuses the move, since committing the file would commit someone else's work too.
function planReferences(primary, snapshot, record) {
  const { id } = record.plan;
  const dependents = id
    ? snapshot.plans.filter((other) => other.key !== record.key
      && !["completed", "archived"].includes(other.plan.lifecycle)
      && [...(other.plan.dependencies || []), ...(other.plan.blockers || [])].includes(id))
    : [];
  const cleared = dependents.filter((other) => !other.plan.worktree).map((other) => other.plan.relativePath);
  const left = dependents.filter((other) => other.plan.worktree).map((other) => other.plan.relativePath);
  const dirty = cleared.length ? dirtyPaths(primary, cleared) : [];
  if (dirty.length) {
    throw domainError("INVALID_CHANGE", "A plan that depends on this one has uncommitted changes, so its dependency cannot be cleared.", {
      resolution: "Commit or discard those changes, then archive again.",
      details: dirty,
    });
  }
  return { cleared, left };
}

// The move rewrites the plan after renaming it, so a file it can't write refuses here, with nothing changed.
function assertPlanWritable(primary, relativePath) {
  try {
    fs.accessSync(path.join(primary, relativePath), fs.constants.W_OK);
  } catch (err) {
    throw domainError("INVALID_CHANGE", `The plan file could not be updated (${pathFreeFileError(err)}).`, {
      resolution: "Check that the plan file is writable, then try again.",
      details: [relativePath],
    });
  }
}

// Runs before the rename, so a dependent that can't be rewritten refuses the move with nothing changed.
function prepareClearedReferences(primary, relativePaths, id) {
  return relativePaths.map((relativePath) => {
    const file = path.join(primary, relativePath);
    try {
      fs.accessSync(file, fs.constants.W_OK);
      const content = fs.readFileSync(file, "utf8");
      return { file, markdown: ["depends_on", "blocked_by"].reduce((markdown, key) => removeFrontmatterListEntry(markdown, key, id), content) };
    } catch (err) {
      throw domainError("INVALID_CHANGE", `A plan that depends on this one could not be updated (${pathFreeFileError(err)}).`, {
        resolution: "Check that the plan file is writable, then archive again.",
        details: [relativePath],
      });
    }
  });
}

function result({ primary, cwd, base, transition, record, fromPath, toPath, commit, options, target, rules, dependentPaths = [], evidence }) {
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
    dependentPaths,
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

function assertDestinationReady(record, lifecycle, content, gateFindings) {
  const tolerated = TOLERATED[lifecycle] || new Set();
  const kinds = GATE_KINDS[lifecycle];
  const findings = [
    ...lifecycleFindings(content, { lifecycle }).findings
      .filter((item) => !tolerated.has(item.code) && (!kinds || kinds.has(item.kind))),
    ...gateFindings,
  ];
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
