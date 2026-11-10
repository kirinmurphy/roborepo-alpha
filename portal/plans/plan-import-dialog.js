// Import Plan: a Markdown file is previewed before anything is saved. A new plan goes to Backlog; an
// existing id shows its diff and asks first. The server decides both, and refuses lifecycle or approval
// changes, so this file only presents what it answers.
import { portalWireBackdropClose } from "/portal/shared/api.js";
import * as api from "./api.js";

export function createPlanImportDialog({ repositories, onSaved }) {
  const dialog = document.getElementById("plan-import-dialog");
  const slot = (name) => dialog.querySelector(`[data-slot=${name}]`);
  const confirm = slot("confirm");
  let upload = null; // { filename, markdown }
  let preview = null;
  let saving = false;
  let saved = false;

  const show = (name, visible) => { slot(name).hidden = !visible; };

  function resetResult() {
    preview = null;
    saved = false;
    for (const name of ["preview", "notice", "diff", "status"]) show(name, false);
    slot("error").replaceChildren();
    confirm.hidden = false;
    confirm.disabled = true;
    confirm.textContent = "Add to Backlog";
    slot("cancel").textContent = "Cancel";
  }

  function showError(err) {
    const lines = [err?.message || String(err), err?.resolution, ...(err?.details || [])].filter(Boolean);
    slot("error").replaceChildren(...lines.map((line) => {
      const node = document.createElement("p");
      node.textContent = line;
      return node;
    }));
  }

  function renderDiff(diff) {
    slot("diff").replaceChildren(...diff.split("\n").map((line) => {
      const node = document.createElement("div");
      node.textContent = line || " ";
      if (line.startsWith("+")) node.className = "plan-import-diff-add";
      if (line.startsWith("-")) node.className = "plan-import-diff-remove";
      return node;
    }));
  }

  function renderPreview() {
    const [, folder = preview.lifecycle] = preview.path.split("/");
    slot("title").textContent = preview.title;
    slot("id").textContent = preview.id;
    slot("filename").textContent = preview.path.split("/").pop();
    slot("folder").textContent = folder;
    show("preview", true);
    const update = preview.action === "update";
    const unchanged = preview.action === "unchanged";
    slot("notice").textContent = unchanged
      ? "This file matches the saved plan, so there is nothing to change."
      : update ? "A plan with this ID already exists. Updating replaces its content and leaves it in this folder." : "";
    show("notice", update || unchanged);
    if (update) renderDiff(preview.diff);
    show("diff", update);
    confirm.textContent = update ? "Update Plan" : "Add to Backlog";
    confirm.disabled = unchanged;
  }

  async function refreshPreview() {
    resetResult();
    const repositoryId = slot("repo").value;
    if (!upload || !repositoryId) return;
    const request = upload;
    try {
      const answer = await api.previewPlanImport({ repositoryId, ...request });
      // Another file or repo was picked while this one was on its way.
      if (request !== upload || repositoryId !== slot("repo").value) return;
      preview = answer;
      renderPreview();
    } catch (err) {
      if (request === upload) showError(err);
    }
  }

  function renderRepositories() {
    const list = repositories();
    const select = slot("repo");
    const options = list.map((repository) => new Option(repository.name, repository.repositoryId));
    // More than one repo is a question for the person, so nothing starts selected.
    select.replaceChildren(...(list.length > 1 ? [new Option("Choose a repo", "")] : []), ...options);
    show("repo-row", list.length > 1);
  }

  async function save() {
    saving = true;
    confirm.disabled = true;
    slot("error").replaceChildren();
    try {
      const result = await api.savePlanImport({ repositoryId: slot("repo").value, ...upload, ...(preview.action === "create" ? { newId: preview.id } : {}) });
      saved = true;
      confirm.hidden = true;
      slot("cancel").textContent = "Done";
      slot("status").textContent = result.synchronized
        ? `Saved ${result.path} and pushed it to the remote.`
        : `Saved ${result.path} on this machine, but the remote did not take it${result.reason ? ` (${result.reason})` : ""}. Press Refresh to push it once the remote can be reached and accepts it.`;
      show("status", true);
      await onSaved();
    } catch (err) {
      showError(err);
      confirm.disabled = false;
    } finally {
      saving = false;
    }
  }

  slot("repo").addEventListener("change", refreshPreview);
  slot("file").addEventListener("change", async () => {
    const [file] = slot("file").files;
    upload = null;
    if (file) upload = { filename: file.name, markdown: await file.text() };
    await refreshPreview();
  });
  confirm.addEventListener("click", () => { if (preview && !saved && !saving) save(); });
  const close = () => { if (!saving) dialog.close(); };
  slot("cancel").addEventListener("click", close);
  slot("close").addEventListener("click", close);
  portalWireBackdropClose(dialog, close);
  // Esc is the same as Cancel, so it waits for a save in flight too.
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });

  return {
    open() {
      upload = null;
      slot("file").value = "";
      renderRepositories();
      resetResult();
      dialog.showModal();
    },
  };
}
