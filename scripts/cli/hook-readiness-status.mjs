// Hook readiness for one harness, as the portal route and `doctor` report it: the shared comparison
// (scripts/harnesses/hook-readiness.mjs) fed with this machine's enabled packages and live hook
// file, plus the provider's own next-step guidance when it has any.

import { repoRoot, rootConfigActive } from "./paths.mjs";
import { hookFilePath } from "./hook-composition.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { effectiveEnabledIds } from "./rules-render.mjs";
import { readHookReadiness } from "../harnesses/hook-readiness.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";

// The Codex read starts an app-server and can take seconds, and three portal pages ask for it on
// load. One result per harness is reused for the portal's refresh interval.
const CACHE_TTL_MS = 30_000;
const cache = new Map();

export function loadHookReadiness(harness, { cwd = process.cwd(), now = Date.now() } = {}) {
  getHarnessProvider(harness); // throws "unsupported harness" for an unknown id
  const cached = cache.get(harness);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.promise;
  const promise = readCurrentHookReadiness(harness, cwd).catch((error) => {
    cache.delete(harness);
    throw error;
  });
  cache.set(harness, { at: now, promise });
  return promise;
}

async function readCurrentHookReadiness(harness, cwd) {
  const catalog = loadPackageCatalog({ includeUnavailable: true });
  const enabledIds = new Set(effectiveEnabledIds(catalog));
  const packages = catalog.filter((pkg) => enabledIds.has(pkg.id));
  const hooksPath = hookFilePath(harness, { rootConfigPath: rootConfigActive[harness] });
  const readiness = await readHookReadiness(harness, { packages, repoRoot, hooksPath, cwd });
  const guidance = getHarnessProvider(harness).adapters.hooks?.guidance;
  return { ...readiness, guidance: typeof guidance === "function" ? guidance() : null };
}
