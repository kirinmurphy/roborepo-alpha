// Server calls for repository sources. The /api/repositories/sources* routes are the one browser
// surface that carries configured source paths; ignore and pin reuse the repository mutations Home
// and Runtime already call, so every surface changes the same registry fields the same way.
import { portalGetJson, portalPostJson } from "/portal/shared/api.js";

export const AUTO_DISCOVERY_ID = "auto-discovery";

export function loadSources() {
  return portalGetJson("/api/repositories/sources");
}

export function addSource({ path, kind = null }) {
  return portalPostJson("/api/repositories/sources", { path, kind });
}

export function setSourceEnabled(id, enabled) {
  return portalPostJson(`/api/repositories/sources/${encodeURIComponent(id)}/enabled`, { enabled });
}

export function removeSource(id) {
  return portalPostJson(`/api/repositories/sources/${encodeURIComponent(id)}/remove`, {});
}

export function refreshSources(id = null) {
  return portalPostJson("/api/repositories/sources/refresh", { id });
}

export function enableAutoDiscovery() {
  return setSourceEnabled(AUTO_DISCOVERY_ID, true);
}

export function setRepositoryIgnored(repositoryId, ignored) {
  return portalPostJson("/api/developer-runtime/repository-visibility", { repositoryId, hidden: ignored });
}

export function setRepositoryPinned(repositoryId, pinned) {
  return portalPostJson("/api/developer-runtime/repository-pinned", { repositoryId, pinned });
}
