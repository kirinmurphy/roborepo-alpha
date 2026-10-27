// Which plan-suite command a card or drawer leads with. Pure: reads a plan and the lifecycle model's
// actions (lifecycle.js), and returns names. Each command is one atomic step that produces a
// clipboard prompt — the portal never runs a command or moves a file for it; the agent does both
// after you paste.
import { lifecycleActions } from "./lifecycle.js";

// Best-effort single recommended next command, derived from plan state. Returns null when no rule
// clearly applies (e.g. blocked, or mid-progress with no strong signal) rather than guessing.
export function recommendedPlanCommand(plan) {
  if (plan.blockers.length > 0) return null;
  // /plan-review fixes open findings in its own session, so a review plan leads with it until approved.
  if (plan.lifecycle === "review") return plan.qa?.decision === "approved" ? "plan-close" : "plan-review";
  return null;
}

// Execution's completion preflight moves the plan to Review. Until then, task counts alone do not
// establish readiness. Other lifecycle commands remain available in the action menu.
// Returns { command, label } or null.
export function primaryPlanAction(plan) {
  const actions = lifecycleActions(plan.lifecycle);
  const command = recommendedPlanCommand(plan);
  const action = actions.find((item) => item.command === command);
  return action ? { command, label: action.label } : null;
}
