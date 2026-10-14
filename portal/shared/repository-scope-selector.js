// The repository selector in the sub-header row theme.js adds on pages whose manifest entry sets
// `repositoryScope`. It lists the visible repositories, writes the choice to the URL through
// repository-scope.js, and opens the shared Manage repositories dialog from an action row.
//
// Pages that need to know what the scope resolved to (Agents, which loads no repository data) use
// onRepositoryScopeResolved; pages with scoped data routes also get the same answer from the route.
import "/portal/shared/option-dropdown.js";
import { portalGetJson, portalTpl as tpl } from "/portal/shared/api.js";
import { createRepositorySourcesDialog } from "/portal/shared/repository-sources-dialog.js";
import {
  clearRepositoryScope,
  currentRepositoryScope,
  onRepositoryScopeChange,
  setRepositoryScope,
} from "/portal/shared/repository-scope.js";
import {
  ALL_REPOSITORIES,
  repositoryScopeChoices,
  resolveScopeChoice,
} from "/portal/shared/repository-scope-choices.js";

const RESOLVED_EVENT = "portal:repositoryscoperesolved";
// Every page load builds this selector from scratch and the repo list is a request away, so the
// last list seen in this tab is kept: the selector then names the current repo on first paint
// instead of flashing "Unavailable repo" while the list loads. The list is path-free summaries.
const LIST_CACHE_KEY = "portal-repo-list";
let resolved = null;

function readCachedRepositories() {
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

export function mountRepositoryScopeSelector(page, host = document.getElementById("repository-scope")) {
  if (!host) return;
  const outsideActivity = Boolean(page.outsideActivityScope);
  let repositories = readCachedRepositories();
  // A cached list can name a repo as present but never as missing: a repo added since would be
  // called unavailable for a moment. Only a list fetched by this page may say "unavailable".
  let fresh = false;
  const dropdown = document.createElement("option-dropdown");
  dropdown.name = "Repo";
  dropdown.onSelect = (value) => setRepositoryScope(value === ALL_REPOSITORIES ? null : value);
  const manageDialog = createRepositorySourcesDialog({ onChange: () => void loadRepositories() });
  dropdown.actions = [{ label: "Manage Repos", icon: "pencil", onSelect: () => manageDialog.open() }];
  host.replaceChildren(dropdown);

  const render = () => {
    const scope = currentRepositoryScope();
    dropdown.fallbackLabel = fresh ? "Unavailable repo" : "\u2026";
    dropdown.options = repositoryScopeChoices(repositories || [], { outsideActivity });
    dropdown.value = scope ?? ALL_REPOSITORIES;
    if (!repositories) return;
    const resolution = resolveScopeChoice(scope, repositories, { outsideActivity });
    if (fresh || resolution.status !== "unavailable") publish({ scope, ...resolution });
  };

  async function loadRepositories() {
    try {
      repositories = (await portalGetJson("/api/repositories")).repositories || [];
      cacheRepositories(repositories);
      fresh = true;
    } catch {
      // Without the list no key can be confirmed, so a scoped page shows unavailable, never All.
      repositories = [];
      fresh = true;
    }
    render();
  }

  onRepositoryScopeChange(render);
  render();
  void loadRepositories();
}

// Calls `listener({ scope, status, repository })` with the latest resolution, now if one exists and
// again whenever the scope or the repository list changes.
export function onRepositoryScopeResolved(listener) {
  window.addEventListener(RESOLVED_EVENT, (event) => listener(event.detail));
  if (resolved) listener(resolved);
}

// The unavailable state a scoped page shows in place of its data: never all repositories, and one
// action that clears only the scope.
export function repositoryScopeUnavailableNotice() {
  const notice = tpl("tpl-repository-scope-unavailable");
  notice.querySelector("[data-action=clear-scope]").addEventListener("click", clearRepositoryScope);
  return notice;
}

function publish(detail) {
  resolved = detail;
  window.dispatchEvent(new CustomEvent(RESOLVED_EVENT, { detail }));
}
