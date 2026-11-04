// The deterministic document findings for one plan, or every plan, in the repository containing
// `cwd`. This is the result `roborepo plans validate` prints; the model-driven checks a suite skill
// runs against code and docs are separate, and a clean result here is not evidence they ran.
//
// Which copy is validated depends on where it runs:
// - From the main checkout, each plan is validated from its authoritative copy, chosen exactly as
//   the Plans portal chooses it (plan-copies.mjs): the assigned worktree's copy while a plan is
//   Active or Review, the primary copy otherwise. The CLI and the portal therefore agree, and an
//   out-of-date primary copy never stands in for the worktree's.
// - From a linked worktree, or a directory Git does not manage, the copies in that checkout are
//   validated as they are: a suite skill working inside a plan's worktree checks its own copy.
import path from "node:path";
import { resolveGitDir } from "../repositories/index.mjs";
import { repositoryOrderFindings } from "./backlog-registry.mjs";
import { mainAndLinkedCheckouts } from "./checkouts.mjs";
import { buildRepositoryPlanSnapshot, selectRepositoryPlan, withRelationshipFindings } from "./index.mjs";
import { repositoryPlanRecords, scanCheckout } from "./plan-copies.mjs";

export function validateRepositoryPlans({ cwd = process.cwd(), selector = null } = {}) {
  const snapshot = buildRepositoryPlanSnapshot({ cwd });
  const selected = selector ? [selectRepositoryPlan(snapshot, selector, { cwd })] : snapshot.plans;
  const authoritative = authoritativeRecords(snapshot);
  const plans = selected.flatMap((record) => (authoritative
    ? (authoritative.get(record.plan.relativePath) || [record]).map(fromMainCheckout)
    : [{ ...summary(record), validated: { source: "checkout" } }]));
  // The config and the ordering registry belong to no one plan. Both live in the primary checkout.
  const orderRoot = primaryRootOf(snapshot.root);
  const repositoryFindings = repositoryOrderFindings(orderRoot, resolveGitDir(orderRoot) ? primaryCheckoutRecords(orderRoot) : snapshot.plans);
  const findings = [...plans.flatMap((plan) => plan.findings), ...repositoryFindings];
  return {
    repository: { name: snapshot.repository.name, repositoryId: snapshot.repository.repositoryId },
    plans,
    repositoryFindings,
    summary: {
      plans: plans.length,
      findings: findings.length,
      blocking: findings.filter((item) => item.severity === "blocking").length,
    },
  };
}

function primaryRootOf(root) {
  const git = resolveGitDir(root);
  return git?.isWorktree ? path.dirname(git.commonDir) : root;
}

// Every plan in a repository, from each plan's authoritative copy, the way the portal reads them.
// `primary` is the main checkout's path.
export function primaryCheckoutRecords(primary) {
  const snapshot = buildRepositoryPlanSnapshot({ cwd: primary });
  // One identity for every checkout, as the portal scan passes: without it each checkout is keyed by
  // its own root, and a plan's links to plans in another checkout stop resolving.
  const canonical = { repositoryId: snapshot.repository.repositoryId, name: snapshot.repository.name };
  return repositoryPlanRecords(mainAndLinkedCheckouts(primary).map((checkout) => scanCheckout(checkout, canonical)));
}

// From the main checkout, the portal's records for the plans that checkout holds, keyed by the path
// of each plan's primary copy (a repeated id can map one path to several records). Plans found only
// in a linked worktree are left out: validate reports the plans of the checkout it runs in. Null
// outside a main checkout.
function authoritativeRecords(snapshot) {
  const git = resolveGitDir(snapshot.root);
  if (!git || git.isWorktree) return null;
  const records = withRelationshipFindings(primaryCheckoutRecords(snapshot.root));
  const byPrimaryPath = new Map();
  for (const record of records) {
    if (!record.plan.authority) continue;
    const key = record.plan.primaryRelativePath || record.plan.relativePath;
    byPrimaryPath.set(key, [...(byPrimaryPath.get(key) || []), record]);
  }
  return byPrimaryPath;
}

// A plan is named by its primary copy's path, which decides its stage; `validated` says which copy
// the findings came from.
function fromMainCheckout(record) {
  const { authority } = record.plan;
  const validated = authority?.source === "worktree"
    ? { source: "worktree", worktree: authority.worktree, relativePath: record.plan.relativePath }
    : { source: "primary" };
  return { ...summary(record), relativePath: record.plan.primaryRelativePath || record.plan.relativePath, validated };
}

function summary(record) {
  return {
    id: record.plan.id,
    relativePath: record.plan.relativePath,
    lifecycle: record.plan.lifecycle,
    findings: record.plan.validation.findings,
  };
}
