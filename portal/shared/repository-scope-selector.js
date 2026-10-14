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
let resolved = null;

export function mountRepositoryScopeSelector(page, host = document.getElementById("repository-scope")) {
  if (!host) return;
  const outsideActivity = Boolean(page.outsideActivityScope);
  let repositories = null;
  const dropdown = document.createElement("option-dropdown");
  dropdown.name = "Repository";
  dropdown.fallbackLabel = "Unavailable repository";
  dropdown.onSelect = (value) => setRepositoryScope(value === ALL_REPOSITORIES ? null : value);
  const manageDialog = createRepositorySourcesDialog({ onChange: () => void loadRepositories() });
  dropdown.actions = [{ label: "Manage repositories…", onSelect: () => manageDialog.open() }];
  host.replaceChildren(dropdown);

  const render = () => {
    const scope = currentRepositoryScope();
    dropdown.options = repositoryScopeChoices(repositories || [], { outsideActivity });
    dropdown.value = scope ?? ALL_REPOSITORIES;
    if (repositories) publish({ scope, ...resolveScopeChoice(scope, repositories, { outsideActivity }) });
  };

  async function loadRepositories() {
    try {
      repositories = (await portalGetJson("/api/repositories")).repositories || [];
    } catch {
      // Without the list no key can be confirmed, so a scoped page shows unavailable, never All.
      repositories = [];
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
