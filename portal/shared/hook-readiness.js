// Hook readiness notice, shared by Settings, Tokens, and Home: one warning per active harness whose
// RoboRepo hooks will not all run. A harness can hold a hook RoboRepo installed and still refuse to
// run it (Codex runs a hook only after the user trusts it), so installed is not the same as active.
// The read model is /api/config/hooks/<harness>/status; the server caches it because the Codex read
// starts a Codex process.

import { portalGetJson, portalTpl as tpl, portalFillSlots as fill } from "./api.js";

// Worst first, matching scripts/harnesses/hook-readiness.mjs.
const STATES = ["missing", "review_required", "inactive", "unknown"];

const COPY = {
  review_required: (name) => [`${name} hooks need review`, `${name} will not run these RoboRepo hooks until you trust them.`],
  inactive: (name) => [`${name} hooks are turned off`, `These RoboRepo hooks are installed but turned off in ${name}.`],
  missing: (name) => [`${name} hooks are missing`, `These RoboRepo hooks are missing from ${name}. Turn the package off and back on in Agents to reinstall them.`],
  unknown: (name) => [`${name} hook status is unknown`, `RoboRepo could not ask ${name} whether its hooks will run. Check that ${name} is installed and has been opened at least once.`],
};

// Missing core hooks are left out until installing them stops colliding with package hooks: the
// notice's only remedy, reapplying a package, does not reinstall them.
function noticeGroups(status) {
  return (status?.groups || []).filter((group) => !(group.owner === "core" && group.state === "missing"));
}

export function hookReadinessNotice(status) {
  const groups = noticeGroups(status);
  const state = status?.supported === false ? null
    : groups.length ? STATES.find((candidate) => groups.some((group) => group.state === candidate))
    : status?.state === "unknown" ? "unknown" : null;
  if (!state) return null;
  const name = status.displayName || status.harness;
  const [title, fallbackMessage] = COPY[state](name);
  const guidance = status.guidance || {};
  const node = fill(tpl("tpl-hook-readiness"), { title, message: guidance[state] || fallbackMessage });
  const terminalOption = node.querySelector('[data-slot="terminal-option"]');
  if (guidance[state] && guidance.command) {
    node.querySelector('[data-slot="terminal-hint"]').textContent = guidance.terminalHint || "Run this command to review the hooks:";
    node.querySelector('[data-slot="command"]').textContent = guidance.command;
    terminalOption.hidden = false;
  }
  const affected = groups.filter((group) => group.state === state);
  const list = node.querySelector('[data-slot="affected"]');
  list.replaceChildren(...affected.map((group) => {
    const item = document.createElement("li");
    const events = group.hooks.filter((hook) => hook.state === state).map((hook) => hook.event);
    item.textContent = `${group.label}: ${[...new Set(events)].join(", ")}`;
    return item;
  }));
  list.hidden = affected.length === 0 || state === "unknown";
  return node;
}

// Latest render per mount, so a slow status read cannot overwrite a newer one.
const renders = new WeakMap();

// `setup` is the /api/settings read model. A failed read for one harness drops only that harness's
// notice: the warning is advisory, and each page has its own error surface.
export async function renderHookReadiness(mount, setup) {
  const token = {};
  renders.set(mount, token);
  const harnesses = setup?.harnesses?.active || [];
  const statuses = await Promise.all(harnesses.map((harness) =>
    portalGetJson(`/api/config/hooks/${encodeURIComponent(harness.id)}/status`).catch(() => null)));
  if (renders.get(mount) !== token) return;
  const notices = statuses.map(hookReadinessNotice).filter(Boolean);
  mount.replaceChildren(...notices);
  mount.hidden = notices.length === 0;
}
