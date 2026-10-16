#!/usr/bin/env node
// `doctor --installed` hint lines for hook readiness: one line per harness whose RoboRepo hooks
// will not all run, with the next step. Advisory only, so it always exits 0; doctor prints each
// line through its non-failing hint helper.

import { listHarnessProviders } from "../harnesses/registry.mjs";
import { readinessSupported } from "../harnesses/hook-readiness.mjs";
import { harnessHome } from "./paths.mjs";
import { loadHookReadiness } from "./hook-readiness-status.mjs";
import fs from "node:fs";

// Review and re-enable steps belong to the harness, so they come from its hooks.guidance adapter.
const NEXT_STEP = {
  missing: (group) => `reapply the package with 'roborepo package enable ${group.owner}'`,
  review_required: (group, guidance) => providerStep(guidance, "review_required") ?? "trust them in the harness",
  inactive: (group, guidance) => providerStep(guidance, "inactive") ?? "turn them back on in the harness",
  unknown: () => "check that the harness runtime is installed and has been opened once",
};

function providerStep(guidance, state) {
  if (!guidance?.[state]) return null;
  return guidance.command
    ? `${guidance[state]} ${guidance.terminalHint || "Terminal command:"} ${guidance.command}`
    : guidance[state];
}
const LABEL = { missing: "missing", review_required: "awaiting review", inactive: "turned off", unknown: "in an unknown state" };

for (const provider of listHarnessProviders()) {
  if (!fs.existsSync(harnessHome[provider.id] || "") || !readinessSupported(provider.id)) continue;
  let readiness;
  try { readiness = await loadHookReadiness(provider.id); } catch { continue; }
  for (const group of readiness.groups.filter((entry) => entry.state !== "active")) {
    const events = [...new Set(group.hooks.filter((hook) => hook.state === group.state).map((hook) => hook.event))];
    const step = group.owner === "core" && group.state === "missing"
      ? "RoboRepo does not yet install core hooks into a hook file packages already use"
      : NEXT_STEP[group.state](group, readiness.guidance);
    console.log(`${readiness.displayName} hooks ${LABEL[group.state]}: ${group.label} (${events.join(", ")}) — ${step}`);
  }
}
