import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";
import { worktreeDetailsButton } from "./worktree-details.js";

// What a matched plan hands the shared checkout row (buildRootSection's `identity`): the plans glyph,
// and the title, completion, and worktree-details trigger in place of the branch label. Everything
// else on the row — Git warning, port, Links — still comes from the checkout.
export function matchedPlanIdentity(plan, checkout, onOpenPlan) {
  const node = tpl("tpl-plan-identity");
  node.append(planItem(plan, onOpenPlan), worktreeDetailsButton(plan, checkout));
  return { glyph: "plans", label: "Plan", node };
}

// A plan Home could not pair with a checkout. The badge says why, and it is not a lifecycle state:
// "not started" only when the plan names no worktree; any named worktree that did not match safely
// (stopped, removed, stale, or claimed twice) reads "worktree not running".
export function unmatchedPlanRow(plan, onOpenPlan) {
  const row = tpl("tpl-plan-row");
  const badge = plan.worktree
    ? { text: "worktree not running", title: `Home has no running checkout for worktree "${plan.worktree}"` }
    : { text: "not started", title: "No worktree is associated with this plan" };
  const badgeNode = fill(tpl("tpl-plan-match-badge"), { badge: badge.text });
  badgeNode.title = badge.title;
  row.querySelector("[data-slot=identity]").append(planItem(plan, onOpenPlan), badgeNode);
  return row;
}

// One active plan with its completion ring. Its title opens the read-only plan drawer.
export function planItem(plan, onOpenPlan) {
  const total = plan.taskCounts?.total || 0;
  const percent = total > 0 ? Math.round((plan.taskCounts.complete / total) * 100) : null;
  const done = percent === 100;
  const node = fill(tpl("tpl-plan-item"), { title: plan.title, percent: percent === null ? "—" : `${percent}%` });
  node.querySelector("[data-slot=title]").addEventListener("click", () => onOpenPlan?.(plan));
  node.title = percent === null ? "No checklist tasks" : `${plan.taskCounts.complete} of ${total} tasks complete`;
  const progress = node.querySelector("[data-slot=progress]");
  progress.hidden = percent === null || done;
  node.querySelector("[data-slot=percent]").hidden = done;
  node.querySelector("[data-slot=complete]").hidden = !done;
  if (percent !== null && !done) {
    progress.setAttribute("aria-label", `${plan.title} completion`);
    progress.setAttribute("aria-valuenow", String(percent));
    progress.style.setProperty("--percent", String(percent));
  }
  return node;
}
