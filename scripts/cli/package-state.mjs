// Package selection state: the only module that reads or writes ~/.roborepo/enabled-packages.json.
//
// Three layers, computed in one direction:
//   selected roots — what the user (or a catalog default) chose; the registry records only these
//   effective set  — the roots plus every package they require, derived on every read
//   live state     — what each harness actually has, reported by package-probes.mjs
//
// The registry keeps `{ packages, disabled }`: `packages` holds explicit selections, `disabled`
// explicit deselections (load-bearing for default-enabled packages). Files written before
// `schemaVersion: 2` also listed every package an enable pulled in through `requires`; reading one
// drops those ids from the roots, so they stay effective through their parent and turn off with it.
import fs from "node:fs";
import path from "node:path";
import { enabledPackagesPath } from "./state-paths.mjs";
import { recordConfigWrite } from "./write-log.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { dropRequiredIds, requiredClosure } from "./package-graph.mjs";

export const REGISTRY_SCHEMA_VERSION = 2;

// Returns { exists, schemaVersion, packages, disabled } exactly as stored. `exists` distinguishes
// "no registry yet" from "registry exists but empty". A file without `schemaVersion` is version 1.
// Callers outside this module read selectedRootIds/effectiveEnabledIds instead of `packages`.
export function readEnabledPackagesRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(enabledPackagesPath, "utf8"));
    return {
      exists: true,
      schemaVersion: Number.isInteger(data.schemaVersion) ? data.schemaVersion : 1,
      packages: Array.isArray(data.packages) ? data.packages : [],
      disabled: Array.isArray(data.disabled) ? data.disabled : [],
    };
  } catch {
    return { exists: false, schemaVersion: REGISTRY_SCHEMA_VERSION, packages: [], disabled: [] };
  }
}

// The registry's explicit selections as roots. A version-1 file listed dependencies next to the
// packages that required them; those are dropped here because they stay in the required closure.
function explicitRootIds(catalog, registry) {
  const packages = registry.packages || [];
  if ((registry.schemaVersion ?? REGISTRY_SCHEMA_VERSION) >= REGISTRY_SCHEMA_VERSION) return [...new Set(packages)];
  return dropRequiredIds(catalog, packages, { excluded: registry.disabled || [] });
}

// Selected roots: explicit selections plus default-enabled packages, minus explicit deselections.
// Precedence: explicit-disable > explicit-enable > current defaults.
export function selectedRootIds(catalog, registry = readEnabledPackagesRegistry()) {
  const off = new Set(registry.disabled || []);
  const out = new Set();
  for (const id of explicitRootIds(catalog, registry)) if (!off.has(id)) out.add(id);
  for (const pkg of catalog) {
    if (pkg.defaultEnabled && !off.has(pkg.id)) out.add(pkg.id);
  }
  return [...out];
}

// Effective set: the selected roots plus their transitive `requires`, dependencies first. This is
// the "should this package's behavior be live" answer — rendering, probing, ownership checks, and
// reconciliation all read it. A dependency stays effective while any selected root requires it,
// even when the user also deselected it directly. Root ids missing from the catalog are kept, so a
// retired package still reads as wanted until `package reconcile` forgets it.
export function effectiveEnabledIds(catalog, registry = readEnabledPackagesRegistry()) {
  const roots = selectedRootIds(catalog, registry);
  const known = new Set(catalog.map((pkg) => pkg.id));
  return [...requiredClosure(catalog, roots), ...roots.filter((id) => !known.has(id))];
}

// Per-id selection for the Config page and mutation results: `selected` when it is a root,
// `required` when it is effective only through a root that requires it, `off` otherwise.
export function packageSelectionStates(catalog, registry = readEnabledPackagesRegistry()) {
  const roots = new Set(selectedRootIds(catalog, registry));
  const effective = new Set(effectiveEnabledIds(catalog, registry));
  return new Map(catalog.map((pkg) => [
    pkg.id,
    roots.has(pkg.id) ? "selected" : effective.has(pkg.id) ? "required" : "off",
  ]));
}

function writeRegistry(ids, disabledIds, detail = null) {
  fs.mkdirSync(path.dirname(enabledPackagesPath), { recursive: true });
  fs.writeFileSync(enabledPackagesPath, JSON.stringify(
    {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      packages: [...new Set(ids)],
      disabled: [...new Set(disabledIds)],
      updatedAt: new Date().toISOString(),
    },
    null, 2,
  ) + "\n");
  recordConfigWrite(enabledPackagesPath, detail);
}

// Creates an empty registry when none exists, so later reads see an installed (empty) selection.
export function ensureEnabledPackagesRegistry() {
  if (!readEnabledPackagesRegistry().exists) writeRegistry([], []);
}

// The registry after recording (or clearing) one selected root, without writing it. Enabling
// clears a prior explicit deselection; disabling clears a prior explicit selection and records a
// deselection unconditionally, so a package that later becomes default-enabled doesn't silently
// re-enable itself for someone who turned it off. The result stores roots only (version 2).
export function withPackageSelection(catalog, registry, id, enabled) {
  const packages = explicitRootIds(catalog, registry);
  const disabled = registry.disabled || [];
  return {
    exists: true,
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    packages: enabled ? [...new Set([...packages, id])] : packages.filter((x) => x !== id),
    disabled: enabled ? disabled.filter((x) => x !== id) : [...new Set([...disabled, id])],
  };
}

// Record or clear one selected root, then return the explicit selections.
export function setPackageEnabled(id, enabled, catalog = loadPackageCatalog({ includeUnavailable: true })) {
  const next = withPackageSelection(catalog, readEnabledPackagesRegistry(), id, enabled);
  writeRegistry(next.packages, next.disabled, `${enabled ? "enable" : "disable"} ${id}`);
  return next.packages;
}

// Drop package IDs from both registry lists. Used for IDs the catalog no longer contains (a
// retired or renamed package): an explicit disable of a package that does not exist protects
// nothing, and parking the ID in `disabled` would keep it in the registry forever.
export function forgetPackageIds(ids, catalog = loadPackageCatalog({ includeUnavailable: true })) {
  const drop = new Set(ids);
  if (drop.size === 0) return;
  const registry = readEnabledPackagesRegistry();
  const packages = explicitRootIds(catalog, registry);
  writeRegistry(packages.filter((id) => !drop.has(id)), registry.disabled.filter((id) => !drop.has(id)));
}
