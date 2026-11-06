import { portalFillSlots as fill, portalTpl as tpl, portalWireBackdropClose } from "/portal/shared/api.js";
import * as api from "./api.js";
import { isRunning } from "./worktree-details.js";

// A receipt binds the destructive confirmation to the inventory the user sees here.
export function createWorktreeRemoveDialog({ onRemoved }) {
  const dialog = document.getElementById("worktree-remove-dialog");
  const slot = (name) => dialog.querySelector(`[data-slot=${name}]`);
  const confirm = slot("confirm");
  const refresh = slot("refresh");
  const confirmLabel = [...confirm.childNodes];
  const refreshLabel = [...refresh.childNodes];
  let target = null;
  wireClose(dialog);

  const isCurrent = (openingTarget) => dialog.open && target === openingTarget;

  async function preview(openingTarget) {
    openingTarget.receipt = null;
    confirm.disabled = true;
    refresh.hidden = true;
    slot("status").textContent = "Checking everything this deletion would remove…";
    let result;
    try {
      result = await api.previewWorktreeRemoval(openingTarget);
    } catch (error) {
      if (isCurrent(openingTarget)) refresh.hidden = false;
      throw error;
    }
    if (!isCurrent(openingTarget)) return;
    openingTarget.receipt = result.eligible ? result.receipt : null;
    const commits = result.commits;
    slot("status").textContent = commits?.landed
      ? "Its committed work is already merged."
      : Number.isInteger(commits?.unmerged)
        ? `${commits.unmerged} unmerged commit${commits.unmerged === 1 ? "" : "s"} will be discarded.`
        : "Committed work may be lost.";
    slot("commits").textContent = commits?.subjects?.length ? commits.subjects.join("\n") : "No unmerged commit subjects listed.";
    for (const group of ["tracked", "untracked", "ignored", "disposable"]) {
      slot(group).textContent = result.groups?.[group]?.map((entry) => [
        entry.path, entry.change, Number.isInteger(entry.files) ? `${entry.files} files` : null,
        Number.isInteger(entry.bytes) ? `${entry.bytes} bytes` : null,
      ].filter(Boolean).join(" — ")).join("\n") || "None";
    }
    slot("warnings").textContent = (result.warnings || []).join("\n");
    slot("warnings").hidden = !result.warnings?.length;
    slot("running").hidden = !result.servers?.length;
    if (result.servers?.length) {
      slot("running").hidden = false;
      slot("running").textContent = `Running servers will be stopped before deletion: ${result.servers.map((server) => `pid ${server.pid}${server.ports?.length ? ` (ports ${server.ports.join(", ")})` : ""}`).join("; ")}.`;
    }
    const blockers = (result.blockers || []).map((entry) => typeof entry === "string" ? entry : [entry.path, entry.reason].filter(Boolean).join(": "));
    showError(dialog, blockers.join("\n") || (!openingTarget.receipt ? result.reason || "The worktree cannot be deleted. Refresh the preview after resolving its blockers." : null));
    confirm.disabled = !openingTarget.receipt;
    refresh.hidden = Boolean(openingTarget.receipt);
  }

  refresh.addEventListener("click", async () => {
    const openingTarget = target;
    await run(dialog, refresh, "Checking…", () => preview(openingTarget), () => isCurrent(openingTarget));
    if (isCurrent(openingTarget)) confirm.disabled = !openingTarget.receipt;
  });
  confirm.addEventListener("click", async () => {
    const openingTarget = target;
    if (!openingTarget?.receipt) return;
    await run(dialog, confirm, "Deleting…", async () => {
      const request = { ...openingTarget };
      openingTarget.receipt = null;
      const result = await api.removeWorktree(request);
      if (result.action !== "removed") {
        if (!isCurrent(openingTarget)) return;
        const differences = result.differences || {};
        const detail = Object.entries(differences).map(([kind, paths]) => `${kind}: ${Array.isArray(paths) ? paths.join(", ") : String(paths)}`).join("\n");
        throw new Error([result.reason || "The worktree was kept.", detail, result.retryCommand, "Refresh the preview and review the current state before confirming again."].filter(Boolean).join("\n"));
      }
      if (isCurrent(openingTarget)) dialog.close();
      onRemoved();
    }, () => isCurrent(openingTarget));
    if (isCurrent(openingTarget)) {
      refresh.hidden = false;
      confirm.disabled = !openingTarget.receipt;
    }
  });
  return {
    open({ repositoryId, checkout, plan = null }) {
      const branch = checkout.git?.branch || null;
      const selector = branch || checkout.worktreeName;
      if (!repositoryId || !selector) return;
      target = { repositoryId, branch: selector, receipt: null };
      for (const button of dialog.querySelectorAll("button")) button.disabled = false;
      confirm.replaceChildren(...confirmLabel);
      refresh.replaceChildren(...refreshLabel);
      confirm.removeAttribute("aria-busy");
      refresh.removeAttribute("aria-busy");
      confirm.disabled = true;
      refresh.hidden = true;
      fill(dialog, {
        lead: branch
          ? `This permanently deletes the worktree's folder on this computer and its local branch, ${branch}.`
          : `This permanently deletes the worktree's folder on this computer. It is not on a branch (detached at ${checkout.git?.shortHead || "an unknown commit"}).`,
        branch: branch || "none (detached)",
        folder: checkout.projectRoot || "<folder>",
      });
      for (const name of ["commits", "tracked", "untracked", "ignored", "disposable"]) slot(name).textContent = "Checking…";
      slot("warnings").hidden = true;
      slot("plan").hidden = !plan;
      slot("plan").textContent = plan ? `The active plan "${plan.title}" is still using this worktree. Deleting it can lose work the plan still needs, and the plan stays active without it. The plan's progress recorded in this worktree will no longer be shown in Plans.` : "";
      slot("running").hidden = !isRunning(checkout);
      slot("running").textContent = "Something is running in this worktree. It is stopped before the folder is deleted.";
      dialog.querySelector(".worktree-remove-details").open = false;
      showError(dialog, null);
      dialog.showModal();
      const openingTarget = target;
      preview(openingTarget).catch((error) => {
        if (!isCurrent(openingTarget)) return;
        showError(dialog, error.message);
      });
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
    run(dialog, confirm, "Turning on…", async () => {
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
      : "Automatic worktree cleanup is off for this repo.",
  });
  node.querySelector("[data-action=enable]").addEventListener("click", () => onEnable(repository));
  node.querySelector("[data-action=dismiss]").addEventListener("click", () => onDismiss(repository));
  return node;
}

function wireClose(dialog) {
  for (const close of dialog.querySelectorAll("[data-close]")) close.addEventListener("click", () => dialog.close());
  portalWireBackdropClose(dialog, () => dialog.close());
}

// Disables the dialog's buttons while a request runs, and shows its failure in the dialog. The button
// that started it shows a spinner and a busy label, since removing a worktree can take seconds.
async function run(dialog, busyButton, busyLabel, action, isCurrent = () => true) {
  const buttons = [...dialog.querySelectorAll("button")];
  for (const button of buttons) button.disabled = true;
  const label = [...busyButton.childNodes];
  const spinner = document.createElement("span");
  spinner.className = "button-spinner";
  spinner.setAttribute("aria-hidden", "true");
  busyButton.replaceChildren(spinner, busyLabel);
  busyButton.setAttribute("aria-busy", "true");
  showError(dialog, null);
  try {
    await action();
  } catch (error) {
    if (isCurrent()) showError(dialog, error.message || String(error));
  } finally {
    if (isCurrent()) {
      // The action may have relabeled the button (the cleanup dialog's "Done"); keep that label.
      if (busyButton.firstChild === spinner) busyButton.replaceChildren(...label);
      busyButton.removeAttribute("aria-busy");
      for (const button of buttons) button.disabled = false;
    }
  }
}

function showError(dialog, message) {
  const error = dialog.querySelector("[data-slot=error]");
  error.hidden = !message;
  error.textContent = message || "";
}
