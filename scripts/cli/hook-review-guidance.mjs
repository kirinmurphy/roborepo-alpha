// Hook readiness as terminal text: `doctor --installed` lists every harness whose RoboRepo hooks
// will not all run, and commands that just rewrote hooks (package enable/disable, bundle apply,
// onboarding, update) print the review next step when, and only when, a fresh read shows RoboRepo
// hooks awaiting review. The terminal never opens anything; it names the command to run.

import { harnessDisplayName } from "../harnesses/registry.mjs";
import { loadHookReadiness } from "./hook-readiness-status.mjs";

const LABEL = { missing: "missing", review_required: "awaiting review", inactive: "turned off", unknown: "in an unknown state" };

// One line per group and problem, each with its remedy. Lines follow each hook's own state, not the
// group's worst one, so a package with a missing hook and an untrusted one gets both lines. Review
// and re-enable steps belong to the harness, so they come from its hooks.guidance adapter.
export function hookReadinessLines(readiness) {
  const guidance = readiness.guidance || {};
  return (readiness.groups || []).flatMap((group) => Object.keys(LABEL)
    .filter((state) => group.hooks.some((hook) => hook.state === state))
    .map((state) => `${readiness.displayName} hooks ${LABEL[state]}: ${group.label} (${events(group, state).join(", ")}) — ${nextStep(group, state, readiness, guidance)}`));
}

// After a command that rewrote these harnesses' hooks. Prints nothing when nothing of RoboRepo's
// awaits review, or when readiness cannot be read: an unknown state is not a reason to ask.
export async function printHookReviewHint(harnesses, { log = console.log, read = (harness) => loadHookReadiness(harness, { fresh: true }) } = {}) {
  for (const harness of new Set(harnesses)) {
    let readiness;
    try { readiness = await read(harness); } catch { continue; }
    if (!readiness?.reviewRevision) continue;
    const name = readiness.displayName || harnessDisplayName(harness);
    const pending = readiness.groups
      .filter((group) => group.hooks.some((hook) => hook.state === "review_required"))
      .map((group) => `${group.label} (${events(group, "review_required").join(", ")})`);
    const guidance = readiness.guidance || {};
    log("");
    log(`${name} hooks need review: ${pending.join(", ")}.`);
    if (guidance.review_required) log(`  ${guidance.review_required}`);
    if (guidance.command) log(`  Open ${name}'s review: ${guidance.command}`);
    if (guidance.reviewApp) log(`  ${guidance.reviewApp}`);
  }
}

function events(group, state) {
  return [...new Set(group.hooks.filter((hook) => hook.state === state).map((hook) => hook.event))];
}

function nextStep(group, state, readiness, guidance) {
  if (state === "missing") {
    if (group.owner !== "core") return `reapply the package with 'roborepo package enable ${group.owner}'`;
    return readiness.coreBundle ? `reinstall them with 'roborepo bundle apply ${readiness.coreBundle}'` : "reinstall them with 'roborepo repair'";
  }
  if (state === "review_required") {
    if (!guidance.review_required) return "trust them in the harness";
    return guidance.command ? `${guidance.review_required} Run: ${guidance.command}` : guidance.review_required;
  }
  if (state === "inactive") return guidance.inactive ?? "turn them back on in the harness";
  return "check that the harness runtime is installed and has been opened once";
}
