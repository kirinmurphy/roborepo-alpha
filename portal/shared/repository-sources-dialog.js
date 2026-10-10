// The repository-source surface (pljvmyh §7): one controller powers both the Manage Repos dialog
// and Settings' inline surface. Top to bottom: auto-discovery (primary), one list of every known
// repository, then folders (secondary).
import { portalWireBackdropClose } from "/portal/shared/api.js";
import * as api from "./repository-sources-api.js";
import { autoDiscoveryBlock, folderRow, ignoredRow, repositoryRow } from "./repository-sources-templates.js";

// `onChange` runs after every successful mutation so the host page can re-read its own data.
export function createRepositorySourcesDialog({ onChange = () => {}, onPending = () => {} } = {}) {
  const dialog = document.getElementById("repository-sources-dialog");
  const syncStatus = dialog.querySelector("[data-repository-sync-status]");
  const info = document.getElementById("folder-scan-info");
  let syncPollTimer = null;
  const surface = createRepositorySourcesSurface({
    host: dialog.querySelector("[data-sources-host]"),
    info,
    onChange,
    onPending: (isPending) => {
      if (isPending) setDialogSyncStatus("syncing", true);
      else void refreshDialogSyncStatus();
      onPending(isPending);
    },
  });
  dialog.querySelector('[data-slot="close"]').addEventListener("click", () => dialog.close());
  portalWireBackdropClose(dialog, () => dialog.close());

  async function open({ addFolder: focusAdd = false } = {}) {
    if (!dialog.open) dialog.showModal();
    surface.setAddFormOpen(focusAdd);
    await surface.refresh();
    await refreshDialogSyncStatus();
  }

  async function refreshDialogSyncStatus() {
    if (!dialog.open) return;
    try {
      const overview = await api.loadHomeOverview();
      if (!dialog.open) return;
      const enabled = overview.autoDiscovery?.enabled === true;
      setDialogSyncStatus(enabled ? overview.sync?.state || "synced" : "synced", enabled);
      clearTimeout(syncPollTimer);
      if (enabled && overview.sync?.state === "syncing") {
        syncPollTimer = setTimeout(refreshDialogSyncStatus, 750);
      }
    } catch {
      setDialogSyncStatus("unavailable", !syncStatus.hidden);
    }
  }

  function setDialogSyncStatus(state, visible) {
    syncStatus.hidden = !visible;
    syncStatus.classList.toggle("is-syncing", state === "syncing");
    syncStatus.classList.toggle("is-synced", state === "synced");
    syncStatus.classList.toggle("is-failed", state === "failed" || state === "unavailable");
    syncStatus.querySelector("[data-slot=text]").textContent = ({
      syncing: "Syncing",
      synced: "Synced",
      failed: "Sync failed",
      unavailable: "Sync status unavailable",
    })[state] || "Synced";
  }

  dialog.addEventListener("close", () => clearTimeout(syncPollTimer));

  return {
    open,
    close: () => dialog.close(),
    refresh: surface.refresh,
    enableAutoDiscovery: surface.enableAutoDiscovery,
  };
}

export function createRepositorySourcesInline({ host = document.getElementById("repository-sources-inline"), onChange = () => {}, onPending = () => {}, onAutoDiscoveryEnabled = () => {} } = {}) {
  const info = document.getElementById("folder-scan-info");
  const surface = createRepositorySourcesSurface({ host, info, onChange, onPending, onAutoDiscoveryEnabled });
  surface.refresh();
  return surface;
}

function createRepositorySourcesSurface({ host, info, onChange, onPending, onAutoDiscoveryEnabled }) {
  onAutoDiscoveryEnabled ??= refreshAfterAutoDiscovery;
  host.replaceChildren(document.getElementById("tpl-repository-sources-surface").content.cloneNode(true));
  const surface = host.querySelector("[data-sources-surface]");
  const foldersSection = surface.querySelector(".sources-folders");
  const surfaceKey = host.closest("dialog") ? "dialog" : "inline";
  const pathId = `repository-source-path-${surfaceKey}`;
  surface.querySelector("[data-slot=path]").id = pathId;
  surface.querySelector("[data-slot=add-form] label").setAttribute("for", pathId);
  const slot = (name) => surface.querySelector(`[data-slot="${name}"]`);
  const form = slot("add-form");
  const pathInput = slot("path");
  const pathError = slot("path-error");
  pathError.id = `${pathId}-error`;
  pathInput.setAttribute("aria-describedby", pathError.id);
  let payload = null;
  let visibleRepositoryCount = 0;
  let autoDiscoveryEnabled = false;

  info.querySelector("[data-slot=close]").addEventListener("click", () => info.close());
  portalWireBackdropClose(info, () => info.close());
  slot("info").addEventListener("click", () => info.showModal());
  for (const toggle of [slot("add-toggle-empty"), slot("add-toggle-list")]) {
    toggle.addEventListener("click", () => setAddFormOpen(form.hidden));
  }
  slot("cancel").addEventListener("click", () => {
    pathInput.value = "";
    clearPathError();
    setAddFormOpen(false);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    addFolder();
  });
  pathInput.addEventListener("input", clearPathError);

  async function addFolder() {
    const submit = slot("add-submit");
    submit.disabled = true;
    try {
      const ok = await run(() => api.addSource({ path: pathInput.value }), { onError: handleAddError });
      if (ok) {
        pathInput.value = "";
        clearPathError();
        setAddFormOpen(false);
      }
    } finally {
      submit.disabled = false;
    }
  }

  async function wipeRepositoryList() {
    if (!payload || (!payload.repositories.length && !payload.sources.length)) return;
    const confirmed = window.confirm(
      "Clear all repos? This removes all known and ignored repositories and all configured repository or folder sources from RoboRepo. It does not delete files or folders. Auto-discovery stays as configured and can add repositories again later.",
    );
    if (!confirmed) return;
    const wipe = slot("wipe");
    const scanAfterWipe = payload.autoDiscovery?.enabled === true;
    if (scanAfterWipe) onPending(true);
    wipe.disabled = true;
    try {
      const ok = await run(async () => {
        const result = await api.wipeRepositoryList();
        // A server may clear the registry but leave configured folder sources in its response.
        // Remove any survivors explicitly, then render a fresh source list.
        for (const source of result.sources) await api.removeSource(source.id);
        return api.loadSources();
      });
      if (!ok) {
        wipe.disabled = false;
      } else if (scanAfterWipe) {
        await finishAutoDiscovery();
      }
    } finally {
      if (scanAfterWipe) onPending(false);
    }
  }

  function handleAddError(error) {
    if (error.code !== "INTENT_REQUIRED") return false;
    pathError.textContent = "Folder not found. Check the path and try again.";
    pathError.hidden = false;
    pathInput.focus();
    return true;
  }

  function clearPathError() {
    pathError.textContent = "";
    pathError.hidden = true;
  }

  async function refresh() {
    return run(api.loadSources, { notify: false });
  }

  async function run(action, { notify = true, onError = () => false } = {}) {
    showError(null);
    try {
      payload = await action();
      render();
      if (notify) await onChange(payload);
      return true;
    } catch (error) {
      if (!onError(error)) showError(error);
      return false;
    }
  }

  function render() {
    if (!payload) return;
    autoDiscoveryEnabled = payload.autoDiscovery?.enabled === true;
    const syncStatus = host.closest("dialog")?.querySelector("[data-repository-sync-status]");
    if (syncStatus) syncStatus.hidden = !autoDiscoveryEnabled;
    slot("auto").replaceChildren(autoDiscoveryBlock(payload.autoDiscovery, {
      onEnable: enableAutoDiscovery,
      onDisable: () => run(() => api.setSourceEnabled(api.AUTO_DISCOVERY_ID, false)),
      onWipe: wipeRepositoryList,
      hasWipeableItems: payload.repositories.length > 0 || payload.sources.length > 0,
    }));
    const visible = payload.repositories.filter((repository) => repository.visibility !== "hidden");
    const ignored = payload.repositories.filter((repository) => repository.visibility === "hidden");
    visibleRepositoryCount = visible.length;
    slot("repositories-head").hidden = visibleRepositoryCount > 0;
    const rowActions = {
      onIgnore: (repository) => run(() => api.setRepositoryIgnored(repository.repositoryId, true).then(api.loadSources)),
    };
    slot("repositories").replaceChildren(...visible.map((repository) => repositoryRow(repository, rowActions)));
    slot("repositories-empty").hidden = visible.length > 0;
    updateAddToggleVisibility();
    slot("ignored-group").hidden = ignored.length === 0;
    slot("ignored-summary").textContent = `Ignored (${ignored.length})`;
    slot("ignored").replaceChildren(...ignored.map((repository) => ignoredRow(repository, {
      onRestore: () => run(() => api.setRepositoryIgnored(repository.repositoryId, false).then(api.loadSources)),
    })));
    slot("folders").replaceChildren(...payload.sources.map((source) => folderRow(source, {
      onRefresh: () => run(() => api.refreshSources(source.id)),
      onToggle: () => run(() => api.setSourceEnabled(source.id, !source.enabled)),
      onRemove: () => run(() => api.removeSource(source.id)),
    })));
    updateFoldersSectionVisibility();
    if (payload.loadError) showError(payload.loadError);
  }

  function setAddFormOpen(open) {
    form.hidden = !open;
    updateFoldersSectionVisibility();
    updateAddToggleVisibility();
    if (open) pathInput.focus();
  }

  function updateFoldersSectionVisibility() {
    foldersSection.hidden = Boolean(payload && payload.sources.length === 0 && form.hidden);
  }

  function updateAddToggleVisibility() {
    const emptyToggle = slot("add-toggle-empty");
    const listToggle = slot("add-toggle-list");
    emptyToggle.hidden = form.hidden === false || visibleRepositoryCount > 0;
    listToggle.hidden = form.hidden === false || visibleRepositoryCount === 0;
    emptyToggle.setAttribute("aria-expanded", String(!form.hidden));
    listToggle.setAttribute("aria-expanded", String(!form.hidden));
  }

  function showError(error) {
    const node = slot("error");
    node.hidden = !error;
    node.textContent = error ? String(error.message || error) : "";
  }

  async function enableAutoDiscovery() {
    onPending(true);
    try {
      if (await run(api.enableAutoDiscovery)) await finishAutoDiscovery();
    } finally {
      onPending(false);
    }
  }

  async function finishAutoDiscovery() {
    try {
      await onAutoDiscoveryEnabled();
    } catch (error) {
      showError(error);
    }
  }

  async function refreshAfterAutoDiscovery() {
    await api.refreshDeveloperRuntime();
    payload = await api.loadSources();
    render();
    await onChange(payload);
  }

  return {
    refresh,
    setAddFormOpen,
    slot,
    getSnapshot: () => payload,
    enableAutoDiscovery,
  };
}
