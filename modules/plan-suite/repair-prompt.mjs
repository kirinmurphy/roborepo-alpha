// Builds the prompt a user copies when a lifecycle move is blocked, so an agent can repair the
// document instead of the user reverse-engineering the requirements from a warning list.
//
// Generated server-side from the same findings that produced the rejection — never from anything
// the client sends — so the prompt always describes the document as it actually is on disk, and a
// stale browser snapshot can't put fabricated requirements in front of an agent.
//
// Pure: takes already-public data and returns a string. It reads no files and moves nothing, and
// the prompt itself instructs the agent not to move the file either. Lifecycle changes stay with
// the portal, which re-validates against fresh disk content on the next attempt.
import { sortBySeverity } from "./findings.mjs";

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Section findings carry the heading names that would satisfy them, so the agent gets the actual
// accepted vocabulary instead of guessing from one example in the resolution text.
function acceptedHeadingsNote(item) {
  const accepted = item.meta?.accepted;
  if (!Array.isArray(accepted) || accepted.length < 2) return "";
  return `\n   Accepted headings: ${accepted.map((name) => `"${name}"`).join(", ")}`;
}

export function buildRepairPrompt({ repository, plan, sourceLifecycle, destinationLifecycle, findings }) {
  const ordered = sortBySeverity(findings);
  const problems = ordered.map((item, index) =>
    `${index + 1}. ${item.message}\n   Fix: ${item.resolution}${acceptedHeadingsNote(item)}`);
  const planLabel = plan.id || plan.title;
  return [
    "/plan-write",
    "",
    `Repair the plan document \`${planLabel}\` in repository \`${repository.name}\` so it satisfies`,
    `the requirements for the ${capitalize(destinationLifecycle)} lifecycle.`,
    "",
    `Repository: ${repository.name}`,
    `Plan ID: ${plan.id || "(missing — add one)"}`,
    `Path: ${plan.relativePath}`,
    `Current lifecycle: ${capitalize(sourceLifecycle)}`,
    `Requested lifecycle: ${capitalize(destinationLifecycle)}`,
    "",
    "Problems to fix:",
    "",
    ...problems,
    "",
    "Instructions:",
    "",
    "- Revise the plan with `/plan-write`.",
    `- Do not move the file. Leave it in \`docs/plans/${sourceLifecycle}/\`; the lifecycle move is`,
    "  performed separately from the portal once the document validates.",
    plan.id
      ? `- Preserve the stable plan ID \`${plan.id}\` exactly as written.`
      : "- Add a stable, lowercase-slug plan ID, and keep it unchanged from then on.",
    `- Run \`roborepo plans validate ${plan.relativePath}\` before reporting done, and list any`,
    "  requirement you could not satisfy along with the reason.",
  ].join("\n");
}
