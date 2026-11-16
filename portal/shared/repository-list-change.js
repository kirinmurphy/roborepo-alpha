// The one "repos changed" signal, and the visible repo list it carries.
//
// The Manage Repos dialog and Settings' inline repo list call notifyRepositoriesChanged after every
// change they save: add, remove, enable or disable a source, refresh, ignore, restore, wipe, and
// turning on auto-discovery. Every page part that shows the repo list, or data that depends on it,
// subscribes once and re-reads its own data:
//
//   onRepositoriesChanged(({ repositories }) => reload());
//
// Before any subscriber runs, a selected repo (`?repo=`) that is no longer listed is cleared, the
// same way the "Show all repos" action clears it. Scope-aware pages then re-read for All repos instead
// of showing the unavailable notice for a repo the user just removed or ignored.
import { portalGetJson } from "/portal/shared/api.js";
import { OUTSIDE_ACTIVITY_SCOPE, clearRepositoryScope, currentRepositoryScope } from "/portal/shared/repository-scope.js";

// Every page load builds the header selector from scratch and the repo list is a request away, so
// the last list seen in this tab is kept for its first paint. The list is path-free summaries.
const LIST_CACHE_KEY = "portal-repo-list";
const listeners = new Set();

// Returns a function that unsubscribes. `listener({ repositories })` gets the fresh visible list,
// or null when it could not be read; it may return a promise, which the dialog waits for.
export function onRepositoriesChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function notifyRepositoriesChanged() {
  const repositories = await loadRepositoryList();
  if (repositories) clearUnlistedScope(repositories);
  await Promise.all([...listeners].map((listener) => listener({ repositories })));
}

// The visible repos from GET /api/repositories, or null when the request fails. A successful read
// also refreshes the tab's cached copy.
export async function loadRepositoryList() {
  try {
    const repositories = (await portalGetJson("/api/repositories")).repositories || [];
    cacheRepositories(repositories);
    return repositories;
  } catch {
    return null;
  }
}

export function readCachedRepositories() {
  try {
    const list = JSON.parse(sessionStorage.getItem(LIST_CACHE_KEY));
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

function cacheRepositories(list) {
  try {
    sessionStorage.setItem(LIST_CACHE_KEY, JSON.stringify(list));
  } catch {
    // Private windows and blocked storage just lose the head start.
  }
}

// Activity outside listed repos is not a repo, so no list change can remove it.
function clearUnlistedScope(repositories) {
  const scope = currentRepositoryScope();
  if (!scope || scope === OUTSIDE_ACTIVITY_SCOPE) return;
  if (!repositories.some((repository) => repository.urlKey === scope)) clearRepositoryScope();
}
