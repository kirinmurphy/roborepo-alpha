// Persisted machine-local harness provider state: which providers are enabled, why (discovery,
// user choice, or migration from pre-provider presence checks), and the evidence behind that.
// Lives under ~/.roborepo/harnesses/state.json (harnessStatePath) — never in the portable
// workspace, since this reflects what's actually installed on this machine.

import { readJsonState, writeJsonState, harnessStatePath } from "../cli/state-paths.mjs";
import { validateHarnessState } from "./schemas.mjs";

function emptyState() {
  return { schemaVersion: 2, lastDiscoveredAt: new Date(0).toISOString(), providers: {} };
}

export function readHarnessState() {
  const state = readJsonState(harnessStatePath, emptyState());
  if (state.schemaVersion !== 2) return emptyState();
  validateHarnessState(state);
  return state;
}

export function writeHarnessState(state) {
  validateHarnessState(state);
  writeJsonState(harnessStatePath, state);
}

// Merge fresh discovery results into persisted state. A provider the user explicitly disabled
// (selectionSource "user" with enabled: false) stays disabled across refresh — discovery updates
// its confidence/evidence but never silently re-enables it. Everything else adopts the freshly
// discovered enabled/confidence/evidence, defaulting newly-detected providers to enabled.
export function applyDiscoveryToState(previousState, discoveryResults) {
  const next = {
    schemaVersion: 2,
    lastDiscoveredAt: new Date().toISOString(),
    providers: { ...previousState.providers },
  };

  for (const result of discoveryResults) {
    const previous = previousState.providers[result.providerId];
    const userDisabled = previous?.selectionSource === "user" && previous.enabled === false;

    next.providers[result.providerId] = {
      enabled: userDisabled ? false : result.status === "detected",
      selectionSource: userDisabled ? "user" : "discovery",
      confidence: result.confidence,
      evidence: result.evidence,
      warnings: result.warnings,
    };
  }

  validateHarnessState(next);
  return next;
}

export function setProviderEnabled(state, providerId, enabled) {
  const previous = state.providers[providerId];
  const next = {
    ...state,
    providers: {
      ...state.providers,
      [providerId]: {
        enabled,
        selectionSource: "user",
        confidence: previous?.confidence ?? "absent",
        evidence: previous?.evidence ?? [],
        warnings: previous?.warnings ?? [],
      },
    },
  };
  validateHarnessState(next);
  return next;
}

export function isProviderEnabled(state, providerId) {
  return state.providers[providerId]?.enabled === true;
}
