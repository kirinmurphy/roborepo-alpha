import { loadPackageCatalog, isPackageAvailable } from "./package-catalog.mjs";
import { buildPackageLiveState } from "./package-probes.mjs";

// One package's desired and live state, small enough for a skill to branch on. `enabled` is the
// desired state; `status` is what the probes observed on disk (enabled, configured, partial,
// disabled, external), or "unavailable" for a pending package and "missing" for an unknown id.
// The raw catalog entry carries only the static definition, so the live half always comes from
// buildPackageLiveState(), which probes installed rules, hooks, skills, and permissions.
export function packageStatusSummary(id, { catalog = loadPackageCatalog({ includeUnavailable: true }) } = {}) {
  const pkg = catalog.find((item) => item.id === id);
  if (!pkg) return { id, available: false, enabled: false, status: "missing" };
  if (!isPackageAvailable(pkg)) return { id, available: false, enabled: false, status: "unavailable" };
  const live = buildPackageLiveState(withRequiredPackages(pkg, catalog)).get(pkg.id);
  return { id, available: true, enabled: Boolean(live?.desired), status: live?.status || "disabled" };
}

// A package's status folds in the packages it `requires`, so they must be probed with it; probing
// it alone would report every dependency as missing and the package as partial.
function withRequiredPackages(pkg, catalog) {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const selected = new Map([[pkg.id, pkg]]);
  const pending = [...(pkg.requires || [])];
  while (pending.length) {
    const dep = byId.get(pending.pop());
    if (!dep || selected.has(dep.id)) continue;
    selected.set(dep.id, dep);
    pending.push(...(dep.requires || []));
  }
  return [...selected.values()];
}
