// The Portal-wide repository scope: the `?repo=` value Plans, Tokens, and Agents share,
// resolved once at the route into a canonical repository id. A urlKey is a browser key only; domain
// code receives the canonical repositoryId.
import { repositoryIdForUrlKey } from "./registry.mjs";

// Telemetry not attributed to any listed repository. `_` cannot appear in a urlKey
// (URL_KEY_PATTERN), so this value never collides with a repository.
export const OUTSIDE_ACTIVITY_SCOPE = "_other";

// Resolves a raw `repository` parameter to one of:
//   { kind: "all" }                          — no parameter (or an empty one)
//   { kind: "repository", repositoryId }     — a visible repository's urlKey
//   { kind: "outside" }                      — OUTSIDE_ACTIVITY_SCOPE, where the page allows it
//   { kind: "unavailable" }                  — malformed, unknown, or hidden; never "all"
export function resolveRepositoryScope(registry, value, { allowOutside = false } = {}) {
  if (value == null || value === "") return { kind: "all" };
  if (value === OUTSIDE_ACTIVITY_SCOPE) return allowOutside ? { kind: "outside" } : { kind: "unavailable" };
  let repositoryId = null;
  try {
    repositoryId = repositoryIdForUrlKey(registry, value);
  } catch {
    // A malformed key is an unavailable scope, not a server error.
  }
  return repositoryId ? { kind: "repository", repositoryId } : { kind: "unavailable" };
}

// The repositories the selector lists: every visible record, the same set GET /api/repositories
// returns. Activity outside the scope is activity attributed to none of these.
export function listedRepositoryIds(registry) {
  return Object.values(registry.repositories || {})
    .filter((record) => record.visibility !== "hidden")
    .map((record) => record.id);
}
