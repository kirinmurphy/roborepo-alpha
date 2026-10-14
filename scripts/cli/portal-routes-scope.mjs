// The shared `?repo=<urlKey>` scope as data routes read it. Each scoped route resolves the key
// once, here, and hands domain code the canonical repositoryId. An unresolvable key answers with an
// explicit unavailable status, so a page can never mistake it for unscoped data.
import { send } from "./portal-routes-http.mjs";

export const REPOSITORY_SCOPE_UNAVAILABLE = "REPOSITORY_SCOPE_UNAVAILABLE";

// Returns the resolved scope ({ kind: "all" | "repository" | "outside" }), or null after answering
// 404 for an unavailable one. `allowOutside` is set only by routes whose page offers
// Activity outside listed repos.
export function readRepositoryScope(params, res, handlers, { allowOutside = false } = {}) {
  const scope = handlers.resolveRepositoryScope(params.get("repo"), { allowOutside });
  if (scope.kind !== "unavailable") return scope;
  send(res, 404, "application/json", JSON.stringify({
    error: { code: REPOSITORY_SCOPE_UNAVAILABLE, message: "This repository is not available." },
  }));
  return null;
}
