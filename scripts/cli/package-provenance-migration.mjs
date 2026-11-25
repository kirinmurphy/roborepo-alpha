// One-time migration from bare-ID package state to source-aware state. Package state written
// before sources existed lists package IDs with no source; this records, for each listed ID, the
// source that provides it today, and writes a lock record for each applied package.
//
// It never changes what is selected, deselected, or applied, and never guesses: an ID that two
// sources provide, with no replace override or lock record to choose between them, is reported
// for the user to resolve and left without a source. An ID no source provides is left alone for
// `package reconcile` to handle as before.
//
// Temporary by design: once no supported install still has bare-ID state, delete this module and
// its callers.
import { hasReplaceOverride, readWorkspaceOverrides } from "./workspace-resources.mjs";
import { listPackageCandidates } from "./package-catalog.mjs";
import { LOCAL_SOURCE_ID } from "./package-sources.mjs";
import { readPackageLock } from "./package-lock.mjs";
import { recordLiveInstall } from "./package-install-store.mjs";
import { readAppliedRecord, readEnabledPackagesRegistry, recordPackageSources } from "./package-state.mjs";

export function needsProvenanceMigration(registry = readEnabledPackagesRegistry(), applied = readAppliedRecord()) {
  const registryNeeds = registry.exists && registry.sources === null && (registry.packages.length > 0 || registry.disabled.length > 0);
  const appliedNeeds = applied.exists && applied.sources === null && applied.packages.length > 0;
  return registryNeeds || appliedNeeds;
}

// Returns { migrated, recorded: [{ id, sourceId }], ambiguous: [{ id, candidates }], missing: [id] }.
export function migrateBareIdPackageState({ dryRun = false } = {}) {
  const registry = readEnabledPackagesRegistry();
  const applied = readAppliedRecord();
  if (!needsProvenanceMigration(registry, applied)) return { migrated: false, recorded: [], ambiguous: [], missing: [] };

  const lock = readPackageLock();
  const overrides = readWorkspaceOverrides();
  const { candidates } = listPackageCandidates({ lock });
  const ids = [...new Set([...registry.packages, ...registry.disabled, ...applied.packages])];
  const chosen = new Map();
  const ambiguous = [];
  const missing = [];
  for (const id of ids) {
    const group = candidates.filter((pkg) => pkg.id === id);
    const local = group.find((pkg) => pkg.sourceId === LOCAL_SOURCE_ID);
    const recorded = lock.packages[id] && group.find((pkg) => pkg.sourceId === lock.packages[id].sourceId);
    const pick = (local && hasReplaceOverride("package", id, overrides) ? local : null)
      || recorded
      || (group.length === 1 ? group[0] : null);
    if (pick) chosen.set(id, pick);
    else if (group.length === 0) missing.push(id);
    else ambiguous.push({ id, candidates: group.map((pkg) => pkg.qualifiedName) });
  }

  const recordedSources = [...chosen].map(([id, pkg]) => ({ id, sourceId: pkg.sourceId }));
  if (!dryRun) {
    const sources = Object.fromEntries(recordedSources.map(({ id, sourceId }) => [id, sourceId]));
    recordPackageSources(sources);
    for (const id of applied.packages) {
      const pkg = chosen.get(id);
      if (pkg && !lock.packages[id]) recordLiveInstall(pkg);
    }
  }
  return { migrated: !dryRun, recorded: recordedSources, ambiguous, missing };
}

// For write paths (enable, disable, reconcile): migrate once, and say what needs the user.
export function migrateBareIdPackageStateWithReport({ dryRun = false, log = console.warn } = {}) {
  const result = migrateBareIdPackageState({ dryRun });
  for (const { id, candidates } of result.ambiguous) {
    log(`  warn: package ${id} is provided by ${candidates.join(" and ")}; its source was not recorded. Choose one with \`roborepo package install <source>/${id}\`.`);
  }
  return result;
}
