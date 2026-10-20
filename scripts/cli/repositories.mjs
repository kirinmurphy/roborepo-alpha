// Service layer bridging the domain-neutral repository registry (modules/repositories) to the CLI
// and portal. Records cross-domain discoveries into the registry. Kept dependency-injectable
// (stateRoot / fsApi) so tests drive it without touching real home-dir state. Configured
// repository sources live in repository-sources.mjs.
import fs from "node:fs";
import { STATE_ROOT as defaultStateRoot } from "./paths.mjs";
import {
  loadRegistry,
  updateRegistry,
  upsertRepository,
  recordDiscovery,
  registerLocalRoot,
  registerLocalRootPath,
  hideRepository,
  providerUrlForRepositoryId,
  repositoryListPayload,
  repositoryDetailPayload,
  repositoryIdForUrlKey,
} from "../../modules/repositories/index.mjs";

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

// ---- Browser-safe API bridge. Every return value is path-free by construction. ----

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
