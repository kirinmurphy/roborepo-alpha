// Hook readiness notices, shared by Settings, Tokens, and Home, and by the one-time review offer
// (hook-review-offer.js). A harness can hold a hook RoboRepo installed and still refuse to run it
// (Codex runs a hook only after the user trusts it), so installed is not the same as active.
//
// The read model is /api/config/hooks/<harness>/status; the server caches it because the Codex read
// starts a Codex process, and `fresh` asks it to skip that cache. Review itself happens in the
// harness: **Open** asks the server to open the harness's own review screen in a terminal, and the
// user picks which hooks to trust there. Nothing here sends or records a trust decision.

import { portalGetJson, portalPostJson, portalTpl as tpl, portalFillSlots as fill } from "./api.js";
import "./copy-button.js";

// Worst first, matching scripts/harnesses/hook-readiness.mjs. Review is listed apart: it gets its
// own notice whatever else is wrong, because it is the one state the user can fix from here.
const OTHER_STATES = ["missing", "inactive", "unknown"];

const COPY = {
  review_required: (name) => [`${name} hooks need review`, `${name} will not run these RoboRepo hooks until you trust them.`],
  inactive: (name) => [`${name} hooks are turned off`, `These RoboRepo hooks are installed but turned off in ${name}.`],
  missing: (name) => [`${name} hooks are missing`, `These RoboRepo hooks are missing from ${name}, so there is nothing to review yet.`],
  unknown: (name) => [`${name} hook status is unknown`, `RoboRepo could not ask ${name} whether its hooks will run. Check that ${name} is installed and has been opened at least once.`],
};

const LAUNCH_RESULT = {
  launched: (name) => `${name} opened in a terminal. Trust only the RoboRepo hooks listed here, then come back to this page.`,
  failed: () => "Could not open a terminal. Copy the command below and run it in a terminal instead.",
};

export function readHookStatus(harness, { fresh = false } = {}) {
  return portalGetJson(`/api/config/hooks/${encodeURIComponent(harness)}/status${fresh ? "?fresh=1" : ""}`);
}

// The notices one harness status needs: a review notice when any RoboRepo hook awaits review, and
// one more for the worst other problem, each with its own remedy. `handlers` wires the buttons:
// onCheck (Check again), onStatus (a launch reply carried a newer status), onLater (offer only).
export function hookReadinessNotices(status, handlers = {}) {
  if (!status || status.supported === false) return [];
  const name = status.displayName || status.harness;
  const groups = status.groups || [];
  const notices = [];
  const review = groups.filter((group) => group.state === "review_required");
  if (review.length) notices.push(reviewNotice(status, name, review, handlers));
  const other = OTHER_STATES.find((state) => groups.some((group) => group.state === state))
    ?? (groups.length === 0 && status.state === "unknown" ? "unknown" : null);
  if (other) notices.push(stateNotice(status, name, other, groups.filter((group) => group.state === other), handlers));
  return notices;
}

// Shown in place of the review notice once a fresh read finds nothing left to review.
export function hookReviewResolvedNotice(status, { onLater } = {}) {
  const name = status.displayName || status.harness;
  const node = fill(tpl("tpl-hook-readiness"), {
    title: `${name} hooks reviewed`,
    message: `Nothing RoboRepo installed is waiting for review. Newly trusted hooks run from your next ${name} session.`,
  });
  node.setAttribute("variant", "success");
  if (onLater) showLater(node, onLater, "Dismiss");
  return node;
}

function reviewNotice(status, name, groups, handlers) {
  const guidance = status.guidance || {};
  const [title, fallbackMessage] = COPY.review_required(name);
  const node = fill(tpl("tpl-hook-readiness"), { title, message: guidance.review_required || fallbackMessage });
  listAffected(node, groups, "review_required");
  if (guidance.reviewApp) reveal(node, "app-route").textContent = guidance.reviewApp;
  if (guidance.command) {
    reveal(node, "terminal-option");
    node.querySelector('[data-slot="terminal-hint"]').textContent = guidance.terminalHint || "Run this command in a terminal:";
    node.querySelector('[data-slot="command"]').textContent = guidance.command;
    reveal(node, "copy").copySource = guidance.command;
  }
  if (status.reviewLaunch?.supported) {
    const open = reveal(node, "open");
    open.textContent = `Open ${name} hook review`;
    open.addEventListener("click", () => launchReview(node, status, name, handlers));
  }
  wireCommonActions(node, handlers);
  return node;
}

function stateNotice(status, name, state, groups, handlers) {
  const guidance = status.guidance || {};
  const [title, fallbackMessage] = COPY[state](name);
  const message = state === "inactive" && guidance.inactive ? guidance.inactive : fallbackMessage;
  const node = fill(tpl("tpl-hook-readiness"), { title, message: `${message} ${missingRemedy(status, groups, state)}`.trim() });
  if (state !== "unknown") listAffected(node, groups, state);
  wireCommonActions(node, handlers);
  return node;
}

// A missing package hook comes back by reapplying its package; missing core hooks come back with
// the bundle that installs them.
function missingRemedy(status, groups, state) {
  if (state !== "missing") return "";
  const core = groups.some((group) => group.owner === "core");
  const packages = groups.some((group) => group.owner !== "core");
  const steps = [];
  if (packages) steps.push("Turn the package off and back on in Agents to reinstall it.");
  if (core && status.coreBundle) steps.push(`Run roborepo bundle apply ${status.coreBundle} to reinstall the core hooks.`);
  else if (core) steps.push("Run roborepo repair to reinstall the core hooks.");
  return steps.join(" ");
}

async function launchReview(node, status, name, handlers) {
  const open = node.querySelector('[data-slot="open"]');
  open.disabled = true;
  open.setAttribute("aria-busy", "true");
  let reply = null;
  try {
    reply = await portalPostJson(`/api/config/hooks/${encodeURIComponent(status.harness)}/review`, {});
  } catch {
    reply = { launched: false, reason: "launch_failed" };
  } finally {
    open.disabled = false;
    open.removeAttribute("aria-busy");
  }
  if (reply.launched) {
    awaitingReturn = true;
    showResult(node, LAUNCH_RESULT.launched(name));
    return;
  }
  // Review finished elsewhere, or the status moved on: render what the server just read.
  if (reply.reason === "no_review" && reply.status) return handlers.onStatus?.(reply.status);
  showResult(node, LAUNCH_RESULT.failed());
  node.querySelector('[data-slot="terminal-option"]').open = true;
}

function wireCommonActions(node, handlers) {
  reveal(node, "actions");
  const check = node.querySelector('[data-slot="check"]');
  if (handlers.onCheck) check.addEventListener("click", () => handlers.onCheck());
  else check.hidden = true;
  if (handlers.onLater) showLater(node, handlers.onLater);
}

function showLater(node, onLater, label = "Later") {
  const later = reveal(node, "later");
  later.textContent = label;
  later.addEventListener("click", () => onLater());
  reveal(node, "actions");
}

function listAffected(node, groups, state) {
  const list = node.querySelector('[data-slot="affected"]');
  list.replaceChildren(...groups.map((group) => {
    const item = document.createElement("li");
    const events = group.hooks.filter((hook) => hook.state === state).map((hook) => hook.event);
    item.textContent = `${group.label}: ${[...new Set(events)].join(", ")}`;
    return item;
  }));
  list.hidden = groups.length === 0;
}

function showResult(node, text) {
  reveal(node, "result").textContent = text;
}

function reveal(node, slot) {
  const element = node.querySelector(`[data-slot="${slot}"]`);
  element.hidden = false;
  return element;
}

// --- Persistent mounts -------------------------------------------------------------------------

// Latest render per mount, so a slow status read cannot overwrite a newer one; and which harnesses
// each mount last showed as awaiting review, so a later read can say the review is done.
const mounts = new Map();
let awaitingReturn = false;

// `setup` is the /api/settings read model. A failed read for one harness drops only that harness's
// notice: the warning is advisory, and each page has its own error surface.
export async function renderHookReadiness(mount, setup, { fresh = false } = {}) {
  const token = {};
  const previous = mounts.get(mount);
  mounts.set(mount, { setup, token, pending: previous?.pending ?? new Set() });
  const harnesses = setup?.harnesses?.active || [];
  const statuses = await Promise.all(harnesses.map((harness) => readHookStatus(harness.id, { fresh }).catch(() => null)));
  const entry = mounts.get(mount);
  if (entry?.token !== token) return;
  const rerender = () => renderHookReadiness(mount, setup, { fresh: true });
  const pending = new Set();
  const notices = statuses.filter(Boolean).flatMap((status) => {
    if (status.reviewRevision) pending.add(status.harness);
    else if (entry.pending.has(status.harness)) return [hookReviewResolvedNotice(status), ...hookReadinessNotices(status, { onCheck: rerender })];
    return hookReadinessNotices(status, { onCheck: rerender, onStatus: () => rerender() });
  });
  entry.pending = pending;
  mount.replaceChildren(...notices);
  mount.hidden = notices.length === 0;
}

// Re-read every mount on this page from the server's current results, e.g. after a hook change
// another component triggered.
export function refreshHookReadinessMounts({ fresh = false } = {}) {
  for (const [mount, entry] of mounts) {
    if (mount.isConnected) void renderHookReadiness(mount, entry.setup, { fresh });
  }
}

// Trust changes inside the harness, where RoboRepo cannot see it. When the user comes back to the
// portal while a review is pending (or after opening one), read fresh once.
const FOCUS_THROTTLE_MS = 2_000;
let lastFocusRefresh = 0;
function refreshOnReturn() {
  if (document.visibilityState !== "visible") return;
  const anyPending = awaitingReturn || [...mounts.values()].some((entry) => entry.pending.size > 0);
  if (!anyPending || Date.now() - lastFocusRefresh < FOCUS_THROTTLE_MS) return;
  lastFocusRefresh = Date.now();
  awaitingReturn = false;
  refreshHookReadinessMounts({ fresh: true });
  document.dispatchEvent(new CustomEvent("hook-readiness:return"));
}
document.addEventListener("visibilitychange", refreshOnReturn);
window.addEventListener("focus", refreshOnReturn);
