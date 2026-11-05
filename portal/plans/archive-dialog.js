// Archiving an unprioritized plan from Prioritize asks twice: first for the reason the archived plan
// records, then for a final yes that says what will happen. A refusal keeps the dialog open with why.
const FINAL_ANSWER_DELAY_MS = 500;
import { portalWireBackdropClose } from "/portal/shared/api.js";

export function createArchiveDialog() {
  const dialog = document.getElementById("ordering-archive");
  const slot = (name) => dialog.querySelector(`[data-slot=${name}]`);
  const confirm = slot("confirm");
  const cancel = slot("cancel");
  const reason = slot("reason");
  let target = null;
  let step = "reason";
  let archiving = false;
  let answerTimer;

  const renderStep = () => {
    const { title, released, kept } = target;
    const naming = `"${title}"`;
    const finalStep = step === "final";
    slot("title").textContent = finalStep ? "Are you sure?" : `Archive ${naming}?`;
    slot("reason-field").hidden = finalStep;
    slot("consequence").hidden = !finalStep;
    slot("consequence").textContent = `This moves ${naming} to Archived and commits the move to the repo's base branch.`;
    slot("dependents").hidden = !finalStep || !(released.length || kept.length);
    slot("dependents").textContent = [
      released.length ? `No longer depending on it: ${released.join(", ")}.` : "",
      kept.length ? `Still naming it, because a worktree owns the copy: ${kept.join(", ")}.` : "",
    ].filter(Boolean).join(" ");
    confirm.dataset.btn = finalStep ? "danger" : "cta";
    confirm.textContent = finalStep ? "Archive Plan" : "Continue";
    confirm.disabled = !finalStep && !reason.value.trim();
  };

  reason.addEventListener("input", renderStep);
  cancel.addEventListener("click", () => dialog.close());
  portalWireBackdropClose(dialog, () => {
    if (!archiving) dialog.close();
  });
  // Esc is the same as Cancel, so it waits for an archive in flight too.
  dialog.addEventListener("cancel", (event) => {
    if (archiving) event.preventDefault();
  });
  confirm.addEventListener("click", async () => {
    if (step === "reason") {
      step = "final";
      renderStep();
      cancel.focus();
      // The final button can land under the cursor, and a double-click must not answer both questions.
      confirm.disabled = true;
      answerTimer = setTimeout(() => { confirm.disabled = false; }, FINAL_ANSWER_DELAY_MS);
      return;
    }
    archiving = true;
    confirm.disabled = true;
    cancel.disabled = true;
    slot("error").textContent = "";
    try {
      await target.onConfirm(reason.value.trim());
      dialog.close();
    } catch (err) {
      slot("error").textContent = err.message;
    } finally {
      archiving = false;
      confirm.disabled = false;
      cancel.disabled = false;
    }
  });

  return {
    // onConfirm(reason) returns a promise; a rejection is shown here and leaves the dialog open.
    open(next) {
      clearTimeout(answerTimer);
      target = next;
      step = "reason";
      reason.value = "";
      slot("error").textContent = "";
      renderStep();
      dialog.showModal();
      reason.focus();
    },
  };
}
