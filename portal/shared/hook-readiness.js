// Hook readiness notices, shared by Settings, Tokens, and Home, and by the one-time review offer
// (hook-review-offer.js). A harness can hold a hook RoboRepo installed and still refuse to run it
// (Codex runs a hook only after the user trusts it), so installed is not the same as active.
//
// The read model is /api/config/hooks/<harness>/status; the server caches it because the Codex read
// starts a Codex process, and `fresh` asks it to skip that cache. Review itself happens in the
// harness: **Open** asks the server to open the harness's own review screen in a terminal, and the
// user picks which hooks to trust there. Nothing here sends or records a trust decision.

import { portalGetJson, portalPostJson, portalTpl as tpl, portalFillSlots as fill } from "./api.js";
import { formatHookReferences } from "./hook-readiness-copy.js";
import "./copy-button.js";
import "./tooltip.js";

// Worst first, matching scripts/harnesses/hook-readiness.mjs. Review is listed apart: it gets its
// own notice whatever else is wrong, because it is the one state the user can fix from here.
const OTHER_STATES = ["missing", "inactive", "unknown"];

const COPY = {
  review_required: (name) => [`${name} hooks need review`, `${name} will not run these RoboRepo hooks until you trust them.`],
  inactive: (name) => [`${name} hooks are turned off`, `These RoboRepo hooks are installed but turned off in ${name}.`],
  missing: (name) => [`${name} hooks are missing`, `These RoboRepo hooks are missing from ${name}.`],
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
//
// Notices are built from each hook's own state, not its group's: a group reports its worst hook,
// so one package with a missing hook and an untrusted one is a `missing` group whose untrusted hook
// still needs review.
export function hookReadinessNotices(status, handlers = {}) {
  if (!status || status.supported === false) return [];
  const name = status.displayName || status.harness;
  const groups = status.groups || [];
  const notices = [];
  const review = groupsWithHookState(groups, "review_required");
  if (review.length) notices.push(reviewNotice(status, name, review, handlers));
  const other = OTHER_STATES.find((state) => groupsWithHookState(groups, state).length > 0)
    ?? (groups.length === 0 && status.state === "unknown" ? "unknown" : null);
  if (other) notices.push(stateNotice(status, name, other, groupsWithHookState(groups, other), handlers));
  for (const notice of notices) formatHookReferences(notice);
  return notices;
}

// The RoboRepo hooks this status shows awaiting review, as stable keys.
export function pendingReviewKeys(status) {
  return new Set((status?.groups || []).flatMap((group) => group.hooks
    .filter((hook) => hook.state === "review_required")
    .map((hook) => hookKey(group, hook))));
}

// Review is done only when a successful read finds every hook that was pending now active. A read
// that failed (unknown), or a hook that went missing instead of being trusted, is not a review.
export function reviewConfirmed(previousKeys, status) {
  if (!previousKeys?.size || !status || status.reviewRevision) return false;
  const now = new Map((status.groups || []).flatMap((group) => group.hooks.map((hook) => [hookKey(group, hook), hook.state])));
  return [...previousKeys].every((key) => now.get(key) === "active");
}

// Whether this read could not see some hooks, so an earlier pending set should be kept for later.
export function readinessIncomplete(status) {
  return !status || status.state === "unknown" || groupsWithHookState(status.groups || [], "unknown").length > 0;
}

function groupsWithHookState(groups, state) {
  return groups.filter((group) => group.hooks.some((hook) => hook.state === state));
}

function hookKey(group, hook) {
  return `${group.owner}\t${hook.event}\t${hook.command}`;
}

// Shown in place of the review notice once a fresh read confirms nothing is left to review.
export function hookReviewResolvedNotice(status, { onLater } = {}) {
  const name = status.displayName || status.harness;
  const node = fill(tpl("tpl-hook-readiness"), {
    title: `${name} hooks reviewed`,
    message: status.harness === "codex"
      ? "These updates will be applied to your next ChatGPT/Codex session."
      : `Nothing RoboRepo installed is waiting for review. Newly trusted hooks run from your next ${name} session.`,
  });
  node.setAttribute("variant", "success");
  if (onLater) showLater(node, onLater, "Dismiss");
  return node;
}

function reviewNotice(status, name, groups, handlers) {
  const guidance = status.guidance || {};
  const coreSetup = status.coreBundle && guidance.missingCore
    && groups.some((group) => group.owner === "core")
    && !groupsWithHookState(status.groups || [], "missing").some((group) => group.owner === "core");
  const [title, fallbackMessage] = COPY.review_required(name);
  const node = fill(tpl("tpl-hook-readiness"), { title, message: guidance.review_required || fallbackMessage });
  const hasPackages = groups.some((group) => group.owner !== "core");
  if (hasPackages && guidance.packageReview) {
    const hasCore = groups.some((group) => group.owner === "core");
    const copy = guidance.packageReview;
    const setup = {
      ...copy,
      purpose: hookPurposes(groups, "review_required"),
      steps: ["Hooks awaiting review installed.", copy.steps[1], approvalInstruction(status, groups), copy.steps.at(-1)],
      cliSetup: ["Hooks awaiting review installed.", copy.cliSetup[1], approvalInstruction(status, groups), copy.cliSetup.at(-1)],
    };
    fill(node, { message: hasCore ? copy.mixedMessage : copy.message });
    renderHookSetup(node, setup, { installed: true });
    if (guidance.preferredInterface !== "desktop" && guidance.command) {
      const command = reveal(node, "command");
      command.textContent = guidance.command;
      node.querySelector(".hook-readiness-copy").append(command);
      reveal(node, "copy").copySource = guidance.command;
      if (status.reviewLaunch?.supported) {
        const open = reveal(node, "open");
        open.textContent = guidance.reviewButtonLabel || `Open ${name} hook review`;
        open.addEventListener("click", () => launchReview(node, status, name, handlers));
      }
    }
    wireCommonActions(node, handlers);
    return node;
  }
  if (coreSetup) {
    fill(node, { title: guidance.missingCore.title, message: "" });
    const copy = guidance.missingCore;
    const steps = [...copy.steps];
    const cliSetup = [...copy.cliSetup];
    steps[2] = cliSetup[2] = approvalInstruction(status, groups);
    renderHookSetup(node, { ...copy, steps, cliSetup, purpose: hookPurposes(groups, "review_required") }, { installed: true });
    wireCommonActions(node, handlers);
    return node;
  } else listAffected(node, groups, "review_required");
  if (!coreSetup && guidance.reviewApp) reveal(node, "app-route").textContent = guidance.reviewApp;
  if (guidance.command) {
    reveal(node, "terminal-option");
    node.querySelector('[data-slot="terminal-hint"]').textContent = guidance.terminalHint || "Run this command in a terminal:";
    node.querySelector('[data-slot="command"]').textContent = guidance.command;
    reveal(node, "copy").copySource = guidance.command;
  }
  if (status.reviewLaunch?.supported) {
    const open = reveal(node, "open");
    open.textContent = guidance.reviewButtonLabel || `Open ${name} hook review`;
    open.addEventListener("click", () => launchReview(node, status, name, handlers));
  }
  if (guidance.preferredInterface === "desktop" && guidance.command) {
    node.querySelector('[data-slot="terminal-option"] summary').textContent = guidance.terminalOptionLabel || "Terminal command";
    reveal(node, "terminal-actions").append(
      node.querySelector('[data-slot="open"]'), node.querySelector('[data-slot="copy"]'),
    );
  }
  wireCommonActions(node, handlers);
  return node;
}

function stateNotice(status, name, state, groups, handlers) {
  const guidance = status.guidance || {};
  const coreCopy = state === "missing" && status.coreBundle && groups.some((group) => group.owner === "core")
    ? guidance.missingCore : null;
  const [fallbackTitle, fallbackMessage] = COPY[state](name);
  const title = coreCopy?.title || fallbackTitle;
  const message = state === "inactive" && guidance.inactive ? guidance.inactive : fallbackMessage;
  const affected = coreCopy ? groups.filter((group) => group.owner !== "core") : groups;
  const node = fill(tpl("tpl-hook-readiness"), { title, message: `${coreCopy ? coreCopy.message : message} ${missingRemedy(status, coreCopy ? affected : groups, state)}`.trim() });
  if (state !== "unknown") listAffected(node, affected, state);
  if (coreCopy) {
    renderHookSetup(node, { ...coreCopy, purpose: hookPurposes(groups.filter((group) => group.owner === "core"), "missing") });
  }

  if (state === "missing" && status.coreBundle && groups.some((group) => group.owner === "core")) {
    const button = reveal(node, "install");
    if (coreCopy?.installLabel) button.textContent = coreCopy.installLabel;
    button.addEventListener("click", () => installCoreHooks(node, status, handlers));
  }
  wireCommonActions(node, handlers);
  return node;
}

function hookPurposes(groups, state) {
  return groups.flatMap((group) => group.hooks.filter((hook) => hook.state === state).map((hook) => ({
    name: `RoboRepo: ${group.label} ${hook.event}`,
    description: hook.description || "This hook has no recorded description. Check its definition before approving it.",
  })));
}

function approvalInstruction(status, groups) {
  const owners = groups.map((group) => {
    const hooks = group.hooks.filter((hook) => hook.state === "review_required");
    const owner = group.owner === "core" ? `${status.displayName || status.harness} core` : `${group.label} package`;
    return `${hooks.length} ${owner} ${hooks.length === 1 ? "hook" : "hooks"}`;
  });
  return `Approve ${owners.join("; ")}.`;
}

function renderHookSetup(node, copy, { installed = false } = {}) {
  fill(node, {
    "step-install-text": copy.steps[0],
    "step-approve-text": copy.steps[1],
    "step-session": copy.steps.at(-1),
  });
  reveal(node, "steps");
  if (copy.steps.length > 3) {
    reveal(node, "step-trust");
    fill(node, { "step-trust-text": copy.steps[2] });
  }
  if (installed) {
    node.querySelector('[data-slot="step-install-text"]').classList.add("hook-step-completed");
    reveal(node, "install-complete");
  }
  if (copy.purpose) {
    const purpose = reveal(node, "purpose");
    fill(purpose, { "purpose-label": copy.purposeLabel });
    const items = purpose.querySelector("template").content.querySelector('[data-slot="purpose-items"]');
    items.replaceChildren(...copy.purpose.map((hook) => fill(tpl("tpl-hook-purpose-item"), hook)));
    if (installed && copy.steps.length > 3) {
      const details = reveal(node, "hook-details");
      const detailItems = details.querySelector("template").content.querySelector('[data-slot="purpose-items"]');
      detailItems.replaceChildren(items.cloneNode(true));
    }
  }
  if (copy.cliSetup) {
    const cliSetup = reveal(node, "cli-setup");
    fill(cliSetup, { "cli-setup-label": copy.cliSetupLabel });
    const items = cliSetup.querySelector("template").content.querySelector('[data-slot="cli-setup-items"]');
    items.replaceChildren(...copy.cliSetup.map((description, index) => {
      const step = fill(tpl("tpl-hook-setup-step"), { description });
      if (installed && index === 0) {
        step.querySelector('[data-slot="description"]').classList.add("hook-step-completed");
        const complete = step.querySelector('[data-slot="complete"]');
        complete.textContent = "✓";
        complete.hidden = false;
      }
      return step;
    }));
  }
  node.querySelector('[data-slot="message"]').hidden = !node.querySelector('[data-slot="message"]').textContent;
}

// A missing package hook comes back by reapplying its package; missing core hooks come back with
// the bundle that installs them.
function missingRemedy(status, groups, state) {
  if (state !== "missing") return "";
  const core = groups.some((group) => group.owner === "core");
  const packages = groups.some((group) => group.owner !== "core");
  const steps = [];
  if (packages) steps.push("Turn the package off and back on in Agents to reinstall it.");
  if (core && status.coreBundle) {
    if (status.guidance?.review_required) steps.push(`Install these hooks first, then review them in ${status.displayName || status.harness}.`);
    steps.push(`Install core hooks here, or run roborepo bundle apply ${status.coreBundle}. The bundle installs core hooks for all available harnesses.`);
  }
  else if (core) steps.push("Run roborepo repair to reinstall the core hooks.");
  return steps.join(" ");
}

async function installCoreHooks(node, status, handlers) {
  const button = node.querySelector('[data-slot="install"]');
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const reply = await portalPostJson(`/api/config/hooks/${encodeURIComponent(status.harness)}/install`, {});
    refreshHookReadinessMounts();
    handlers.onStatus?.(reply.status);
  } catch (error) {
    showResult(node, `Could not install core hooks. ${error.message}`);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
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
  const actions = reveal(node, "actions");
  const check = node.querySelector('[data-slot="check"]');
  const hasPrimaryAction = ["install", "open"].some((slot) => !node.querySelector(`[data-slot="${slot}"]`).hidden);
  if (handlers.onCheck && !hasPrimaryAction) check.addEventListener("click", () => handlers.onCheck());
  else check.hidden = true;
  if (handlers.onLater) showLater(node, handlers.onLater);
  actions.hidden = [...actions.children].every((child) => child.hidden);
}

function showLater(node, onLater, label = "Later") {
  const later = reveal(node, "later");
  later.textContent = label;
  later.addEventListener("click", () => onLater());
  reveal(node, "actions");
}

function listAffected(node, groups, state, { counts = false } = {}) {
  const list = node.querySelector('[data-slot="affected"]');
  list.replaceChildren(...groups.map((group) => {
    const item = document.createElement("li");
    const events = group.hooks.filter((hook) => hook.state === state).map((hook) => hook.event);
    const eventNames = [...new Set(events)].join(", ");
    item.textContent = counts
      ? `${group.label}${group.owner === "core" ? "" : " (package)"}: ${events.length} ${events.length === 1 ? "hook" : "hooks"} — ${eventNames}`
      : `${group.label}: ${eventNames}`;
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
const returnListeners = new Set();
let awaitingReturn = false;

// Offers also appear on pages without persistent mounts. Keep their return refresh subscribed
// until review is resolved or the card is dismissed, including review done outside the launcher.
export function onHookReviewReturn(listener) {
  returnListeners.add(listener);
  return () => returnListeners.delete(listener);
}

// `setup` is the /api/settings read model. A failed read for one harness drops only that harness's
// notice: the warning is advisory, and each page has its own error surface.
export async function renderHookReadiness(mount, setup, { fresh = false } = {}) {
  const token = {};
  const previous = mounts.get(mount);
  mounts.set(mount, { setup, token, pending: previous?.pending ?? new Map(), needsRefresh: previous?.needsRefresh ?? false });
  const harnesses = setup?.harnesses?.active || [];
  const statuses = await Promise.all(harnesses.map((harness) => readHookStatus(harness.id, { fresh }).catch(() => null)));
  const entry = mounts.get(mount);
  if (entry?.token !== token) return;
  const rerender = () => renderHookReadiness(mount, setup, { fresh: true });
  // harness -> keys of the RoboRepo hooks last shown awaiting review on this mount.
  const pending = new Map();
  const notices = statuses.filter(Boolean).flatMap((status) => {
    const before = entry.pending.get(status.harness);
    const now = pendingReviewKeys(status);
    // Kept as a union, so "reviewed" also needs the hooks trusted between reads to stay active.
    if (now.size) pending.set(status.harness, new Set([...(before ?? []), ...now]));
    else if (before && readinessIncomplete(status)) pending.set(status.harness, before);
    const handlers = { onCheck: rerender, onStatus: () => rerender() };
    if (reviewConfirmed(before, status)) return [hookReviewResolvedNotice(status), ...hookReadinessNotices(status, handlers)];
    return hookReadinessNotices(status, handlers);
  });
  entry.pending = pending;
  entry.needsRefresh = statuses.some((status) => !status || (status.supported !== false && status.state !== "active"));
  mount.replaceChildren(...notices);
  mount.hidden = notices.length === 0;
}

// Re-read every mount on this page from the server's current results, e.g. after a hook change
// another component triggered.
export function hasHookReadinessMount(harness) {
  return [...mounts.entries()].some(([mount, entry]) => mount.isConnected
    && entry.setup?.harnesses?.active?.some((item) => item.id === harness));
}

export function refreshHookReadinessMounts({ fresh = false } = {}) {
  for (const [mount, entry] of mounts) {
    if (mount.isConnected) void renderHookReadiness(mount, entry.setup, { fresh });
  }
}

// Trust changes inside the harness, where RoboRepo cannot see it. When the user comes back to the
// portal while hooks need attention (or after opening review), read fresh once. This also picks up
// installation done in a separate terminal without making the user press a second action button.
const FOCUS_THROTTLE_MS = 2_000;
let lastFocusRefresh = 0;
function refreshOnReturn() {
  if (document.visibilityState !== "visible") return;
  const anyPending = awaitingReturn || returnListeners.size > 0
    || [...mounts.entries()].some(([mount, entry]) => mount.isConnected && (entry.pending.size > 0 || entry.needsRefresh));
  if (!anyPending || Date.now() - lastFocusRefresh < FOCUS_THROTTLE_MS) return;
  lastFocusRefresh = Date.now();
  awaitingReturn = false;
  refreshHookReadinessMounts({ fresh: true });
  for (const listener of returnListeners) listener();
}
document.addEventListener("visibilitychange", refreshOnReturn);
window.addEventListener("focus", refreshOnReturn);
