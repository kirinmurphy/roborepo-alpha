import fs from "node:fs";
import { rootConfigBaseline, rootConfigActive } from "./paths.mjs";
import { checkDrift } from "./root-config-state.mjs";

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
//   drifted        — active file changed since roborepo's last write (by the user or the
//                    harness app); the next update merges into it, keeping every local value.
//   unwritten      — no recorded roborepo write yet (pre-dates drift tracking, or never installed
//                    via roborepo).
function describeDrift(harness, { active, baseline }) {
  const activeExists = fs.existsSync(active);
  const baselineExists = fs.existsSync(baseline);
  const drift = activeExists ? checkDrift(harness, active) : { status: "missing" };

  let state;
  if (!activeExists) state = "not-installed";
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
  drifted: "has local changes (made since roborepo's last write, by you or the harness app; `roborepo update` keeps them and adds roborepo's entries)",
  unwritten: "no recorded roborepo write yet (pre-dates drift tracking, or never installed via roborepo)",
};
