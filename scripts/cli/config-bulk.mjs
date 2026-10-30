// Bulk enable/disable of a set of packages: a bulkToggle section's Select All switch, or the Plans
// onboarding banner's plan-suite and session-close. One HTTP request carries the whole set; this
// module applies it as ONE unit:
//
//   preflight (validate every id against the simulated target set) -> diff vs current state ->
//   sequential mutations (each enable/disable re-reads the registry and re-renders rules from
//   current state, so parallel mutation would act on stale sibling state) -> `roborepo update`
//   exactly once -> fresh snapshot back to the caller.
//
// The batch is the only caller that runs reconciliation here; individual toggles keep their
// existing mutatePackage/mutateSkill contract untouched. The in-progress flag serializes batches
// so two tabs (or a tab + a stray individual toggle) cannot interleave registry writes; the
// portal server is single-process, so a module flag is a real lock here.
import { loadPackageCatalog, unavailablePackageMessage } from "./package-catalog.mjs";
import { effectiveEnabledIds } from "./rules-render.mjs";
import { mutatePackage } from "./config-mutate.mjs";

let batchInFlight = false;

export function isBatchInFlight() {
  return batchInFlight;
}

// One-shot reconciliation: re-apply enabled packages from the final registry state (adopt-live +
// reconcile re-render from final state, same as `roborepo update`/`config apply` land on). Runs
// in-process — never spawnSync the update script from the portal (it process.exit()s on failure
// paths and is not reentrant); reconcileEnabledPackages is the mutation-relevant core of it.
async function reconcileOnce() {
  const { reconcileEnabledPackages } = await import("./packages.mjs");
  return reconcileEnabledPackages([]);
}

// Validate the whole batch BEFORE touching anything, so an unknown or unavailable id is reported
// per id instead of failing partway through the batch.
function preflight(catalog, targetEnabled) {
  const failures = new Map();
  for (const id of targetEnabled) {
    if (!catalog.some((p) => p.id === id)) failures.set(id, unavailablePackageMessage(id));
  }
  return failures;
}

export async function applyBulkPackageChange(ids, enabled) {
  if (!Array.isArray(ids) || !ids.length || typeof enabled !== "boolean") {
    return { ok: false, status: 400, message: "expected { ids: string[], enabled: boolean }" };
  }
  if (batchInFlight) {
    return { ok: false, status: 409, message: "another config change is in progress — try again in a moment" };
  }
  batchInFlight = true;
  try {
    const catalog = loadPackageCatalog({ includeUnavailable: true });
    const currentEnabled = new Set(effectiveEnabledIds(catalog));
    const changedPackageIds = new Set();

    if (enabled) {
      // Preflight the would-be-enabled set as one unit, then mutate sequentially.
      const targetEnabled = ids.filter((id) => !currentEnabled.has(id));
      const failures = preflight(catalog, targetEnabled);
      const results = ids.map((id) =>
        failures.has(id)
          ? { id, changed: false, ok: false, message: failures.get(id) }
          : { id, changed: false, ok: true, message: "no change" },
      );
      if (failures.size) {
        return { ok: false, status: 409, message: "batch rejected: ownership conflicts", results };
      }
      for (const id of targetEnabled) {
        const result = await mutatePackage(id, true);
        for (const changed of result.changedPackageIds || []) changedPackageIds.add(changed);
        const entry = results.find((r) => r.id === id);
        entry.ok = result.ok;
        entry.changed = true;
        entry.message = result.message;
      }
      for (const id of await reconcileOnce()) changedPackageIds.add(id);
      return { ok: true, status: 200, results, changedPackageIds: [...changedPackageIds] };
    }

    // Disable path: no ownership conflicts possible, but dependency edges do exist — sequential
    // mutation lets each call's dependents-check see prior batch changes.
    const results = [];
    for (const id of ids) {
      if (!currentEnabled.has(id)) {
        results.push({ id, changed: false, ok: true, message: "no change" });
        continue;
      }
      const result = await mutatePackage(id, false);
      for (const changed of result.changedPackageIds || []) changedPackageIds.add(changed);
      results.push({ id, changed: true, ok: result.ok, message: result.message });
      if (result.ok) currentEnabled.delete(id);
    }
    for (const id of await reconcileOnce()) changedPackageIds.add(id);
    return { ok: true, status: 200, results, changedPackageIds: [...changedPackageIds] };
  } finally {
    batchInFlight = false;
  }
}
