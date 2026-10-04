// Service layer bridging the domain-neutral repository registry (modules/repositories) to the CLI
// and portal. Records cross-domain discoveries into the registry and performs the server-side Plans
// enrollment operation. Kept dependency-injectable (stateRoot / fsApi / plan hooks) so tests drive
// it without touching real home-dir state.
import fs from "node:fs";
import { STATE_ROOT as defaultStateRoot } from "./paths.mjs";
import {
  loadRegistry,
  updateRegistry,
  upsertRepository,
  recordDiscovery,
  registerLocalRoot,
  registerLocalRootPath,
  setEnrollment,
  hideRepository,
  planPlansEnrollment,
  providerUrlForRepositoryId,
  repositoryListPayload,
  repositoryDetailPayload,
  repositoryIdForUrlKey,
} from "../../modules/repositories/index.mjs";
import { readPlanSettings } from "../../modules/plan-suite/index.mjs";
import { updatePlanSettings as updatePlanSettingsDefault, refreshPlans as refreshPlansDefault } from "./plans.mjs";

// Register (or refresh) a repository discovered by a domain. Idempotent; batches every mutation for
// one discovery into a single registry write. `localRoot` (an opaque rootId) is optional and, when
// present, records the specific clone/worktree the discovery came from. Enrollment is NEVER enabled
// here — discovery and enrollment are separate concerns (doc §"Discovery Sources and Provenance":
// Runtime discovery must not silently enable Plans).
export function recordRepositoryDiscovery({
  repositoryId,
  kind,
  displayName,
  normalizedRemote = null,
  source,
  evidence,
  confidence,
  localRoot = null,
  localRootKind = "clone",
  localRootPath: rootPath = null,
  stateRoot = defaultStateRoot,
  fsApi = fs,
  now = new Date().toISOString(),
}) {
  return updateRegistry({
    stateRoot,
    fsApi,
    mutate: (registry) => {
      const targetId = repositoryId;
      upsertRepository(registry, {
        id: targetId,
        kind,
        displayName,
        providerUrl: providerUrlForRepositoryId(targetId),
        normalizedRemote: normalizedRemote || (kind === "git" ? targetId : null),
        now,
      });
      let changed = false;
      if (recordDiscovery(registry, targetId, { source, evidence, confidence, now })) changed = true;
      if (localRoot && registerLocalRoot(registry, targetId, { rootId: localRoot, kind: localRootKind, now })) changed = true;
      // Identity and path commit in this same mutate() — one updateRegistry call, one revision bump,
      // one write. pljvmyh §2 requires them to land as a single logical update so a crash or a
      // concurrent writer can never leave a rootId registered with no path or vice versa.
      if (localRoot && rootPath && registerLocalRootPath(registry, targetId, { rootId: localRoot, path: rootPath, now })) changed = true;
      // upsert of a brand-new repository is itself a change even if discovery/root debounced.
      return changed || registry.repositories[targetId].createdAt === now;
    },
  });
}

// Server-side "Include plans" enrollment for a repository discovered elsewhere (e.g. by Runtime).
// Steps (doc §"Enrollment from Runtime"):
//   1. resolve the exact repo root (caller supplies it — it is machine-local and never leaves here)
//   2. determine whether an existing Plans source already covers it
//   3. if covered: refresh, add no duplicate source
//   4. if not: add the EXACT repo root as the narrow default (never a broad parent silently)
//   5. update Plans source config + trigger a Plans refresh
//   6. record that Plans monitoring was explicitly enabled
// If the Plans write/refresh throws, the registry is NOT marked enabled (step 6 only runs on
// success) — enrollment failure leaves the repository unmonitored.
export function enrollRepositoryInPlans({
  repositoryId,
  repoRoot,
  stateRoot = defaultStateRoot,
  fsApi = fs,
  readSettings = readPlanSettings,
  updatePlanSettings = updatePlanSettingsDefault,
  refreshPlans = refreshPlansDefault,
  now = new Date().toISOString(),
}) {
  if (!repoRoot || typeof repoRoot !== "string") throw new Error("enrollment requires the repository root");
  const registry = loadRegistry({ stateRoot, fsApi });
  if (!registry.repositories[repositoryId]) throw new Error(`unknown repository: ${repositoryId}`);

  const settings = readSettings({ stateRoot });
  const priorRoots = settings.discoveryRoots || [];
  const plan = planPlansEnrollment(repoRoot, priorRoots);

  let sourceAdded = null;
  if (!plan.covered) {
    // Add ONLY the exact repo root. Broadening to a parent is an explicit, separate user choice.
    const nextRoots = [...new Set([...priorRoots, plan.suggestedSource])];
    updatePlanSettings({ discoveryRoots: nextRoots });
    sourceAdded = plan.suggestedSource;
  }
  // Refresh so the newly-covered repository's plans are discovered (or the registry re-syncs). If
  // this fails after we added a source, roll the source back so we never leave Plans configured
  // with a source the user never got a working refresh for — enrollment must be all-or-nothing.
  try {
    refreshPlans();
  } catch (err) {
    if (sourceAdded) {
      try { updatePlanSettings({ discoveryRoots: priorRoots }); } catch {}
    }
    throw err;
  }

  // Only now — after Plans config + refresh succeeded — mark monitoring enabled.
  updateRegistry({
    stateRoot,
    fsApi,
    mutate: (reg) => setEnrollment(reg, repositoryId, "plans", { enabled: true, now }),
  });

  return { covered: plan.covered, coveringSource: plan.coveringSource || null, sourceAdded };
}

// ---- Browser-safe API bridge (Phase 4). Every return value is path-free by construction. ----

function notFound(repositoryId) {
  const e = new Error(`unknown repository: ${repositoryId}`);
  e.code = "NOT_FOUND";
  return e;
}

export function loadRepositoriesPayload({ stateRoot = defaultStateRoot, fsApi = fs, includeHidden = false } = {}) {
  return repositoryListPayload(loadRegistry({ stateRoot, fsApi }), { includeHidden });
}

export function loadRepositoryPayload({ repositoryId, stateRoot = defaultStateRoot, fsApi = fs } = {}) {
  const registry = loadRegistry({ stateRoot, fsApi });
  const record = registry.repositories[repositoryId];
  if (!record) throw notFound(repositoryId);
  return repositoryDetailPayload(record);
}

export function loadRepositoryPayloadByUrlKey({ urlKey, stateRoot = defaultStateRoot, fsApi = fs, includeHidden = false } = {}) {
  const registry = loadRegistry({ stateRoot, fsApi });
  const repositoryId = repositoryIdForUrlKey(registry, urlKey, { includeHidden });
  if (!repositoryId) throw notFound(urlKey);
  return repositoryDetailPayload(registry.repositories[repositoryId]);
}

// Associations = the same detail payload's discovery/local-root provenance. Separated as its own
// endpoint so a future detail page can lazy-load it without re-fetching the whole list.
export function loadRepositoryAssociations({ repositoryId, stateRoot = defaultStateRoot, fsApi = fs } = {}) {
  const detail = loadRepositoryPayload({ repositoryId, stateRoot, fsApi });
  return { repositoryId: detail.repositoryId, discoveries: detail.discoveries, localRoots: detail.localRoots, capabilities: detail.capabilities, enrollments: detail.enrollments };
}

// PATCH: currently only visibility (hide/restore). Returns the refreshed detail payload.
export function patchRepository({ repositoryId, visibility, stateRoot = defaultStateRoot, fsApi = fs, now = new Date().toISOString() }) {
  const registry = loadRegistry({ stateRoot, fsApi });
  if (!registry.repositories[repositoryId]) throw notFound(repositoryId);
  if (visibility != null && !["visible", "hidden"].includes(visibility)) throw new Error("visibility must be visible or hidden");
  if (visibility != null) {
    updateRegistry({ stateRoot, fsApi, mutate: (reg) => hideRepository(reg, repositoryId, { hidden: visibility === "hidden", now }) });
  }
  return loadRepositoryPayload({ repositoryId, stateRoot, fsApi });
}
