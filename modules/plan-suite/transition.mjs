// The one lifecycle transition operation: every move between lifecycle folders runs here, from any
// checkout of the repository, and lands as one commit on the plans branch.
//
// It resolves the plan, checks the move against the lifecycle manifest, applies that transition's
// rules (transition-rules.mjs), validates the destination, and hands the store the plan's old and new
// paths to commit and push. It approves the result only after fresh post-commit checks
// (transition-checks.mjs). Archiving alone also clears the plan from the prerequisites of unfinished
// plans, in the same commit, so nothing is left waiting on work that will never happen. `--base` names
// the code branch the gates compare against; no code checkout changes. A refused move changes
// nothing and a repeated move commits nothing.
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
import { namingGateFindings } from "./naming.mjs";
import { buildRepairPrompt } from "./repair-prompt.mjs";
import { findLinkedWorktree, linksToPath, primaryCheckout } from "./plan-git.mjs";
import { mutateStore, requireStore } from "./plan-store.mjs";
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

export async function transitionPlan(options) {
  const { cwd = process.cwd(), selector, transition: transitionId, base = "main" } = options;
  const transition = LIFECYCLE_MODEL.transition(transitionId);
  if (!transition) throw domainError("INVALID_CHANGE", `Unknown plan transition: ${transitionId}.`);
  const rules = TRANSITION_RULES[transition.id];
  if (!selector) throw domainError("INVALID_CHANGE", "A plan id or path is required.");
  const missing = rules.requires?.(options);
  if (missing) throw domainError("INVALID_CHANGE", missing);

  const store = requireStore(cwd);
  const primary = primaryCheckout(cwd);
  const target = transition.id === "start" ? findLinkedWorktree(primary, options.worktree) : null;
  const saved = await mutateStore({
    store,
    operation: ({ root }) => planMove({ root, primary, cwd, base, options, selector, transition, rules }),
  });

  const { record, fromPath, toPath, dependentPaths, evidence, commit, synchronized, reason } = saved;
  const checks = validateTransition({
    root: store.root,
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
    synchronized,
    ...(reason ? { reason } : {}),
    ...evidence,
    staleLinks: fromPath === toPath ? [] : linksToPath(store.root, fromPath),
    checks,
  };
}

// The store's operation: works out the files this move changes from the fresh tree, writing nothing,
// so the store can re-run it if another machine pushes first.
async function planMove({ root, primary, cwd, base, options, selector, transition, rules }) {
  const snapshot = buildRepositoryPlanSnapshot({ cwd: root });
  const record = selectRepositoryPlan(snapshot, selector, { cwd });
  const from = record.plan.lifecycle;
  const fromPath = record.plan.relativePath;
  const atDestination = from === transition.to;
  const unchanged = (evidence = {}, toPath = fromPath) => ({ files: {}, result: { record, fromPath, toPath, dependentPaths: [], evidence } });

  if (!atDestination && !transition.from.includes(from)) refuseSource(record, transition, from);
  if (atDestination && !rules.reassigns) return unchanged();

  const toPath = atDestination ? fromPath : path.relative(root,
    lifecycleMoveDestination(fs.realpathSync(root), fs.realpathSync(record.absolutePath), transition.to).destination).split(path.sep).join("/");
  const current = fs.readFileSync(record.absolutePath, "utf8");
  const prepared = rules.prepare
    ? await rules.prepare({ primary, record, content: current, options, base, today: today() })
    : { content: current };
  const { content, evidence = {} } = prepared;
  assertDestinationReady(record, transition.to, content, NAMING_GATED_TRANSITIONS.has(transition.id)
    ? namingGateFindings({ repositoryRoot: root, filename: path.basename(fromPath), lifecycle: from })
    : []);
  if (atDestination && content === current) return unchanged(evidence);

  const references = rules.clearsReferences ? dependentPlans(snapshot, record) : [];
  const files = {
    ...(atDestination ? {} : { [fromPath]: null }),
    [toPath]: content,
    ...Object.fromEntries(references.map((dependent) => [dependent.plan.relativePath, withoutPrerequisite(dependent, record.plan.id)])),
  };
  const dependentPaths = references.map((dependent) => dependent.plan.relativePath);
  return {
    files,
    message: rules.message(path.basename(fromPath, ".md"), options),
    result: { record, fromPath, toPath, dependentPaths, evidence: { ...evidence, ...(rules.clearsReferences ? { references: { cleared: dependentPaths } } : {}) } },
  };
}

// The unfinished plans that name this one as a prerequisite. Completed and archived plans keep their
// history.
function dependentPlans(snapshot, record) {
  const { id } = record.plan;
  if (!id) return [];
  return snapshot.plans.filter((other) => other.key !== record.key
    && !["completed", "archived"].includes(other.plan.lifecycle)
    && [...(other.plan.dependencies || []), ...(other.plan.blockers || [])].includes(id));
}

function withoutPrerequisite(dependent, id) {
  const content = fs.readFileSync(dependent.absolutePath, "utf8");
  return ["depends_on", "blocked_by"].reduce((markdown, key) => removeFrontmatterListEntry(markdown, key, id), content);
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

function today() {
  return new Date().toISOString().slice(0, 10);
}
