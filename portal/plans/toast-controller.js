// Singleton controller for #toast, the short "copied" notification. Auto-dismisses after a delay that pauses while the toast has hover or keyboard focus, and resets
// its timer/content cleanly between shows so a second notification never inherits stale state.

const AUTO_DISMISS_MS = 7000;

export function createOutcomeToast(toastEl) {
  const messageEl = toastEl.querySelector('[data-slot="message"]');
  const home = toastEl.parentElement;

  let dismissTimer = null;
  let remainingMs = AUTO_DISMISS_MS;
  let shownAt = 0;
  let paused = false;

  toastEl.addEventListener("mouseenter", pause);
  toastEl.addEventListener("mouseleave", resume);
  toastEl.addEventListener("focusin", pause);
  toastEl.addEventListener("focusout", resume);

  function pause() {
    if (paused || toastEl.hidden) return;
    paused = true;
    clearTimeout(dismissTimer);
    remainingMs -= Date.now() - shownAt;
  }

  function resume() {
    if (!paused || toastEl.hidden) return;
    paused = false;
    schedule(remainingMs);
  }

  function schedule(ms) {
    shownAt = Date.now();
    dismissTimer = setTimeout(dismiss, ms);
  }

  function show({ message }) {
    clearTimeout(dismissTimer);
    paused = false;
    // Modal dialogs paint above the document regardless of z-index. Keep the notification in
    // their top layer while open, then restore it so closing the dialog does not hide the toast.
    const modal = [...document.querySelectorAll("dialog:modal")].at(-1);
    const host = modal || home;
    if (toastEl.parentElement !== host) {
      host.append(toastEl);
      modal?.addEventListener("close", () => {
        if (toastEl.parentElement === modal) home.append(toastEl);
      }, { once: true });
    }
    messageEl.textContent = message;
    toastEl.hidden = false;
    remainingMs = AUTO_DISMISS_MS;
    schedule(AUTO_DISMISS_MS);
  }

  function dismiss() {
    clearTimeout(dismissTimer);
    toastEl.hidden = true;
  }

  return { show, dismiss };
}
