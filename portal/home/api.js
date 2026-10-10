import { portalGetJson, portalPostJson } from "/portal/shared/api.js";

export function loadHomeOverview() {
  return portalGetJson("/api/home");
}

export function setRepositoryVisibility(payload) {
  return portalPostJson("/api/developer-runtime/repository-visibility", payload);
}

export function setRepositoryPinned(payload) {
  return portalPostJson("/api/developer-runtime/repository-pinned", payload);
}

export function forgetRepository(payload) {
  return portalPostJson("/api/developer-runtime/repository-forget", payload);
}

export function mutateWorktree({ repositoryId, action, branch, confirm = false }) {
  return portalPostJson(`/api/repositories/${encodeURIComponent(repositoryId)}/worktrees/${action}`, { branch, confirm });
}
