import { portalGetJson } from "/portal/shared/api.js";

export function loadRepositoryOverview(urlKey) {
  return portalGetJson(`/api/repositories/${encodeURIComponent(urlKey)}/overview`);
}
