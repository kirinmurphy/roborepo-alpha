// Runs the portal's harness check and remembers its outcome so the rebuilt banner can report it.
// Pages rebuild the banner after a check (Home and Tokens by refetching, Agents on its next
// snapshot), so the outcome lives in sessionStorage for a short window rather than on the element.
//
// Setup finishes on its own: when the banner shows a harness that is installed and launched but
// not set up, the page runs the check once without a click. While a banner is waiting on the user
// (launch the app, open its Code tab), the page re-reads setup state every few seconds and stops
// as soon as that banner leaves the page. Nothing polls when no harness banner is showing.

import { portalPostJson } from "./api.js";
import { fetchSetupState } from "./setup-api.js";

const OUTCOME_KEY = "roborepo.harnessCheck.outcome";
const OUTCOME_MAX_AGE_MS = 60_000;
const WATCH_INTERVAL_MS = 10_000;
const autoFinished = new Set();
let running = null;

export function checkForHarnesses() {
  return portalPostJson("/api/config/harnesses/refresh", {});
}

// One check at a time per page: a click during an automatic run joins it.
export function runSetupCheck({ step, onRefreshed }) {
  running ??= (async () => {
    try {
      recordOutcome(step, await checkForHarnesses());
    } catch (error) {
      recordOutcome(step, { applied: { ok: false, error: String(error?.message || error) } });
    }
    await onRefreshed?.();
  })().finally(() => { running = null; });
  return running;
}

// A failure stays until the next check replaces it: the page does not retry on its own, so letting
// it expire would leave a "Setting up…" banner with nothing running behind it.
export function readRecentOutcome() {
  try {
    const outcome = JSON.parse(sessionStorage.getItem(OUTCOME_KEY));
    return outcome && (outcome.failed || Date.now() - outcome.at <= OUTCOME_MAX_AGE_MS) ? outcome : null;
  } catch {
    return null;
  }
}

// Starts setup once per harness per page view. A failure is shown, not retried, until the user
// selects Try again or reloads.
export function finishSetupOnce(ids, run) {
  const fresh = ids.filter((id) => !autoFinished.has(id));
  if (!fresh.length) return;
  for (const id of fresh) autoFinished.add(id);
  queueMicrotask(run);
}

// Re-reads setup state while `panel` is on the page and calls `onChange` once the banner it would
// render differs from `body`.
export function watchWhileVisible(panel, body, specFor, onChange) {
  const timer = setInterval(async () => {
    if (!panel.isConnected) return clearInterval(timer);
    let next;
    try {
      next = specFor(await fetchSetupState(), readRecentOutcome());
    } catch {
      return;
    }
    if (next?.body !== body) {
      clearInterval(timer);
      await onChange();
    }
  }, WATCH_INTERVAL_MS);
}

function recordOutcome(step, response) {
  const enabled = response?.newlyEnabled ?? [];
  const failed = response?.applied && !response.applied.ok;
  const outcome = {
    at: Date.now(),
    step,
    setUp: failed ? [] : enabled.map((harness) => harness.displayName),
    failed: failed ? { ids: enabled.map((harness) => harness.id), error: response.applied.error } : null,
    noChange: !enabled.length && !failed,
  };
  try { sessionStorage.setItem(OUTCOME_KEY, JSON.stringify(outcome)); } catch { /* storage unavailable */ }
}
