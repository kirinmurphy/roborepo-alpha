// Execution units for refreshing one configured repository source: resolve a found root to its
// canonical identity, then write every finding for the source into the registry in one update.
import fs from "node:fs";
import path from "node:path";
import {
  CONFIGURED_DISCOVERY_SOURCE,
  canonicalRepositoryId,
  isRepositoryRoot,
  localRepositoryIdForRoot,
  providerUrlForRepositoryId,
  realpathOf,
  recordDiscovery,
  registerLocalRoot,
  registerLocalRootPath,
  removeDiscoveries,
  resolveGitDir,
  resolveProjectIdentity,
  rootId,
  updateRegistry,
  upsertRepository,
} from "../../modules/repositories/index.mjs";

// The canonical repository a root belongs to, or null when it is not a repository. Identity comes
// from the same resolver Runtime uses, so a repository found by both a folder and auto-discovery is
// one record (§3). A plans-only folder outside any Git checkout gets an opaque local id, exactly as
// the Plans scan has always treated such folders.
export function identifyRepositoryRoot(root, { fsApi = fs } = {}) {
  const resolved = resolveProjectIdentity(root, "repository-source", { fsApi });
  let repositoryId = canonicalRepositoryId(resolved);
  let checkout = resolved.projectRoot;
  if (!repositoryId) {
    if (!isRepositoryRoot(root, { fsApi })) return null;
    checkout = realpathOf(root, fsApi);
    repositoryId = localRepositoryIdForRoot(checkout, fsApi);
  }
  const git = resolveGitDir(checkout, { fsApi });
  return {
    repositoryId,
    kind: repositoryId.startsWith("git:") ? "git" : "local",
    displayName: displayNameFor(repositoryId, checkout),
    checkoutPath: checkout,
    rootId: rootId(checkout),
    rootKind: git?.isWorktree ? "worktree" : "clone",
    confidence: repositoryId.startsWith("git:") ? "high" : "medium",
  };
}

// One registry write per refresh. With `complete`, repositories this source no longer finds lose
// its entry; an incomplete (truncated) walk only adds. Returns how many repositories the source
// found.
export function recordSourceFindings(found, source, { stateRoot, fsApi = fs, now, complete }) {
  const evidence = source.kind === "directory" ? "directory-source" : "repository-source";
  const foundIds = new Set(found.map((item) => item.repositoryId));
  updateRegistry({
    stateRoot,
    fsApi,
    mutate: (registry) => {
      let changed = false;
      for (const item of found) {
        const existed = Boolean(registry.repositories[item.repositoryId]);
        upsertRepository(registry, {
          id: item.repositoryId,
          kind: item.kind,
          displayName: existed ? undefined : item.displayName,
          providerUrl: providerUrlForRepositoryId(item.repositoryId),
          normalizedRemote: item.kind === "git" ? item.repositoryId : null,
          now,
        });
        if (!existed) changed = true;
        if (recordDiscovery(registry, item.repositoryId, { source: CONFIGURED_DISCOVERY_SOURCE, sourceId: source.id, evidence, confidence: item.confidence, now })) changed = true;
        if (registerLocalRoot(registry, item.repositoryId, { rootId: item.rootId, kind: item.rootKind, now })) changed = true;
        if (registerLocalRootPath(registry, item.repositoryId, { rootId: item.rootId, path: item.checkoutPath, now })) changed = true;
      }
      if (complete) {
        const stale = removeDiscoveriesExcept(registry, source.id, foundIds, now);
        if (stale) changed = true;
      }
      return changed;
    },
  });
  return foundIds.size;
}

function removeDiscoveriesExcept(registry, sourceId, keepIds, now) {
  const scoped = { repositories: {} };
  for (const [id, record] of Object.entries(registry.repositories)) {
    if (!keepIds.has(id)) scoped.repositories[id] = record;
  }
  return removeDiscoveries(scoped, { source: CONFIGURED_DISCOVERY_SOURCE, sourceId, now }).length > 0;
}

function displayNameFor(repositoryId, checkout) {
  if (repositoryId.startsWith("git:")) return repositoryId.split("/").pop() || repositoryId;
  return path.basename(checkout) || "repository";
}
