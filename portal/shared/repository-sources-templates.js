// Fills for the repository-sources templates (repository-sources-partial.html): the dialog's rows,
// and the empty state and auto-discovery prompt that Home, Plans, and Runtime share.
import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";

const SOURCE_STATE_LABELS = {
  pending: "Not scanned yet",
  healthy: "Healthy",
  partial: "Partial",
  unavailable: "Unavailable",
  stale: "No repository here",
  error: "Error",
};

// Home and Plans render the same empty state, so their onboarding copy and actions cannot drift.
// Enable is primary whenever auto-discovery is off; Add a folder is always secondary.
export function repositoryEmptyState({ autoDiscoveryEnabled, onEnable, onAddFolder }) {
  const node = fill(tpl("tpl-repository-empty-state"), {
    title: "No repositories yet",
    body: autoDiscoveryEnabled
      ? "Start a dev server in any repository and it appears here."
      : "Turn on auto-discovery and RoboRepo remembers each repository you run a dev server in. Nothing is observed until you do.",
  });
  const enable = node.querySelector("[data-slot=enable]");
  if (autoDiscoveryEnabled) enable.remove();
  else wireOnce(enable, onEnable);
  node.querySelector("[data-slot=add-folder]").addEventListener("click", onAddFolder);
  return node;
}

export function autoDiscoveryPrompt({ onEnable }) {
  const node = tpl("tpl-auto-discovery-prompt");
  wireOnce(node.querySelector("[data-slot=enable]"), onEnable);
  return node;
}

export function autoDiscoveryBlock(autoDiscovery, { onEnable, onDisable, onWipe, hasWipeableItems = false }) {
  if (!autoDiscovery.enabled) {
    const node = tpl("tpl-sources-auto-off");
    wireOnce(node.querySelector("[data-slot=enable]"), onEnable);
    configureWipe(node, { onWipe, hasWipeableItems });
    return node;
  }
  const count = autoDiscovery.repositoryCount;
  const node = fill(tpl("tpl-sources-auto-on"), { status: `On · ${count} ${count === 1 ? "repo" : "repos"} found` });
  wireOnce(node.querySelector("[data-slot=disable]"), onDisable);
  configureWipe(node, { onWipe, hasWipeableItems });
  return node;
}

function configureWipe(node, { onWipe, hasWipeableItems }) {
  const wipe = node.querySelector("[data-slot=wipe]");
  wipe.hidden = !hasWipeableItems;
  if (hasWipeableItems) wireOnce(wipe, onWipe);
}

// Every row offers the same actions whatever found the repository; its compact source state stays
// alongside the name so it does not add a second visual row.
export function repositoryRow(repository, { onIgnore }) {
  const foundState = repositoryFoundState(repository.foundBy);
  const node = fill(tpl("tpl-sources-repository"), {
    name: repository.displayName,
    "found-state": foundState,
  });
  wireOnce(node.querySelector("[data-slot=ignore]"), () => onIgnore(repository));
  return node;
}

function repositoryFoundState(foundBy = []) {
  if (foundBy.includes("auto-discovery")) return "auto-discovered";
  const folders = foundBy
    .filter((source) => source.includes("/"))
    .map((source) => source.split("/").filter(Boolean).at(-1))
    .filter(Boolean);
  if (folders.length) return `in /${[...new Set(folders)].join(", /")}`;
  return foundBy.length ? "auto-discovered" : "no current source";
}

export function ignoredRow(repository, { onRestore }) {
  const node = fill(tpl("tpl-sources-ignored"), { name: repository.displayName });
  wireOnce(node.querySelector("[data-slot=restore]"), () => onRestore(repository));
  return node;
}

export function folderRow(source, { onRefresh, onToggle, onRemove }) {
  const { state, repositoryCount, message } = source.status;
  const counted = `${repositoryCount} ${repositoryCount === 1 ? "repo" : "repos"}`;
  const node = fill(tpl("tpl-sources-folder"), {
    state: source.enabled ? SOURCE_STATE_LABELS[state] || state : "Disabled",
    summary: [source.kind === "repository" ? "Repository" : "Folder", counted, message].filter(Boolean).join(" · "),
    toggle: source.enabled ? "Disable" : "Enable",
  });
  fillPath(node.querySelector("[data-slot=path]"), source.displayPath);
  node.querySelector("[data-slot=state]").classList.add(`is-${source.enabled ? state : "disabled"}`);
  const refresh = node.querySelector("[data-slot=refresh]");
  if (!source.enabled) refresh.remove();
  else wireOnce(refresh, () => onRefresh(source));
  wireOnce(node.querySelector("[data-slot=toggle]"), () => onToggle(source));
  wireOnce(node.querySelector("[data-slot=remove]"), () => onRemove(source));
  return node;
}

// Long paths shrink from the middle: the leading folders give way first and the last segment, the
// part that tells sibling folders apart, always shows. The tooltip carries the full path.
function fillPath(node, displayPath) {
  const cut = displayPath.lastIndexOf("/", displayPath.length - 2) + 1;
  const head = document.createElement("span");
  head.className = "sources-path-head";
  head.textContent = displayPath.slice(0, cut);
  const tail = document.createElement("span");
  tail.className = "sources-path-tail";
  tail.textContent = displayPath.slice(cut);
  node.title = displayPath;
  node.replaceChildren(head, tail);
}

// Disables the button for the duration of its async action so a double click cannot send twice.
function wireOnce(button, action) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await action();
    } finally {
      button.disabled = false;
    }
  });
}
