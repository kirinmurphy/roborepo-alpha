// Archiving unprioritized plans from Prioritize asks twice: first for the reason the archived plan
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
    const { titles, dependents } = target;
    const naming = titles.length === 1 ? `"${titles[0]}"` : `these ${titles.length} linked plans`;
    const finalStep = step === "final";
    slot("title").textContent = finalStep ? "Are you sure?" : `Archive ${naming}?`;
    slot("plans").hidden = titles.length === 1;
    slot("plans").replaceChildren(...titles.map((title) => Object.assign(document.createElement("li"), { textContent: title })));
    slot("reason-field").hidden = finalStep;
    slot("consequence").hidden = !finalStep;
    slot("consequence").textContent = `This moves ${naming} to Archived and commits the move to the repo's base branch.`;
    slot("dependents").hidden = !finalStep || !dependents.length;
    slot("dependents").textContent = `Still waiting on ${titles.length === 1 ? "it" : "them"}: ${dependents.join(", ")}.`;
    confirm.dataset.btn = finalStep ? "danger" : "cta";
    confirm.textContent = finalStep ? (titles.length === 1 ? "Archive Plan" : `Archive ${titles.length} Plans`) : "Continue";
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
