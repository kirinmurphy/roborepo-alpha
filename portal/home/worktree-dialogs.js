import { portalFillSlots as fill, portalTpl as tpl, portalWireBackdropClose } from "/portal/shared/api.js";
import * as api from "./api.js";

// Home's worktree removal confirmation. One dialog serves every row: `open` fills it for a worktree,
// and confirming removes it through the same guards as `roborepo git worktrees cleanup --remove`.
// A refused removal keeps the dialog open with the guard's reason.
export function createWorktreeRemoveDialog({ onRemoved }) {
  const dialog = document.getElementById("worktree-remove-dialog");
  const slot = (name) => dialog.querySelector(`[data-slot=${name}]`);
  let target = null;
  wireClose(dialog);
  slot("confirm").addEventListener("click", () => run(dialog, async () => {
    const result = await api.removeWorktree(target);
    if (result.action !== "removed") throw new Error(result.reason || "The worktree was kept.");
    dialog.close();
    onRemoved();
  }));
  return {
    open({ repositoryId, checkout, plan = null }) {
      const branch = checkout.git?.branch || null;
      // A detached worktree has no branch; the cleanup command finds it, and archives its HEAD, by
      // Git's administrative name instead.
      const selector = branch || checkout.worktreeName;
      if (!repositoryId || !selector) return;
      target = { repositoryId, branch: selector };
      fill(dialog, {
        branch: branch || `detached (${checkout.worktreeName})`,
        unmerged: Number.isInteger(checkout.unmergedCommits) ? String(checkout.unmergedCommits) : "unknown",
        archive: `refs/roborepo/abandoned/${selector}`,
      });
      slot("plan").hidden = !plan;
      slot("plan").textContent = plan ? `Active plan "${plan.title}" uses this worktree. Removing it leaves the plan active without its worktree.` : "";
      showError(dialog, null);
      dialog.showModal();
    },
  };
}

// The card-footer notice's dialog: confirm the folder automatic removal may act in, then install the
// post-merge hook. Another tool's hook cannot be merged automatically, so the dialog shows the line
// to add and records the folder for when it is.
export function createWorktreeCleanupDialog({ onChanged }) {
  const dialog = document.getElementById("worktree-cleanup-dialog");
  const slot = (name) => dialog.querySelector(`[data-slot=${name}]`);
  const confirm = slot("confirm");
  const folder = slot("folder");
  let repositoryId = null;
  let done = false;
  wireClose(dialog);
  confirm.addEventListener("click", () => {
    if (done) {
      dialog.close();
      onChanged();
      return;
    }
    run(dialog, async () => {
      const result = await api.enableWorktreeCleanup({ repositoryId, folder: folder.value.trim() });
      if (result.action === "refused") throw new Error(result.reason);
      if (result.action === "foreign hook") {
        fill(dialog, { hook: result.hook, line: result.line });
        slot("foreign").hidden = false;
        folder.readOnly = true;
        confirm.textContent = "Done";
        done = true;
        return;
      }
      dialog.close();
      onChanged();
    });
  });
  return {
    open(repository) {
      const cleanup = repository.domains.runtime.data?.worktreeCleanup || {};
      repositoryId = repository.repositoryId;
      done = false;
      fill(dialog, { repository: repository.displayName });
      folder.value = cleanup.folder || cleanup.proposedFolder || "";
      folder.readOnly = cleanup.folderSource === "plans-config";
      slot("folder-source").hidden = !folder.readOnly;
      slot("foreign").hidden = true;
      confirm.textContent = "Turn on";
      showError(dialog, null);
      dialog.showModal();
    },
  };
}

export function worktreeCleanupNotice(repository, { onEnable, onDismiss }) {
  const cleanup = repository.domains.runtime.data?.worktreeCleanup;
  if (!cleanup?.offered) return null;
  const node = fill(tpl("tpl-worktree-cleanup-notice"), {
    text: cleanup.hook === "foreign"
      ? "Automatic worktree cleanup is off; another tool's post-merge hook is installed."
      : "Automatic worktree cleanup is off for this repository.",
  });
  node.querySelector("[data-action=enable]").addEventListener("click", () => onEnable(repository));
  node.querySelector("[data-action=dismiss]").addEventListener("click", () => onDismiss(repository));
  return node;
}

function wireClose(dialog) {
  for (const close of dialog.querySelectorAll("[data-close]")) close.addEventListener("click", () => dialog.close());
  portalWireBackdropClose(dialog, () => dialog.close());
}

// Disables the dialog's buttons while a request runs, and shows its failure in the dialog.
async function run(dialog, action) {
  const buttons = [...dialog.querySelectorAll("button")];
  for (const button of buttons) button.disabled = true;
  showError(dialog, null);
  try {
    await action();
  } catch (error) {
    showError(dialog, error.message || String(error));
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

function showError(dialog, message) {
  const error = dialog.querySelector("[data-slot=error]");
  error.hidden = !message;
  error.textContent = message || "";
}
