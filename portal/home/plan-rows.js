import { portalFillSlots as fill, portalMiddleEllipsis, portalTpl as tpl } from "/portal/shared/api.js";
import { planCompletion } from "/portal/plans/plan-completion.js";
import { worktreeDetailsButton } from "./worktree-details.js";

// What a matched plan hands the shared checkout row (buildRootSection's `identity`): the plans glyph,
// and the title, completion, worktree-details trigger, and next action in place of the branch label.
// Everything else on the row — Git warning, port, Links — still comes from the checkout. Once the
// worktree has merged, a Close action says so itself, so the row drops its merged badge.
export function matchedPlanIdentity(plan, checkout, { mainCheckouts = [], nextAction = null, onOpenPlan, onCopyPrompt, onStopServers = null, onDelete = null } = {}) {
  const node = tpl("tpl-plan-identity");
  node.append(planItem(plan, onOpenPlan, worktreeDetailsButton(plan, checkout, { mainCheckouts, onStopServers, onDelete })));
  const closesMerged = nextAction?.command === "plan-close" && checkout.worktreeState === "landed";
  if (nextAction) node.querySelector("[data-slot=controls]").append(nextActionButton(plan, nextAction, { merged: closesMerged, onCopyPrompt }));
  return { glyph: "plans", label: "Plan", node, hideWorktreeBadge: closesMerged };
}

// The command the Plans card leads with (Promote, Start, Review, Close); clicking copies its prompt.
// On a row the merge is already implied, so "Close after merge" reads as just "Close".
function nextActionButton(plan, action, { merged, onCopyPrompt }) {
  const button = fill(tpl("tpl-plan-next-action"), { label: action.command === "plan-close" ? "Close" : action.label });
  button.title = merged ? `Merged — copy the /${action.command} prompt` : `Copy the /${action.command} prompt`;
  button.addEventListener("click", () => onCopyPrompt?.(plan, action.command));
  return button;
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

// Long plan titles are middle-truncated; the tooltip keeps the full title.
const PLAN_TITLE_MAX_LENGTH = 70;

// One active plan with its completion ring (or done badge). Its title opens the read-only plan
// drawer. The row's own worktree badge already says when the plan's worktree has merged, so the
// completion here stays about tasks. `afterTitle` (a matched row's worktree toggle) sits between the
// title and the completion.
export function planItem(plan, onOpenPlan, afterTitle = null) {
  const title = portalMiddleEllipsis(plan.title, PLAN_TITLE_MAX_LENGTH);
  const node = fill(tpl("tpl-plan-item"), { title });
  const button = node.querySelector("[data-slot=title]");
  if (title !== plan.title) button.title = plan.title;
  button.addEventListener("click", () => onOpenPlan?.(plan));
  const controls = node.querySelector("[data-slot=controls]");
  if (afterTitle) controls.append(afterTitle);
  const completion = planCompletion(plan);
  if (completion) controls.append(completion);
  return node;
}
