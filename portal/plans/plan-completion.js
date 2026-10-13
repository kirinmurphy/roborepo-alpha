// A plan's completion at a glance, shared by Home's plan rows and the Plans status strip (on the card
// and in the drawer): a progress ring with its percentage, the `done` badge once every task is
// checked, or the `merged` badge once the plan's worktree has landed. Markup is tpl-plan-completion
// in plan-drawer-partial.html, which both pages load.
//
// `merge` is `{ into }` for a plan whose worktree has merged (see state.js's mergedPlanBranches), or
// null. Merged wins over done: a landed worktree says the work is finished and in the base branch,
// which is more than a fully checked list says. Returns null when there is nothing worth showing
// (see taskProgressDisplay).
import { portalTpl as tpl } from "/portal/shared/api.js";
import { taskProgressDisplay } from "/portal/plans/state.js";

export function planCompletion(plan, { merge = null } = {}) {
  const display = merge ? "merged" : taskProgressDisplay(plan);
  if (display === "none") return null;
  const node = tpl("tpl-plan-completion");
  const progress = node.querySelector("[data-slot=progress]");
  const percentEl = node.querySelector("[data-slot=percent]");
  const merged = node.querySelector("[data-slot=merged]");
  const total = plan.taskCounts?.total || 0;
  const complete = plan.taskCounts?.complete || 0;

  if (display === "merged") {
    merged.hidden = false;
    merged.title = `Merged into ${merge.into || "the base branch"}`;
    progress.remove();
    percentEl.remove();
    return node;
  }
  if (display === "complete") {
    node.querySelector("[data-slot=complete]").hidden = false;
    node.title = `All ${total} tasks complete`;
    progress.remove();
    percentEl.remove();
    return node;
  }
  // No checklist: there is no ratio to draw, so the ring gives way to a dash.
  if (total === 0) {
    progress.remove();
    percentEl.textContent = "—";
    node.title = "No checklist tasks";
    return node;
  }
  const percent = Math.round((complete / total) * 100);
  percentEl.textContent = `${percent}%`;
  node.title = `${complete} of ${total} tasks complete`;
  progress.setAttribute("aria-label", `${plan.title} completion`);
  progress.setAttribute("aria-valuenow", String(percent));
  progress.style.setProperty("--percent", String(percent));
  return node;
}
