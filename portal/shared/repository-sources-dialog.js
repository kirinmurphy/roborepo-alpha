// The Manage repositories dialog (pljvmyh §7): a page-singleton controller, opened from Home's
// action slot, the Plans header count, and the shared empty state. Top to bottom: auto-discovery
// (primary), one list of every known repository, then folders (secondary).
import { portalWireBackdropClose } from "/portal/shared/api.js";
import * as api from "./repository-sources-api.js";
import { autoDiscoveryBlock, folderRow, ignoredRow, repositoryRow } from "./repository-sources-templates.js";

// `onChange` runs after every successful mutation so the host page can re-read its own data.
export function createRepositorySourcesDialog({ onChange = () => {}, onPending = () => {} } = {}) {
  const dialog = document.getElementById("repository-sources-dialog");
  const info = document.getElementById("folder-scan-info");
  const slot = (name) => dialog.querySelector(`[data-slot="${name}"]`);
  const form = slot("add-form");
  const pathInput = slot("path");
  const intent = slot("intent");
  let payload = null;

  slot("close").addEventListener("click", () => dialog.close());
  portalWireBackdropClose(dialog, () => dialog.close());
  info.querySelector("[data-slot=close]").addEventListener("click", () => info.close());
  portalWireBackdropClose(info, () => info.close());
  slot("info").addEventListener("click", () => info.showModal());
  slot("add-toggle").addEventListener("click", () => setAddFormOpen(form.hidden));
  slot("wipe").addEventListener("click", wipeRepositoryList);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    addFolder();
  });
  // An answer about what one path is says nothing about the next one.
  pathInput.addEventListener("input", resetIntent);

  async function open({ addFolder: focusAdd = false } = {}) {
    if (!dialog.open) dialog.showModal();
    setAddFormOpen(focusAdd);
    await run(api.loadSources, { notify: false });
  }

  async function addFolder() {
    const kind = intent.hidden ? null : intent.querySelector("input:checked")?.value || null;
    const submit = slot("add-submit");
    submit.disabled = true;
    try {
      const ok = await run(() => api.addSource({ path: pathInput.value, kind }), { onError: handleAddError });
      if (ok) {
        pathInput.value = "";
        resetIntent();
        setAddFormOpen(false);
      }
    } finally {
      submit.disabled = false;
    }
  }

  async function wipeRepositoryList() {
    if (!payload?.repositories?.length) return;
    const confirmed = window.confirm(
      "Wipe the entire repository list? This removes all known and ignored repositories from RoboRepo. It does not delete files or folders. Enabled sources can add repositories again later.",
    );
    if (!confirmed) return;
    const wipe = slot("wipe");
    wipe.disabled = true;
    const ok = await run(api.wipeRepositoryList);
    // A successful run rendered the returned empty payload and keeps the button disabled. Restore
    // it only when the request failed and the old repository list is still present.
    if (!ok) wipe.disabled = false;
  }

  // An unreadable path cannot be classified, so the user states what it is and submits again. The
  // prompt always opens with nothing chosen: the intent must be the user's, not a leftover default.
  function handleAddError(error) {
    if (error.code !== "INTENT_REQUIRED") return false;
    intent.hidden = false;
    intent.querySelector("input")?.focus();
    return true;
  }

  function resetIntent() {
    intent.hidden = true;
    for (const radio of intent.querySelectorAll("input")) radio.checked = false;
  }

  async function run(action, { notify = true, onError = () => false } = {}) {
    showError(null);
    try {
      payload = await action();
      render();
      if (notify) onChange(payload);
      return true;
    } catch (error) {
      if (!onError(error)) showError(error);
      return false;
    }
  }

  function render() {
    if (!payload) return;
    slot("auto").replaceChildren(autoDiscoveryBlock(payload.autoDiscovery, {
      onEnable: () => run(api.enableAutoDiscovery),
      onDisable: () => run(() => api.setSourceEnabled(api.AUTO_DISCOVERY_ID, false)),
    }));
    const visible = payload.repositories.filter((repository) => repository.visibility !== "hidden");
    const ignored = payload.repositories.filter((repository) => repository.visibility === "hidden");
    const rowActions = {
      onIgnore: (repository) => run(() => api.setRepositoryIgnored(repository.repositoryId, true).then(api.loadSources)),
    };
    slot("repositories").replaceChildren(...visible.map((repository) => repositoryRow(repository, rowActions)));
    slot("repositories-empty").hidden = visible.length > 0;
    slot("wipe").hidden = payload.repositories.length === 0;
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
    if (payload.loadError) showError(payload.loadError);
  }

  function setAddFormOpen(open) {
    form.hidden = !open;
    slot("add-toggle").setAttribute("aria-expanded", String(open));
    if (open) pathInput.focus();
  }

  function showError(error) {
    const node = slot("error");
    node.hidden = !error;
    node.textContent = error ? String(error.message || error) : "";
  }

  return {
    open,
    close: () => dialog.close(),
    // For the Enable buttons outside the dialog (empty states, prompts): same request, same
    // onChange, without opening anything.
    enableAutoDiscovery: () => {
      onPending();
      return run(api.enableAutoDiscovery);
    },
  };
}
