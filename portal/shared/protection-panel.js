// The branch protection panel for one repo, and the two server calls behind it. Home opens it from
// a repo card's menu; Plans opens it from its protection notice. One controller per page drives the
// single #protection-panel dialog (protection-panel-partial.html).
import { portalFillSlots as fill, portalGetJson, portalPostJson, portalTpl as tpl, portalWireBackdropClose } from "/portal/shared/api.js";

const protectionUrl = (repositoryId) => `/api/repositories/${encodeURIComponent(repositoryId)}/protection`;

export function loadProtection(repositoryId) {
  return portalGetJson(protectionUrl(repositoryId));
}

// `action` is "protect", "skip", or "unskip". Resolves to the state after the action, with
// `refusal` set when the action stopped early or wrote nothing.
export function applyProtection(repositoryId, action) {
  return portalPostJson(protectionUrl(repositoryId), { action });
}

// Branch protection is offered for any repo with a Git host; one on another host gets the manual
// steps. A repo with no remote has nothing to protect, and mock repos do not exist on GitHub.
export function supportsProtectionPanel(repository) {
  return String(repository?.repositoryId || "").startsWith("git:") && !repository.fixture;
}

const PROTECTED_STATES = new Set(["protected", "unmanaged"]);
const BUSY_LABELS = { protect: "Protecting…", skip: "Turning off…", unskip: "Turning on…" };

let sharedPanel = null;

// `onChange(repositoryId, report)` runs after every action the portal answered, with the state read
// afterwards, including actions that wrote nothing (a refusal or nothing to change).
export function createProtectionPanel({ onChange = () => {} } = {}) {
  sharedPanel ??= buildProtectionPanel();
  sharedPanel.subscribers.push(onChange);
  return sharedPanel.controller;
}

function buildProtectionPanel() {
  const subscribers = [];
  const dialog = document.getElementById("protection-panel");
  const slot = (name) => dialog.querySelector(`[data-slot="${name}"]`);
  const buttons = { protect: slot("protect"), skip: slot("skip"), unskip: slot("unskip") };
  const labels = Object.fromEntries(Object.entries(buttons).map(([action, button]) => [action, button.textContent]));
  let target = null;

  slot("close").addEventListener("click", () => dialog.close());
  portalWireBackdropClose(dialog, () => dialog.close());
  buttons.protect.addEventListener("click", () => run("protect"));
  buttons.unskip.addEventListener("click", () => run("unskip"));
  // Skipping is the one action that loosens protection, so it asks first.
  // The confirmation is an alertdialog, so focus moves into it and returns to Skip on cancel.
  buttons.skip.addEventListener("click", () => {
    slot("skip-confirm").hidden = false;
    slot("skip-cancel").focus();
  });
  slot("skip-cancel").addEventListener("click", () => {
    slot("skip-confirm").hidden = true;
    buttons.skip.focus();
  });
  slot("skip-accept").addEventListener("click", () => run("skip"));

  const isCurrent = (opening) => dialog.open && target === opening;

  async function run(action) {
    const opening = target;
    const button = buttons[action];
    slot("skip-confirm").hidden = true;
    showError(null);
    for (const each of Object.values(buttons)) each.disabled = true;
    button.textContent = BUSY_LABELS[action];
    try {
      const report = await applyProtection(opening.repositoryId, action);
      for (const subscriber of subscribers) subscriber(opening.repositoryId, report);
      if (!isCurrent(opening)) return;
      render(report);
      showError(report.refusal ? sentence(report.refusal) : null);
    } catch (error) {
      if (isCurrent(opening)) showError(error.message);
    } finally {
      button.textContent = labels[action];
      for (const each of Object.values(buttons)) each.disabled = false;
    }
  }

  function showError(message) {
    slot("error").hidden = !message;
    slot("error").textContent = message || "";
  }

  function showLoading(name) {
    fill(dialog, { repository: name, state: "checking", headline: "Reading this repo's rules from GitHub…" });
    slot("state").dataset.level = "";
    for (const section of ["reason", "policies-section", "conflicts", "hand-made-section", "manual-section", "admin-note", "skip-confirm"]) slot(section).hidden = true;
    for (const button of Object.values(buttons)) button.hidden = true;
    showError(null);
  }

  function render(report) {
    fill(dialog, { state: mergeSkipped(report) ? `${report.state}, merge rules skipped` : report.state, headline: report.headline });
    slot("state").dataset.level = PROTECTED_STATES.has(report.state) ? "ok" : "warn";
    slot("reason").hidden = !report.reason;
    slot("reason").textContent = report.reason || "";

    slot("policies-section").hidden = report.policies.length === 0;
    slot("policies").replaceChildren(...report.policies.map((policy) => fill(tpl("tpl-protection-item"), { name: `${policy.name} (${policy.branch}):`, detail: policy.detail })));
    slot("checks").textContent = requiredChecksText(report);
    slot("conflicts").hidden = report.conflicts.length === 0;
    slot("conflicts").replaceChildren(...report.conflicts.map((conflict) => fill(tpl("tpl-protection-line"), { text: conflict.detail })));
    slot("hand-made-section").hidden = report.handMade.length === 0;
    slot("hand-made").replaceChildren(...report.handMade.map((ruleset) => fill(tpl("tpl-protection-item"), { name: `${ruleset.name}:`, detail: ruleset.note })));
    slot("bypass-note").hidden = report.bypassVisible;
    slot("manual-section").hidden = !report.manualSteps;
    slot("manual-steps").replaceChildren(...(report.manualSteps || []).map((text) => fill(tpl("tpl-protection-line"), { text })));

    const canAct = !["unsupported", "unavailable", "conflicting"].includes(report.state);
    const repairable = ["unmanaged", "missing", "drifted"].includes(report.state);
    const adminNote = canAct && !report.admin ? nonAdminNote(report, repairable) : null;
    slot("admin-note").hidden = !adminNote;
    slot("admin-note").textContent = adminNote || "";
    buttons.protect.hidden = !(canAct && report.admin && repairable);
    buttons.skip.hidden = !(canAct && report.admin && !mergeSkipped(report));
    buttons.unskip.hidden = !(canAct && report.admin && mergeSkipped(report));
  }

  const controller = {
    // `repository` needs `repositoryId` and `displayName`. Pass `report` to show a state that was
    // just read instead of reading it again, and `error` to show why an action from elsewhere failed.
    async open(repository, { report = null, error: actionError = null } = {}) {
      const opening = { repositoryId: repository.repositoryId };
      target = opening;
      showLoading(repository.displayName || repository.repositoryId);
      if (!dialog.open) dialog.showModal();
      try {
        const current = report || await loadProtection(opening.repositoryId);
        if (!isCurrent(opening)) return;
        render(current);
        // A report from an action elsewhere (the Plans notice) carries `refusal` when it stopped early.
        const message = actionError || (current.refusal ? sentence(current.refusal) : null);
        if (message) showError(message);
      } catch (error) {
        if (!isCurrent(opening)) return;
        fill(dialog, { state: "unavailable", headline: "The status could not be loaded." });
        showError(error.message);
      }
    },
  };
  return { controller, subscribers };
}

// Matches the CLI's line for the same report (requiredChecksLine in scripts/cli/protect.mjs).
function requiredChecksText(report) {
  const names = report.requiredChecks.join(", ");
  if (report.checksSource === "kept") return `Required CI checks: ${names} (kept from roborepo-main-merge: no workflow has a successful pull-request run to read them from).`;
  if (report.requiredChecks.length > 0) return `Required CI checks: ${names}`;
  return "Required CI checks: none. No workflow has a successful pull-request run to read job names from, so merges are not held for CI.";
}

const mergeSkipped = (report) => report.policies.some((policy) => policy.status === "skipped");

function nonAdminNote(report, repairable) {
  const account = `Signed in to GitHub as ${report.login}, who is not an admin of this repo.`;
  if (repairable) return `${account} A repo admin must run: roborepo protect`;
  return `${account} A repo admin can turn the merge rules ${mergeSkipped(report) ? "back on with: roborepo protect --unskip main-merge" : "off with: roborepo protect --skip main-merge"}`;
}

const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
