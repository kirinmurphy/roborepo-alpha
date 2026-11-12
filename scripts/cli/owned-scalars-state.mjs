// Provenance for individual harness config values a package sets (a config-patch `set`). The
// whole-file drift tracker (root-config-state.mjs) can't answer "was this one key here before, and
// what was it" — which is exactly what a safe disable needs to either restore an unmanaged prior
// value or remove a key roborepo introduced. Records are keyed by "<harness>.<key path joined by
// dots>" and stored in roborepo state, not a package-side backup file.
import { ownedScalarsStatePath, readJsonState, writeJsonState } from "./state-paths.mjs";

const EMPTY_STATE = { version: 1, scalars: {} };

function scalarKey(harness, keyPath) {
  return [harness, ...keyPath].join(".");
}

function readState() {
  return readJsonState(ownedScalarsStatePath, EMPTY_STATE);
}

// Record what the value looked like BEFORE roborepo set it. `priorValue` is undefined when the key
// was absent. Idempotent: re-enabling never overwrites the first-seen provenance, so repeated enable
// runs can't lose the user's original value.
export function recordOwnedScalar(harness, keyPath, priorValue) {
  const state = readState();
  const id = scalarKey(harness, keyPath);
  if (Object.hasOwn(state.scalars, id)) return;
  state.scalars[id] = { existed: priorValue !== undefined, priorValue };
  writeJsonState(ownedScalarsStatePath, state);
}

// The recorded provenance, or null if roborepo never recorded owning this value.
export function readOwnedScalar(harness, keyPath) {
  return readState().scalars[scalarKey(harness, keyPath)] || null;
}

export function clearOwnedScalar(harness, keyPath) {
  const state = readState();
  const id = scalarKey(harness, keyPath);
  if (!Object.hasOwn(state.scalars, id)) return;
  delete state.scalars[id];
  writeJsonState(ownedScalarsStatePath, state);
}
