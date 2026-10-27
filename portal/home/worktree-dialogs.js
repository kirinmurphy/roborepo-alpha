import { portalFillSlots as fill, portalTpl as tpl, portalWireBackdropClose } from "/portal/shared/api.js";
import * as api from "./api.js";
import { isRunning } from "./worktree-details.js";

// Home's Delete Worktree confirmation. One dialog serves every row: `open` fills it for a worktree,
// and confirming stops its servers and removes it through the same guards as
// `roborepo git worktrees cleanup --remove`. A refused removal keeps the dialog open with the reason.
export function createWorktreeRemoveDialog({ onRemoved }) {
  const dialog = document.getElementById("worktree-remove-dialog");
  const slot = (name) => dialog.querySelector(`[data-slot=${name}]`);
  let target = null;
  wireClose(dialog);
  const confirm = slot("confirm");
  const archiveConfirm = slot("archive-confirm");
  archiveConfirm.addEventListener("click", () => run(dialog, archiveConfirm, "Archiving…", async () => {
    const result = await api.archiveWorktree(target);
    const recovery = slot("snapshot-result");
    if (result.snapshotRef) {
      recovery.hidden = false;
      recovery.textContent = `${result.snapshotRef}\n${result.restoreCommand}`;
    }
    if (result.action !== "removed") throw new Error(result.reason || "The worktree was kept.");
    confirm.hidden = true;
    archiveConfirm.hidden = true;
    slot("status").textContent = "Worktree archived and removed. Its archived changes have not been submitted or merged.";
    slot("dirty").hidden = true;
    onRemoved();
  }));
  confirm.addEventListener("click", () => run(dialog, confirm, "Deleting…", async () => {
    const result = await api.removeWorktree(target);
    if (result.requiresDiscardConfirmation) {
      target.discardChanges = true;
      slot("dirty").hidden = false;
      confirm.dataset.btn = "danger";
      slot("status").textContent = "Only committed work can be restored from the backup.";
      return;
    }
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
      const dirty = checkout.git?.dirty === true || checkout.worktreeReason === "uncommitted or untracked changes";
      target = { repositoryId, branch: selector, discardChanges: dirty };
      confirm.hidden = false;
      archiveConfirm.hidden = false;
      archiveConfirm.disabled = true;
      slot("snapshot-result").hidden = true;
      const openingTarget = target;
      api.previewWorktreeArchive(target).then((preview) => {
        if (target !== openingTarget) return;
        archiveConfirm.hidden = !preview?.eligible;
        archiveConfirm.disabled = false;
        if (!preview?.eligible) {
          slot("snapshot-result").hidden = false;
          slot("snapshot-result").textContent = `Archive unavailable: ${preview?.reason || "assessment unavailable"}`;
        }
      }).catch((error) => {
        if (target !== openingTarget) return;
        archiveConfirm.hidden = true;
        slot("snapshot-result").hidden = false;
        slot("snapshot-result").textContent = `Archive unavailable: ${error.message}`;
      });
      slot("dirty").hidden = !dirty;
      // The ref ends in the tip's short SHA (archiveRefName in worktree-removal.mjs).
      const archive = `refs/roborepo/abandoned/${selector}-${checkout.git?.shortHead || "<commit>"}`;
      const folder = checkout.projectRoot || "<folder>";
      const running = isRunning(checkout);
      fill(dialog, {
        lead: branch
          ? `This deletes the worktree's folder on this computer and its local branch, ${branch}.`
          : `This deletes the worktree's folder on this computer. It is not on a branch (detached at ${checkout.git?.shortHead || "an unknown commit"}).`,
        status: [removalStatus(checkout), checkout.worktreePreservation ? `Local preservation: ${checkout.worktreePreservation}.` : "", checkout.remainingPaths?.length ? `Remaining paths: ${checkout.remainingPaths.join(", ")}` : ""].filter(Boolean).join(" "),
        branch: branch || "none (detached)",
        folder,
        archive,
        restore: branch ? `git branch ${branch} ${archive}\ngit worktree add ${folder} ${branch}` : `git worktree add ${folder} ${archive}`,
      });
      slot("plan").hidden = !plan;
      slot("plan").textContent = plan ? `The active plan "${plan.title}" is still using this worktree. Deleting it can lose work the plan still needs, and the plan stays active without it. The plan's progress recorded in this worktree will no longer be shown in Plans.` : "";
      slot("running").hidden = !running;
      // Local edits, an active plan, or a running server need the destructive confirmation.
      confirm.dataset.btn = dirty || plan || running ? "danger" : "cta";
      dialog.querySelector(".worktree-remove-details").open = false;
      showError(dialog, null);
      dialog.showModal();
    },
  };
}

// What deleting would cost, in one sentence. Every removal archives the tip, so even unmerged work
// can be brought back; the sentence says so rather than leaving a commit count to interpret.
function removalStatus(checkout) {
  if (checkout.worktreeState === "landed") return `Its changes are already merged into ${checkout.mergedInto || "the main branch"}, so no committed work is lost.`;
  const count = checkout.unmergedCommits;
  if (count === 0) return "It has no commits that aren't already on the main branch, so no committed work is lost.";
  if (Number.isInteger(count)) {
    return count === 1
      ? "It has 1 commit that was never merged. A backup is kept so you can bring it back."
      : `It has ${count} commits that were never merged. A backup is kept so you can bring them back.`;
  }
  return "A backup of its latest commit is kept so you can bring it back.";
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
async function run(dialog, busyButton, busyLabel, action) {
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
    showError(dialog, error.message || String(error));
  } finally {
    // The action may have relabeled the button (the cleanup dialog's "Done"); keep that label.
    if (busyButton.firstChild === spinner) busyButton.replaceChildren(...label);
    busyButton.removeAttribute("aria-busy");
    for (const button of buttons) button.disabled = false;
  }
}

function showError(dialog, message) {
  const error = dialog.querySelector("[data-slot=error]");
  error.hidden = !message;
  error.textContent = message || "";
}
