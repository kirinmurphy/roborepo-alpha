// Shared harness setup banner — the SAME banner Agents (/agents), Tokens (/tokens), and Home render
// about installing and setting up a harness. Single source of truth for the message text and the
// rendered <portal-notice> element; pages must not re-implement either. Running the check and
// remembering its outcome live in harness-setup-flow.js.
//
// Relies on tpl-harness-notice from the shared widget-templates partial (injected into every page
// via {{WIDGET_TEMPLATES}}), so it works on any portal page without page-local markup.

import { activePresentedHarnesses } from "./harness-cohort.js";
import { portalTpl as tpl } from "./api.js";
import { finishSetupOnce, readRecentOutcome, runSetupCheck, watchWhileVisible } from "./harness-setup-flow.js";

const CHECK_LABEL = "Check for harnesses";
const GENERIC_BODY = "Install a supported harness to add agent tools and enable token tracking.";

// What the banner says, from the setup snapshot and the last check's outcome. Null when nothing
// needs saying. States:
//   setting-up  a harness is installed and launched; the page finishes setup without a click
//   failed      that setup ran and did not complete
//   done        setup just completed
//   waiting     a specific harness needs one user action (launch it, open its Code tab)
//   generic     no supported harness is installed
export function harnessWarningSpec(snap, outcome = null) {
  const guidance = snap?.harnesses?.guidance ?? snap?.machineHarnessGuidance ?? [];
  const ready = guidance.filter((entry) => entry.ready);
  if (ready.length) {
    const names = listNames(ready.map((entry) => entry.displayName));
    const failed = outcome?.failed && (!outcome.failed.ids.length || ready.some((entry) => outcome.failed.ids.includes(entry.id)));
    if (failed) {
      return spec("failed", "warning", `RoboRepo couldn't finish setting up ${names}. Run roborepo update in a terminal to see why.`,
        { action: "Try again", detail: firstLine(outcome.failed.error) });
    }
    return spec("setting-up", "info", `Setting up ${names}…`, { readyIds: ready.map((entry) => entry.id) });
  }
  if (activePresentedHarnesses(normalizeSetupSnapshot(snap)).length > 0) {
    return outcome?.setUp?.length ? spec("done", "success", `${listNames(outcome.setUp)} ${outcome.setUp.length > 1 ? "are" : "is"} set up.`) : null;
  }
  const entry = guidance.find((item) => item.warnings?.length);
  if (entry) {
    return spec("waiting", "warning", finishesOnItsOwn(entry.warnings[0]), {
      action: "Check now",
      noChangeNote: entry.confidence === "probable" ? `${entry.displayName} hasn't been launched yet.` : `${entry.displayName} isn't installed yet.`,
    });
  }
  return spec("generic", "warning", GENERIC_BODY, { harnessSpecific: false, action: CHECK_LABEL, noChangeNote: "No supported harness was found." });
}

// Home's version: an info notice, since Home works without a harness. Null when nothing to say.
export function harnessSetupPromptElement(snap, { onRefreshed } = {}) {
  return buildNotice(snap, { quiet: true, onRefreshed, watch: true });
}

// Agents and Tokens. Pages that already re-read setup state on a poll pass watch: false.
export function harnessWarningElement(snap, { onRefreshed, watch = true } = {}) {
  return buildNotice(snap, { quiet: false, onRefreshed, watch });
}

function buildNotice(snap, options) {
  const outcome = readRecentOutcome();
  const current = harnessWarningSpec(snap, outcome);
  if (!current) return null;
  const panel = tpl("tpl-harness-notice");
  const quietStep = options.quiet && (current.state === "waiting" || current.state === "generic");
  panel.setAttribute("variant", quietStep ? "info" : current.variant);
  if (current.state === "setting-up" || quietStep) panel.setAttribute("icon", "info");
  if (current.state === "done") panel.setAttribute("icon", "check");
  setLinkedHarnessCopy(panel, current.body, current.state === "setting-up");
  setSupportedHarnesses(panel, snap, current);
  setResult(panel, current, outcome);

  const rebuild = async () => {
    await options.onRefreshed?.();
    // A page whose snapshot did not change keeps this banner instead of rebuilding it.
    if (panel.isConnected) panel.replaceWith(buildNotice(snap, options) ?? document.createComment("harness setup"));
  };
  const run = () => runSetupCheck({ step: current.body, onRefreshed: rebuild });
  setAction(panel, current, run, options.quiet);
  if (current.state === "setting-up") finishSetupOnce(current.readyIds, run);
  if (options.watch && current.state === "waiting") {
    watchWhileVisible(panel, current.body, harnessWarningSpec, rebuild);
  }
  return panel;
}

function spec(state, variant, body, extra = {}) {
  return { state, variant, title: "", body, harnessSpecific: true, action: null, ...extra };
}

// CLI guidance names a terminal command; in the portal setup finishes on its own.
function finishesOnItsOwn(step) {
  return step.replace(/, then run roborepo (harness refresh|update)\.$/, ". RoboRepo will finish setting it up.");
}

function setAction(panel, current, run, quiet) {
  const button = panel.querySelector("[data-slot=check]");
  if (!current.action) {
    button.closest(".portal-banner-action").remove();
    return;
  }
  button.textContent = current.action;
  button.setAttribute("data-btn", current.state === "generic" && !quiet ? "cta" : "secondary");
  button.addEventListener("click", () => runHarnessCheck(button, run));
}

function setResult(panel, current, outcome) {
  const result = panel.querySelector("[data-slot=result]");
  const text = current.detail
    || (outcome?.noChange && outcome.step === current.body ? current.noChangeNote : null);
  if (!text) return;
  result.textContent = text;
  result.hidden = false;
}

function setLinkedHarnessCopy(panel, body, busy) {
  const copy = panel.querySelector("[data-slot=copy]");
  const links = [
    { label: "agent tools", href: "/agents" },
    { label: "token tracking", href: "/tokens" },
  ];
  const fragment = document.createDocumentFragment();
  if (busy) fragment.append(spinner());
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

function setSupportedHarnesses(panel, snap, current) {
  const supported = panel.querySelector("[data-slot=supported]");
  const names = (normalizeSetupSnapshot(snap)?.harnesses || []).map((harness) => harness.displayName);
  if (!names.length || current.harnessSpecific) {
    supported.remove();
    return;
  }
  supported.querySelector("[data-slot=names]").textContent = names.join(", ");
}

// Shared by the Settings page's own Check for harnesses button.
export async function runHarnessCheck(button, action) {
  const label = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.replaceChildren(spinner(), document.createTextNode(" Checking…"));
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await action();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = label;
  }
}

function spinner() {
  const element = document.createElement("span");
  element.className = "harness-check-spinner";
  element.setAttribute("aria-hidden", "true");
  return element;
}

function listNames(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

function firstLine(text = "") {
  const line = String(text).split("\n").find((item) => item.trim()) || "";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

function normalizeSetupSnapshot(snap) {
  if (!Array.isArray(snap?.harnesses?.active)) return snap;
  return {
    harnesses: snap.harnesses.supported || [],
    machineHarnesses: snap.harnesses.active,
  };
}
