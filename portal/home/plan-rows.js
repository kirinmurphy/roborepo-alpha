import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";
import { planCompletion } from "/portal/plans/plan-completion.js";
import { worktreeDetailsButton } from "./worktree-details.js";

// What a matched plan hands the shared checkout row (buildRootSection's `identity`): the plans glyph,
// and the title, completion, and worktree-details trigger in place of the branch label. Everything
// else on the row — Git warning, port, Links — still comes from the checkout.
export function matchedPlanIdentity(plan, checkout, { mainCheckouts = [], onOpenPlan, onStopServers = null, onDelete = null } = {}) {
  const node = tpl("tpl-plan-identity");
  node.append(planItem(plan, onOpenPlan), worktreeDetailsButton(plan, checkout, { mainCheckouts, onStopServers, onDelete }));
  return { glyph: "plans", label: "Plan", node };
}

// A plan Home could not pair with any checkout. The badge says why, and it is not a lifecycle state:
// "no worktree" when the plan names none (a fact about association, not progress: the ring already
// says how far along it is); otherwise the server's `worktreeState` says
// whether the named worktree is unlisted, gone, contested, or cannot be determined.
const WORKTREE_BADGES = {
  unlisted: { text: "worktree not listed", title: (name) => `Worktree "${name}" exists, but Runtime does not list it` },
  missing: { text: "worktree missing", title: (name) => `No worktree named "${name}" exists in this repo` },
  ambiguous: { text: "worktree ambiguous", title: (name) => `Worktree "${name}" is claimed by another active plan or matches more than one checkout` },
  unknown: { text: "worktree status unknown", title: (name) => `Home cannot tell whether worktree "${name}" is running` },
};

export function unmatchedPlanRow(plan, onOpenPlan) {
  const row = tpl("tpl-plan-row");
  const worktreeBadge = plan.worktree && (WORKTREE_BADGES[plan.worktreeState] || WORKTREE_BADGES.unknown);
  const badge = worktreeBadge
    ? { text: worktreeBadge.text, title: worktreeBadge.title(plan.worktree) }
    : { text: "no worktree", title: "This plan names no worktree" };
  const badgeNode = fill(tpl("tpl-plan-match-badge"), { badge: badge.text });
  badgeNode.title = badge.title;
  row.querySelector("[data-slot=identity]").append(planItem(plan, onOpenPlan), badgeNode);
  return row;
}

// One active plan with its completion ring (or done badge). Its title opens the read-only plan
// drawer. The row's own worktree badge already says when the plan's worktree has merged, so the
// completion here stays about tasks.
export function planItem(plan, onOpenPlan) {
  const node = fill(tpl("tpl-plan-item"), { title: plan.title });
  node.querySelector("[data-slot=title]").addEventListener("click", () => onOpenPlan?.(plan));
  const completion = planCompletion(plan);
  if (completion) node.append(completion);
  return node;
}
