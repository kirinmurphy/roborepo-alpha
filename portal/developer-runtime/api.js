import { portalGetJson, portalPostJson } from "/portal/shared/api.js";

export function fetchDeveloperRuntime() {
  return portalGetJson("/api/developer-runtime");
}

export function refreshDeveloperRuntime() {
  return portalPostJson("/api/developer-runtime/refresh", {});
}

// The opaque key is snapshot-scoped: it embeds the origin, so it changes when an app's port changes
// and the server 404s a stale one. Callers should treat a 404 as "reload the snapshot", not an error.
export function fetchHistory(key) {
  return portalGetJson(`/api/developer-runtime/history?key=${encodeURIComponent(key)}`);
}

// Same stale-key contract as fetchHistory: a 404 means the app's port changed since this snapshot.
export function fetchMetadata(key) {
  return portalGetJson(`/api/developer-runtime/metadata?key=${encodeURIComponent(key)}`);
}

export function updateLinks(payload) {
  return portalPostJson("/api/developer-runtime/links", payload);
}

export function updateAssociation(payload) {
  return portalPostJson("/api/developer-runtime/association", payload);
}

export function updateProject(payload) {
  return portalPostJson("/api/developer-runtime/project", payload);
}

export function updateAlias(payload) {
  return portalPostJson("/api/developer-runtime/alias", payload);
}

export function updateComposeProject(payload) {
  return portalPostJson("/api/developer-runtime/compose-project", payload);
}

export function updatePreferences(payload) {
  return portalPostJson("/api/developer-runtime/preferences", payload);
}

// Repository visibility lives in the repository registry rather than Runtime's settings, so this
// carries no settings revision — see setDeveloperRuntimeRepositoryVisibility for why none is needed.
export function setRepositoryVisibility(payload) {
  return portalPostJson("/api/developer-runtime/repository-visibility", payload);
}

// Registry-backed like visibility above, and revisionless for the same reason.
export function setRepositoryPinned(payload) {
  return portalPostJson("/api/developer-runtime/repository-pinned", payload);
}
