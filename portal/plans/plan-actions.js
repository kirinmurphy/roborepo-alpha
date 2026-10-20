// Which plan-suite command a card or drawer leads with. Pure: reads a plan and the lifecycle model's
// actions (lifecycle.js), and returns names. Each command is one atomic step that produces a
// clipboard prompt — the portal never runs a command or moves a file for it; the agent does both
// after you paste.
import { lifecycleActions } from "./lifecycle.js";

// Best-effort single recommended next command, derived from plan state. Returns null when no rule
// clearly applies (e.g. blocked, or mid-progress with no strong signal) rather than guessing.
export function recommendedPlanCommand(plan) {
  if (plan.blockers.length > 0) return null;
  if (plan.lifecycle === "backlog") return "plan-promote";
  if (plan.lifecycle === "ready") return "plan-execute";
  // /plan-review fixes open findings in its own session, so a review plan leads with it until approved.
  if (plan.lifecycle === "review") return plan.qa?.decision === "approved" ? "plan-close" : "plan-review";
  if (plan.lifecycle !== "active") return null;
  const { remaining, total } = plan.taskCounts;
  // Unconfirmed Not tested entries never hold back implementation completion.
  if (total > 0 && remaining - (plan.notTestedOpen || 0) === 0) return "plan-review";
  if (plan.reviewState === "possibly-stale" || plan.reviewState === "never-reviewed") return "plan-write";
  return null;
}

// The one command a card or drawer leads with: the recommendation when there is one, otherwise the
// lifecycle's default way forward, its first action (Promote, Start, Continue, Review). Completed
// and archived plans have none. Returns { command, label } or null.
export function primaryPlanAction(plan) {
  const actions = lifecycleActions(plan.lifecycle);
  const command = recommendedPlanCommand(plan) || actions[0]?.command || null;
  const action = actions.find((item) => item.command === command);
  return action ? { command, label: action.label } : null;
}
