// Package selection and installation state: the only module that reads or writes
// ~/.roborepo/enabled-packages.json (what is selected) and ~/.roborepo/applied-packages.json (what
// RoboRepo installed on this machine).
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
//
// Both files also carry `sources`, a map from each listed package ID to the source it came from,
// so every recorded package can say where it came from. Package IDs stay bare in the lists; the
// lock (package-lock.mjs) holds the full resolution behind each source reference.
import fs from "node:fs";
import path from "node:path";
import { appliedPackagesPath, enabledPackagesPath } from "./state-paths.mjs";
import { recordConfigWrite } from "./write-log.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { dropRequiredIds, requiredClosure } from "./package-graph.mjs";

export const REGISTRY_SCHEMA_VERSION = 2;

// Installation ownership is separate from selection: losing a dependency edge must not lose the
// knowledge needed to remove its installed components, nor remove a package RoboRepo never applied.
export function readAppliedPackageIds() {
  return readAppliedRecord().packages;
}

// { packages, sources }. `sources` is null in a file written before source references existed.
export function readAppliedRecord() {
  try {
    const data = JSON.parse(fs.readFileSync(appliedPackagesPath, "utf8"));
    return {
      exists: true,
      packages: Array.isArray(data.packages) ? data.packages : [],
      sources: isSourceMap(data.sources) ? data.sources : null,
    };
  } catch {
    return { exists: false, packages: [], sources: null };
  }
}

// `pkg` (a catalog package) supplies the source reference for an apply.
export function setPackageApplied(id, applied, pkg = null) {
  const record = readAppliedRecord();
  const ids = new Set(record.packages);
  const sourceKnown = !applied || !pkg?.sourceId || record.sources?.[id] === pkg.sourceId;
  if (ids.has(id) === applied && sourceKnown) return;
  if (applied) ids.add(id);
  else ids.delete(id);
  const sources = { ...(record.sources || {}) };
  if (applied && pkg?.sourceId) sources[id] = pkg.sourceId;
  writeAppliedPackageIds([...ids], `${applied ? "apply" : "remove"} package ${id}`, sources);
}

function writeAppliedPackageIds(ids, reason, sources = readAppliedRecord().sources || {}) {
  fs.mkdirSync(path.dirname(appliedPackagesPath), { recursive: true });
  fs.writeFileSync(appliedPackagesPath, JSON.stringify({ packages: ids, sources: pickSources(sources, ids) }, null, 2) + "\n");
  recordConfigWrite(appliedPackagesPath, reason);
}

function isSourceMap(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The source references for `ids`: the catalog's current answer first, then what was recorded,
// so a package the catalog no longer resolves keeps the reference it had.
function sourcesFor(ids, catalog, recorded = {}) {
  const byId = new Map(catalog.map((pkg) => [pkg.id, pkg.sourceId]));
  const out = {};
  for (const id of ids) {
    const sourceId = byId.get(id) || recorded[id];
    if (sourceId) out[id] = sourceId;
  }
  return out;
}

function pickSources(sources, ids) {
  const out = {};
  for (const id of ids) if (sources[id]) out[id] = sources[id];
  return out;
}

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
      sources: isSourceMap(data.sources) ? data.sources : null,
    };
  } catch {
    return { exists: false, schemaVersion: REGISTRY_SCHEMA_VERSION, packages: [], disabled: [], sources: null };
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
// the "should this package's behavior be live" answer — rendering, probing, and reconciliation all
// read it. A dependency stays effective while any selected root requires it,
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

function writeRegistry(ids, disabledIds, detail = null, sources = readEnabledPackagesRegistry().sources || {}, schemaVersion = REGISTRY_SCHEMA_VERSION) {
  const packages = [...new Set(ids)];
  const disabled = [...new Set(disabledIds)];
  fs.mkdirSync(path.dirname(enabledPackagesPath), { recursive: true });
  fs.writeFileSync(enabledPackagesPath, JSON.stringify(
    {
      schemaVersion,
      packages,
      disabled,
      sources: pickSources(sources, [...packages, ...disabled]),
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
  const registry = readEnabledPackagesRegistry();
  const next = withPackageSelection(catalog, registry, id, enabled);
  const sources = sourcesFor([...next.packages, ...next.disabled], catalog, registry.sources || {});
  writeRegistry(next.packages, next.disabled, `${enabled ? "enable" : "disable"} ${id}`, sources);
  return next.packages;
}

// Drop package IDs from both registry lists and the applied record. Used for IDs the catalog no
// longer contains (a retired or renamed package): an explicit disable of a package that does not
// exist protects nothing, parking the ID in `disabled` would keep it in the registry forever, and
// reconcile cannot remove components it no longer has a manifest for.
export function forgetPackageIds(ids, catalog = loadPackageCatalog({ includeUnavailable: true })) {
  const drop = new Set(ids);
  if (drop.size === 0) return;
  const registry = readEnabledPackagesRegistry();
  const packages = explicitRootIds(catalog, registry);
  const remaining = (list) => list.filter((id) => !drop.has(id));
  if ([...registry.packages, ...registry.disabled].some((id) => drop.has(id))) {
    writeRegistry(remaining(packages), remaining(registry.disabled));
  }
  const applied = readAppliedPackageIds();
  if (applied.some((id) => drop.has(id))) writeAppliedPackageIds(remaining(applied), `forget packages ${[...drop].join(", ")}`);
}

// Merge source references into both records without changing what either lists. Used by the
// bare-ID migration; an absent record stays absent, and the registry keeps its schema version so
// a version-1 list keeps its meaning.
export function recordPackageSources(sources) {
  const registry = readEnabledPackagesRegistry();
  if (registry.exists) {
    writeRegistry(registry.packages, registry.disabled, "record package sources",
      { ...sources, ...(registry.sources || {}) }, registry.schemaVersion);
  }
  const applied = readAppliedRecord();
  if (applied.exists) {
    writeAppliedPackageIds(applied.packages, "record package sources", { ...sources, ...(applied.sources || {}) });
  }
}
