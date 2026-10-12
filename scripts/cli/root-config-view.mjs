import fs from "node:fs";
import { rootConfigBaseline, rootConfigActive } from "./paths.mjs";
import { checkDrift } from "./root-config-state.mjs";
import { findSiblingArtifact } from "./staging-lib.mjs";

// Keyed by whichever providers actually declare a rootConfig path (rootConfigActive, from
// paths.mjs's pathById("rootConfig")) — N-provider-safe, no hardcoded harness list.
function rootConfigHarnesses() {
  return Object.fromEntries(
    Object.keys(rootConfigActive).map((harness) => [
      harness,
      { active: rootConfigActive[harness], baseline: rootConfigBaseline[harness] },
    ]),
  );
}

// One user-facing drift "state" per harness, plus the raw drift details. This is the SINGLE SOURCE
// OF TRUTH for both the terminal `roborepo config root inspect` report and the web /agents panel —
// the snapshot ships buildRootConfigView() under `rootConfig` so neither surface recomputes the
// state label. States:
//   not-installed  — no active file on disk.
//   in-sync        — active file matches roborepo's last recorded write ("clean").
//   drifted        — active file changed since roborepo's last write.
//   staged-pending — a *_update_TIMESTAMP baseline sits beside the active file (a `keep`-policy
//                    install/update left the new baseline staged for the user to reconcile).
//   unwritten      — no recorded roborepo write yet (pre-dates drift tracking, or never installed
//                    via roborepo).
// staged-pending is reported when a staged sibling exists regardless of drift status, because a
// pending staged update is the actionable thing to surface even on an otherwise-clean file.
function describeDrift(harness, { active, baseline }) {
  const activeExists = fs.existsSync(active);
  const baselineExists = fs.existsSync(baseline);
  const drift = activeExists ? checkDrift(harness, active) : { status: "missing" };
  const stagedUpdate = activeExists ? findSiblingArtifact(active, "update") : null;

  let state;
  if (!activeExists) state = "not-installed";
  else if (stagedUpdate) state = "staged-pending";
  else if (drift.status === "clean") state = "in-sync";
  else if (drift.status === "drifted") state = "drifted";
  else state = "unwritten"; // covers "unwritten" and any other non-clean/non-drifted status

  return {
    harness,
    active,
    baseline,
    activeExists,
    baselineExists,
    state,
    stagedUpdate,
    lastHash: drift.lastHash ?? null,
    currentHash: drift.currentHash ?? null,
  };
}

// Per-harness root-config drift view, shared by the terminal report and the web portal.
export function buildRootConfigView() {
  return Object.entries(rootConfigHarnesses()).map(([harness, paths]) => describeDrift(harness, paths));
}

// Human-readable one-liner for a row's state, reused by the CLI report.
export const ROOT_CONFIG_STATE_LABEL = {
  "not-installed": "not installed",
  "in-sync": "in sync (unchanged since roborepo's last write)",
  drifted: "drifted (changed since roborepo's last write)",
  "staged-pending": "staged update pending (a new baseline is staged beside the active file)",
  unwritten: "no recorded roborepo write yet (pre-dates drift tracking, or never installed via roborepo)",
};
