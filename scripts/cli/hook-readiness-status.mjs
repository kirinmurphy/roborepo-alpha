// Hook readiness for one harness, as the portal route and `doctor` report it: the shared comparison
// (scripts/harnesses/hook-readiness.mjs) fed with this machine's enabled packages and live hook
// file, plus the provider's own next-step guidance when it has any.

import { repoRoot, rootConfigActive } from "./paths.mjs";
import { hookFilePath } from "./hook-composition.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { effectiveEnabledIds } from "./package-state.mjs";
import { coreHookBundle } from "./core-hook-bundle.mjs";
import { readHookReadiness, readinessSupported } from "../harnesses/hook-readiness.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";

// The Codex read starts an app-server and can take seconds, and three portal pages ask for it on
// load. One result per harness is reused for the portal's refresh interval.
const CACHE_TTL_MS = 30_000;
// A fresh read joins one that started this recently instead of starting another app-server, so
// several pages refreshing on the same focus event share one read.
const FRESH_JOIN_MS = 1_000;
// A read in flight is cached as its promise, so invalidation drops it too: a read that started
// before a hook change is never handed to a caller asking afterward.
const cache = new Map();

// `fresh` skips the cached result: after a hook change, on **Check again**, and when the portal
// regains focus, since trust can change in Codex without RoboRepo knowing.
export function loadHookReadiness(harness, { cwd = process.cwd(), now = Date.now(), fresh = false } = {}) {
  getHarnessProvider(harness); // throws "unsupported harness" for an unknown id
  const cached = cache.get(harness);
  if (cached && now - cached.at < (fresh ? FRESH_JOIN_MS : CACHE_TTL_MS)) return cached.promise;
  const promise = readCurrentHookReadiness(harness, cwd).catch((error) => {
    if (cache.get(harness)?.promise === promise) cache.delete(harness);
    throw error;
  });
  cache.set(harness, { at: now, promise });
  return promise;
}

// Called after anything rewrites hook files: package changes, bundle apply, harness refresh.
export function invalidateHookReadiness() {
  cache.clear();
}

// After a package change: forget cached readiness for the harnesses whose hooks it rewrote, and name
// them so the portal reads each once, fresh, and offers review only if the result needs it. A
// failed change may still have written some hooks, so the cache is dropped either way.
export function reportPackageHookChange(result, packageIds) {
  const harnesses = hookHarnessesForPackages([...packageIds, ...(result?.changedPackageIds || [])]);
  if (harnesses.length > 0) invalidateHookReadiness();
  return { ...result, hookHarnesses: result?.ok ? harnesses : [] };
}

// Harnesses whose hooks a change to these packages rewrote, limited to those that report readiness.
export function hookHarnessesForPackages(packageIds, catalog = loadPackageCatalog({ includeUnavailable: true })) {
  const ids = new Set(packageIds);
  const harnesses = catalog
    .filter((pkg) => ids.has(pkg.id))
    .flatMap((pkg) => (pkg.components || []).filter((component) => component.type === "hooks").map((component) => component.harness));
  return [...new Set(harnesses)].filter((harness) => readinessSupported(harness));
}

async function readCurrentHookReadiness(harness, cwd) {
  const catalog = loadPackageCatalog({ includeUnavailable: true });
  const enabledIds = new Set(effectiveEnabledIds(catalog));
  const packages = catalog.filter((pkg) => enabledIds.has(pkg.id));
  const hooksPath = hookFilePath(harness, { rootConfigPath: rootConfigActive[harness] });
  // Core hooks installed by an optional bundle are expected only once the user selected it.
  const coreBundle = coreHookBundle(harness);
  const includeCore = coreBundle === null || coreBundle.selected;
  const readiness = await readHookReadiness(harness, { packages, repoRoot, hooksPath, cwd, includeCore });
  const guidance = getHarnessProvider(harness).adapters.hooks?.guidance;
  return {
    ...readiness,
    coreBundle: coreBundle?.id ?? null,
    guidance: typeof guidance === "function" ? guidance() : null,
  };
}
