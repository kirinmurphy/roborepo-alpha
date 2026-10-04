// Wiring for the two self-contained chrome panels on the Plans page: the discovery-roots
// ("Project Folders") settings panel and the info modal. Each exposes a small controller so
// app.js can call into it without owning DOM refs or listeners for these panels itself.

import { portalWireBackdropClose } from "/portal/shared/api.js";
import * as api from "./api.js";
import * as tmpl from "./templates.js";

// Once discovery roots exist, the empty-state `.settings` block (label + form) is physically
// relocated into the control bar's roots-panel mount point and driven by the "update" toggle
// instead. Moving the same nodes (rather than duplicating the form) keeps one source of truth.
export function createRootsPanel({ onSnapshot, onError, onExpand }) {
  const rootsEl = document.getElementById("roots");
  const settingsEl = document.getElementById("settings");
  const settingsLabelEl = document.getElementById("settings-label");
  const rootsToggleEl = document.getElementById("roots-toggle");
  const rootFormLabelEmptyEl = document.getElementById("root-form-label-empty");
  const rootFormLabelPopulatedEl = document.getElementById("root-form-label-populated");
  const rootSubmitEl = document.getElementById("root-submit");
  const settingsBodyEl = document.getElementById("settings-body");
  const rootsDoneEl = document.getElementById("roots-done");
  const rootsPanelMountEl = document.getElementById("roots-panel-mount");
  const rootFormErrEl = document.getElementById("root-form-err");

  let currentRoots = [];
  let wasEmpty = true;

  document.getElementById("root-form").addEventListener("submit", onSubmit);
  rootsToggleEl.addEventListener("click", () => setExpanded(rootsPanelMountEl.hidden));
  rootsDoneEl.addEventListener("click", () => setExpanded(false));

  async function onSubmit(event) {
    event.preventDefault();
    rootFormErrEl.textContent = "";
    const input = document.getElementById("root-input");
    rootSubmitEl.disabled = true;
    rootSubmitEl.replaceChildren("Adding…", tmpl.spinner());
    try {
      const snap = await api.saveDiscoveryRoots([...currentRoots, input.value]);
      input.value = "";
      onSnapshot(snap);
      if (currentRoots.length) setExpanded(true); // stay open across multiple adds in one sitting
    } catch (err) {
      rootFormErrEl.textContent = err.message;
    } finally {
      rootSubmitEl.disabled = false;
      rootSubmitEl.textContent = "Add Folder";
    }
  }

  async function remove(root) {
    await api
      .saveDiscoveryRoots(currentRoots.filter((item) => item !== root))
      .then(onSnapshot)
      .catch(onError);
  }

  function setExpanded(expanded) {
    rootsPanelMountEl.hidden = !expanded;
    if (expanded) onExpand?.();
  }

  // Single-visible-step onboarding: while the plan-write package is disabled the banner is the one
  // setup prompt (the empty-state settings block stays hidden), so a new user sees one call to
  // action at a time — enable the skill first, then add Project Folders.
  function render(roots, planWriteEnabled) {
    currentRoots = roots;
    if (!roots.length) {
      // True-empty state: the form stays hidden behind the banner while plan-write is disabled.
      settingsEl.hidden = !planWriteEnabled;
      if (!settingsEl.hidden) settingsEl.append(settingsBodyEl);
      settingsLabelEl.textContent = "Add your first Project Folder";
      rootFormLabelEmptyEl.hidden = false;
      rootFormLabelPopulatedEl.hidden = true;
      rootsDoneEl.hidden = true;
      rootsPanelMountEl.hidden = true;
      rootsEl.replaceChildren();
      wasEmpty = true;
      return;
    }
    // Populated state: form moves into the control bar's roots-panel mount, gated behind the
    // "update" toggle (row 1's "N Repos" replaces the old settings-label). The moment we cross
    // from empty to populated, collapse it by default.
    settingsEl.hidden = true;
    rootsPanelMountEl.append(settingsBodyEl);
    rootFormLabelEmptyEl.hidden = true;
    rootFormLabelPopulatedEl.hidden = false;
    rootsDoneEl.hidden = false;
    if (wasEmpty) setExpanded(false);
    wasEmpty = false;
    rootsEl.replaceChildren(...roots.map((root) => tmpl.rootChip(root, remove)));
  }

  return { render, setExpanded };
}

export function createInfoModal() {
  const infoIconEl = document.getElementById("info-icon");
  const infoModalEl = document.getElementById("info-modal");

  infoIconEl.addEventListener("click", () => setOpen(true));
  document.getElementById("info-modal-close").addEventListener("click", () => setOpen(false));
  portalWireBackdropClose(infoModalEl, () => setOpen(false));
  infoModalEl.addEventListener("close", () => infoIconEl.setAttribute("aria-expanded", "false"));

  function setOpen(open) {
    if (open) infoModalEl.showModal();
    else infoModalEl.close();
    infoIconEl.setAttribute("aria-expanded", String(open));
  }
}
