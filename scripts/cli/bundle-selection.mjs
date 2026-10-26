// Install bundle selection: the same roots-plus-derived-dependencies rule as package state
// (package-state.mjs), over the bundles in manifests/platform/presets.json and the record in
// ~/.roborepo/presets/state.json.
//
// `selected[]` holds the bundles the user (or an install default) chose. A bundle's `requires`
// joins the effective set through it and is never written to `selected`. A state file without
// `schemaVersion` also listed those dependencies; reading one drops them from the roots, so they
// stay effective through their parent and leave with it.
//
// Kept free of the bundle-apply module's imports: hook readiness reads the effective set on every
// status read.
import { dropRequiredIds, requiredClosure, rootsRequiring } from "./package-graph.mjs";

export const BUNDLE_STATE_SCHEMA_VERSION = 2;

// Roots from a state object. `fallback` is used when the state records no selection at all (no
// install has run yet); callers pass the catalog default or [] as they always have.
export function selectedBundleRoots(bundles, state, fallback = []) {
  const listed = state?.selected ?? fallback;
  if ((state?.schemaVersion ?? 1) >= BUNDLE_STATE_SCHEMA_VERSION) return [...new Set(listed)];
  return dropRequiredIds(bundles, listed);
}

// Roots plus their transitive `requires`, dependencies first.
export function effectiveBundleIds(bundles, roots) {
  return requiredClosure(bundles, roots);
}

// Per-bundle selection: `selected` (a root), `required` with the roots that pull it in, or `off`.
export function bundleSelectionStates(bundles, roots) {
  const rootSet = new Set(roots);
  const effective = new Set(effectiveBundleIds(bundles, roots));
  return new Map(bundles.map((bundle) => {
    if (rootSet.has(bundle.id)) return [bundle.id, { state: "selected", requiredBy: [] }];
    if (effective.has(bundle.id)) return [bundle.id, { state: "required", requiredBy: rootsRequiring(bundles, bundle.id, roots) }];
    return [bundle.id, { state: "off", requiredBy: [] }];
  }));
}
