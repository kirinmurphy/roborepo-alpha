// Shared "install a supported harness" warning banner — the SAME banner the Agents (/config) page
// and the Tokens (/tokens) page render when no active harness is installed on this machine. Single
// source of truth for both the message text and the rendered <portal-notice> element; pages must
// not re-implement either.
//
// Relies on tpl-harness-notice from the shared widget-templates partial (injected into every page
// via {{WIDGET_TEMPLATES}}), so it works on any portal page without page-local markup.

import { activePresentedHarnesses } from "./harness-cohort.js";
import { portalPostJson, portalTpl as tpl } from "./api.js";

const CHECK_LABEL = "Check for harnesses";

// Message spec, for consumers that want the parts (e.g. a terminal printer). Null when the machine
// has at least one active harness — no banner in that case.
export function harnessWarningSpec(snap) {
  const normalized = normalizeSetupSnapshot(snap);
  if (activePresentedHarnesses(normalized).length > 0) return null;
  return {
    variant: "warning",
    title: "",
    body: "Install a supported harness to add agent tools and enable token tracking.",
  };
}

// Home's version uses the same copy and action with an info notice style. Null when no banner is
// warranted.
export function harnessSetupPromptElement(snap) {
  return createHarnessNotice(snap, "info");
}

// Ready-to-insert element for portal pages. Null when no banner is warranted.
export function harnessWarningElement(snap, { onCheck = checkForHarnesses } = {}) {
  const spec = harnessWarningSpec(snap);
  if (!spec) return null;
  const panel = tpl("tpl-harness-notice");
  panel.setAttribute("variant", spec.variant);
  panel.setAttribute("icon", "warning");
  setLinkedHarnessCopy(panel, spec.body);
  setSupportedHarnesses(panel, snap);
  const check = panel.querySelector("[data-slot=check]");
  check.setAttribute("data-btn", "cta");
  check.addEventListener("click", async () => {
    await runHarnessCheck(check, onCheck);
  });
  return panel;
}

function createHarnessNotice(snap, variant) {
  const spec = harnessWarningSpec(snap);
  if (!spec) return null;
  const panel = tpl("tpl-harness-notice");
  panel.setAttribute("variant", variant);
  if (variant === "info") {
    panel.setAttribute("icon", "info");
    panel.querySelector("[data-slot=check]").setAttribute("data-btn", "secondary");
  }
  setLinkedHarnessCopy(panel, spec.body);
  setSupportedHarnesses(panel, snap);
  wireCheck(panel.querySelector("[data-slot=check]"));
  return panel;
}

function setLinkedHarnessCopy(panel, body) {
  const copy = panel.querySelector("[data-slot=copy]");
  const links = [
    { label: "agent tools", href: "/config" },
    { label: "token tracking", href: "/tokens" },
  ];
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const { label, href } of links) {
    const index = body.indexOf(label, cursor);
    if (index < 0) continue;
    fragment.append(document.createTextNode(body.slice(cursor, index)));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.textContent = label;
    fragment.append(anchor);
    cursor = index + label.length;
  }
  fragment.append(document.createTextNode(body.slice(cursor)));
  copy.replaceChildren(fragment);
}

function setSupportedHarnesses(panel, snap) {
  const supported = panel.querySelector("[data-slot=supported]");
  const names = (normalizeSetupSnapshot(snap)?.harnesses || []).map((harness) => harness.displayName);
  if (!names.length) {
    supported.remove();
    return;
  }
  supported.querySelector("[data-slot=names]").textContent = names.join(", ");
}

export function checkForHarnesses() {
  return portalPostJson("/api/config/harnesses/refresh", {});
}

export async function runHarnessCheck(button, action) {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const spinner = document.createElement("span");
  spinner.className = "harness-check-spinner";
  spinner.setAttribute("aria-hidden", "true");
  button.replaceChildren(spinner, document.createTextNode(" Checking…"));
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await action();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = CHECK_LABEL;
  }
}

function wireCheck(button) {
  button?.addEventListener("click", async () => {
    await runHarnessCheck(button, async () => {
      await checkForHarnesses();
      window.location.reload();
    });
  });
}

function normalizeSetupSnapshot(snap) {
  if (!Array.isArray(snap?.harnesses?.active)) return snap;
  return {
    harnesses: snap.harnesses.supported || [],
    machineHarnesses: snap.harnesses.active,
  };
}
