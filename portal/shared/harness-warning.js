// Shared "install a supported harness" warning banner — the SAME banner the Agents (/config) page
// and the Tokens (/tokens) page render when no active harness is installed on this machine. Single
// source of truth for both the message text and the rendered <portal-notice> element; pages must
// not re-implement either.
//
// Relies on tpl-harness-warning from the shared widget-templates partial (injected into every page
// via {{WIDGET_TEMPLATES}}), so it works on any portal page without page-local markup.

import { activePresentedHarnesses, supportedHarnessNames } from "./harness-cohort.js";
import { portalPostJson, portalTpl as tpl } from "./api.js";

// Message spec, for consumers that want the parts (e.g. a terminal printer). Null when the machine
// has at least one active harness — no banner in that case.
export function harnessWarningSpec(snap) {
  const normalized = normalizeSetupSnapshot(snap);
  if (activePresentedHarnesses(normalized).length > 0) return null;
  const supported = supportedHarnessNames(normalized);
  const supportedList = supported ? ` (${supported})` : "";
  return {
    variant: "warning",
    title: "",
    body: `Install a supported harness${supportedList}, then check for installs to get started.`,
  };
}

// Home's version of the same condition. Home does not depend on a harness, so it is not a warning
// there: it is an info prompt that says what installing one unlocks, linking those pages, with the
// supported harness list on its own smaller line. Null when no banner is warranted.
export function harnessSetupPromptElement(snap) {
  const normalized = normalizeSetupSnapshot(snap);
  if (activePresentedHarnesses(normalized).length > 0) return null;
  const panel = tpl("tpl-harness-setup-prompt");
  const names = (normalized?.harnesses || []).map((harness) => harness.displayName);
  const supported = panel.querySelector("[data-slot=supported]");
  if (names.length) supported.querySelector("[data-slot=names]").textContent = names.join(", ");
  else supported.remove();
  wireCheck(panel.querySelector("[data-slot=check]"));
  return panel;
}

// Ready-to-insert element for portal pages. Null when no banner is warranted.
export function harnessWarningElement(snap, { onCheck = checkForHarnesses } = {}) {
  const spec = harnessWarningSpec(snap);
  if (!spec) return null;
  const panel = tpl("tpl-harness-warning");
  panel.setAttribute("variant", spec.variant);
  panel.querySelector("[data-slot=title]").textContent = spec.title;
  panel.querySelector("[data-slot=body]").innerHTML = spec.body;
  const check = panel.querySelector("[data-slot=check]");
  check.addEventListener("click", async () => {
    check.disabled = true;
    try {
      await onCheck();
    } finally {
      check.disabled = false;
    }
  });
  return panel;
}

export function checkForHarnesses() {
  return portalPostJson("/api/config/harnesses/refresh", {});
}

function wireCheck(button) {
  button?.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await checkForHarnesses();
      window.location.reload();
    } finally {
      button.disabled = false;
    }
  });
}

function normalizeSetupSnapshot(snap) {
  if (!Array.isArray(snap?.harnesses?.active)) return snap;
  return {
    harnesses: snap.harnesses.supported || [],
    machineHarnesses: snap.harnesses.detected || [],
  };
}
