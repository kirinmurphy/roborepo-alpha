// Which plan-suite command a card or drawer leads with. Pure: reads a plan and the lifecycle model's
// actions (lifecycle.js), and returns names. Each command is one atomic step that produces a
// clipboard prompt — the portal never runs a command or moves a file for it; the agent does both
// after you paste.
import { lifecycleActions } from "./lifecycle.js";

// Best-effort single recommended next command, derived from plan state. Returns null when no rule
// clearly applies (e.g. blocked review, or mid-progress with no strong signal) rather than guessing.
export function recommendedPlanCommand(plan, dependencies = plan.dependencies || []) {
  // These prompts prepare or validate the plan before changing its lifecycle, including blockers.
  if (plan.lifecycle === "backlog") return dependencies.length ? null : "plan-promote";
  if (plan.lifecycle === "ready") return "plan-execute";
  if (plan.blockers.length > 0) return null;
  // /plan-review fixes open findings in its own session, so a review plan leads with it until approved.
  if (plan.lifecycle === "review") return plan.qa?.decision === "approved" ? "plan-close" : "plan-review";
  return null;
}

// Execution's completion preflight moves the plan to Review. Until then, task counts alone do not
// establish readiness. Other lifecycle commands remain available in the action menu.
// Returns { command, label } or null.
export function primaryPlanAction(plan, dependencies = plan.dependencies || []) {
  const actions = lifecycleActions(plan.lifecycle);
  const command = recommendedPlanCommand(plan, dependencies);
  const action = actions.find((item) => item.command === command);
  return action ? { command, label: action.label } : null;
}

// Only the completed lifecycle satisfies a dependency; missing plans remain unresolved.
export function incompleteDependencies(record, allPlans) {
  return (record.plan.dependencies || []).filter((id) => !allPlans.some((target) =>
    target.repository.id === record.repository.id && target.plan.id === id && target.plan.lifecycle === "completed"));
}
