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

export function removeWorktree({ repositoryId, branch }) {
  return portalPostJson(`/api/repositories/${encodeURIComponent(repositoryId)}/worktrees/remove`, { branch });
}

export function enableWorktreeCleanup({ repositoryId, folder }) {
  return portalPostJson(`/api/repositories/${encodeURIComponent(repositoryId)}/worktree-cleanup/enable`, { folder });
}

export function dismissWorktreeCleanupNotice({ repositoryId }) {
  return portalPostJson(`/api/repositories/${encodeURIComponent(repositoryId)}/worktree-cleanup/dismiss`, {});
}
