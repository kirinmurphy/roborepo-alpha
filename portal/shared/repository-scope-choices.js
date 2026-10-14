// What the repository selector offers, and what the current scope resolves to, from the
// path-free GET /api/repositories summaries. Pure (no DOM, no imports) so a Node check can pin it.

import { OUTSIDE_ACTIVITY_SCOPE } from "./repository-scope.js";

// The selector's value for All repositories: <option-dropdown> compares values with ===, and the
// URL has no parameter at all in that state.
export const ALL_REPOSITORIES = "";
export const ALL_REPOSITORIES_LABEL = "All repositories";
export const OUTSIDE_ACTIVITY_LABEL = "Activity outside listed repos";

// [[value, label]] for <option-dropdown>: All, each visible repository by display name, then
// Activity outside listed repos where the page offers it.
export function repositoryScopeChoices(repositories, { outsideActivity = false } = {}) {
  const sorted = [...repositories].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.urlKey.localeCompare(b.urlKey));
  const labels = disambiguatedLabels(sorted);
  return [
    [ALL_REPOSITORIES, ALL_REPOSITORIES_LABEL],
    ...sorted.map((repository) => [repository.urlKey, labels.get(repository.urlKey)]),
    ...(outsideActivity ? [[OUTSIDE_ACTIVITY_SCOPE, OUTSIDE_ACTIVITY_LABEL]] : []),
  ];
}

// { status: "all" | "repository" | "outside" | "unavailable", repository? } for `scope` on a page.
// The selector decides this from its own list, so a page that loads no repository data (Agents)
// shows the same unavailable state as one whose data route refused the key.
export function resolveScopeChoice(scope, repositories, { outsideActivity = false } = {}) {
  if (!scope) return { status: "all" };
  if (scope === OUTSIDE_ACTIVITY_SCOPE) return { status: outsideActivity ? "outside" : "unavailable" };
  const repository = repositories.find((candidate) => candidate.urlKey === scope);
  return repository ? { status: "repository", repository } : { status: "unavailable" };
}

// Two repositories with one display name are told apart by their provider owner, or by urlKey when
// there is no provider URL or the owners match too. Never by a filesystem path.
function disambiguatedLabels(repositories) {
  const byName = new Map();
  for (const repository of repositories) {
    byName.set(repository.displayName, [...(byName.get(repository.displayName) || []), repository]);
  }
  const labels = new Map();
  for (const [name, group] of byName) {
    const owners = group.map((repository) => providerOwner(repository.providerUrl));
    for (const [index, repository] of group.entries()) {
      const owner = owners[index];
      const ownerIsUnique = owner && owners.filter((candidate) => candidate === owner).length === 1;
      const suffix = group.length === 1 ? null : ownerIsUnique ? owner : repository.urlKey;
      labels.set(repository.urlKey, suffix ? `${name} (${suffix})` : name);
    }
  }
  return labels;
}

function providerOwner(providerUrl) {
  if (!providerUrl) return null;
  try {
    return new URL(providerUrl).pathname.split("/").filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}
