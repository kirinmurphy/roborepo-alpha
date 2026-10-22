// The one-time hook review offer: after an operation that rewrote hooks (a package change, a bulk
// change, turning telemetry on), read readiness fresh for the harnesses it touched and, if any
// RoboRepo hook now awaits review, show one nonmodal card with the review action and **Later**.
//
// The card appears at most once per review set: the server's `reviewRevision` names exactly which
// RoboRepo hooks are pending, so rereads, other pages, and reloads do not offer the same set again.
// A changed definition or a shifted trust key is a new set and is offered once more. **Later** only
// closes the card; the persistent notice on Home, Settings, and Tokens stays until review is done.

import {
  hasHookReadinessMount, hookReadinessNotices, hookReviewResolvedNotice, onHookReviewReturn, pendingReviewKeys, readHookStatus, refreshHookReadinessMounts, reviewConfirmed,
} from "./hook-readiness.js";

const OFFERED_KEY = "roborepo.hook-review-offers";
const OFFERED_LIMIT = 50;
const offeredInMemory = new Set();
const activeOffers = new Map();

// `harnessIds` is the `hookHarnesses` list a mutation response carries.
export async function offerHookReview(harnessIds) {
  if (!Array.isArray(harnessIds) || harnessIds.length === 0) return;
  const statuses = await Promise.all(harnessIds.map((id) => readHookStatus(id, { fresh: true }).catch(() => null)));
  // The fresh reads replaced the server's cached results; pages showing a notice pick them up.
  refreshHookReadinessMounts();
  for (const status of statuses) {
    if (!status?.reviewRevision) continue;
    const key = `${status.harness}:${status.reviewRevision}`;
    if (wasOffered(key)) continue;
    markOffered(key);
    if (!hasHookReadinessMount(status.harness)) showOffer(status);
  }
}

function showOffer(status) {
  activeOffers.get(status.harness)?.();
  const container = offersContainer();
  const card = document.createElement("div");
  card.dataset.harness = status.harness;
  let stopWatching = () => {};
  const close = () => {
    stopWatching();
    activeOffers.delete(status.harness);
    card.remove();
    container.hidden = container.childElementCount === 0;
  };
  // The hooks this card offered; "reviewed" needs a read confirming each one is now active.
  let offered = pendingReviewKeys(status);
  const render = (next) => {
    const handlers = {
      onCheck: () => readHookStatus(next.harness, { fresh: true }).then(render).catch(() => {}),
      onStatus: render,
      onLater: close,
    };
    if (next.reviewRevision) {
      offered = new Set([...offered, ...pendingReviewKeys(next)]);
      card.replaceChildren(hookReadinessNotices(next, handlers)[0]);
      return;
    }
    if (reviewConfirmed(offered, next)) {
      stopWatching();
      card.replaceChildren(hookReviewResolvedNotice(next, { onLater: close }));
      return;
    }
    // Nothing awaits review, but the read did not confirm it (unknown, or the hooks went missing):
    // show that state instead of claiming success.
    const notices = hookReadinessNotices(next, handlers);
    if (notices.length === 0) return close();
    card.replaceChildren(notices[0]);
  };
  render(status);
  // Back from the terminal: show what is left, or that review is done.
  stopWatching = onHookReviewReturn(() => {
    if (!card.isConnected) return close();
    readHookStatus(status.harness, { fresh: true }).then(render).catch(() => {});
  });
  activeOffers.set(status.harness, close);
  container.append(card);
  container.hidden = false;
}

function offersContainer() {
  let container = document.querySelector(".hook-review-offers");
  if (!container) {
    container = document.createElement("section");
    container.className = "hook-review-offers inner";
    container.setAttribute("aria-label", "Hook review");
    container.hidden = true;
    const main = document.querySelector("main");
    main.before(container);
  }
  return container;
}

// Per-viewer memory of which review sets were already offered. Storage can be unavailable (private
// windows, blocked site data); then the offer is remembered for this page load only.
function wasOffered(key) {
  return offeredInMemory.has(key) || readOffered().includes(key);
}

function markOffered(key) {
  offeredInMemory.add(key);
  try {
    const next = [...readOffered().filter((entry) => entry !== key), key].slice(-OFFERED_LIMIT);
    localStorage.setItem(OFFERED_KEY, JSON.stringify(next));
  } catch {}
}

function readOffered() {
  try {
    const value = JSON.parse(localStorage.getItem(OFFERED_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
