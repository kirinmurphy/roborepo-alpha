// Resolve a plan to the linked worktree that implemented it and stop that worktree's dev servers.
// `/plan-close` runs this through `roborepo plans stop-servers` after a complete, landed close.
//
// The plan, not a path, is the input on purpose: a plan with no `worktree` was implemented on the
// base branch, and its servers are the primary checkout's, which closing a plan must never touch.
// findLinkedWorktree only matches linked worktrees, so the primary checkout is unreachable here.
import { stopCheckoutServers } from "../developer-runtime/stop.mjs";
import { buildRepositoryPlanSnapshot, domainError, selectRepositoryPlan } from "./index.mjs";
import { findLinkedWorktree, primaryCheckout } from "./start-transition.mjs";

export async function stopPlanServers({ cwd = process.cwd(), selector, dryRun = false, stop = stopCheckoutServers } = {}) {
  if (!selector) throw domainError("INVALID_CHANGE", "A plan id or path is required.");
  const snapshot = buildRepositoryPlanSnapshot({ cwd });
  const record = selectRepositoryPlan(snapshot, selector, { cwd });
  const plan = { id: record.plan.id, path: record.plan.relativePath };
  const name = record.plan.worktree;
  const nothing = (worktree, reason) => ({ plan, worktree, reason, dryRun, supported: true, ok: true, warnings: [], servers: [] });

  if (!name) return nothing(null, "The plan records no worktree, so there is nothing to stop.");
  let target;
  try {
    target = findLinkedWorktree(primaryCheckout(cwd), name);
  } catch (err) {
    if (err.code !== "PLAN_NOT_FOUND") throw err;
    return nothing({ name, path: null, branch: null }, `No linked worktree is named ${name}; it may already be removed.`);
  }
  const { checkout: _checkout, ...result } = await stop(target.path, { dryRun });
  return { plan, worktree: { name, path: target.path, branch: target.branch }, reason: null, ...result };
}
