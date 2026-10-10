// The plan detail drawer — the one popup a plan title opens, on Plans and on Home. Its markup,
// templates, and stylesheet come from plan-drawer-partial.html ({{PLAN_DRAWER}}); this controller
// owns filling and opening it, so the two pages cannot drift.
//
// The page supplies what only it knows: the plan list blockers resolve against, the plan-write
// package state, and how to surface copies/errors. Lifecycle and priority edits are the page's
// call too — on Plans the drawer's <plan-status> dispatches `plan-change` into the page's mutation
// orchestrator; a page without one passes `readonly` and the status renders as plain chips.

import { portalCopyText, portalWireBackdropClose } from "/portal/shared/api.js";
import { createSkillDetailModal } from "/portal/shared/skill-detail-modal.js";
import { renderMermaidBlocks } from "/portal/shared/markdown-mermaid.js";
import * as api from "./api.js";
import * as tmpl from "./templates.js";
import { createOutcomeToast } from "./toast-controller.js";
import { repositoryContext, resolveBlockers, resolveBlocking } from "./state.js";
import "./elements/index.js";

// deps: { getPlans, getPlanWritePackage, onEnablePackage, onError, readonly }
export function createPlanDrawer(deps) {
  const dialog = document.getElementById("drawer");
  const statusMount = document.getElementById("drawer-status-mount");
  const skillModal = createSkillDetailModal(document.getElementById("skill-modal"));
  const toast = createOutcomeToast(document.getElementById("toast"));
  let openKey = null;
  // Bumped by every open() and every close, so a fetch that resolves after the user closed the
  // drawer or picked another plan is dropped instead of reopening it or replacing the newer plan.
  let openRequest = 0;

  document.getElementById("drawer-close").addEventListener("click", () => dialog.close());
  portalWireBackdropClose(dialog, () => dialog.close());
  // Fires however the dialog closes (button, backdrop, Escape, or a programmatic close()) — one
  // place to clear which plan the drawer was showing.
  dialog.addEventListener("close", () => { openKey = null; openRequest += 1; });

  async function copyText(text) {
    await portalCopyText(text, () => toast.show({ message: "copied" }));
  }

  // A command prompt says which command it carries and where it goes, since the portal never runs
  // the command itself; a context-only prompt (no command) keeps the plain confirmation.
  async function copyPrompt(command, keys, mode = "repository-aware") {
    const text = await api.generatePrompt(command, keys, mode);
    const message = command ? `Copied the /${command} prompt. Paste it into an agent chat in this repository.` : "copied";
    await portalCopyText(text, () => toast.show({ message }));
  }

  async function open(key) {
    const request = ++openRequest;
    try {
      const doc = await api.fetchPlanDocument(key);
      if (request === openRequest) render(doc);
    } catch (err) {
      if (request === openRequest) deps.onError(err);
    }
  }

  function render(doc) {
    openKey = doc.plan.key;
    const content = tmpl.drawerContent(doc, {
      onCopyPath: copyText,
      onCopyRepoContext: (record) => copyText(repositoryContext(record)),
      onCopyPortableContext: (key) => copyPrompt(null, [key], "portable"),
      onPlanAction: (key, command) => copyPrompt(command, [key], "repository-aware"),
      onEnablePackage: deps.onEnablePackage,
      planWritePackage: deps.getPlanWritePackage(),
      skillModal,
      onError: deps.onError,
    });
    document.getElementById("drawer-title").textContent = content.title;
    document.getElementById("drawer-path").textContent = content.path;
    document.getElementById("drawer-path-copy").copySource = () => doc.plan.plan.relativePath;
    const docEl = document.getElementById("drawer-doc");
    docEl.innerHTML = content.html;
    // Plan bodies routinely carry architecture diagrams; render them rather than showing the source.
    renderMermaidBlocks(docEl);
    document.getElementById("drawer-meta").replaceChildren(...content.meta);
    document.getElementById("drawer-warnings").replaceChildren(...content.warnings.map(tmpl.listItem));
    document.getElementById("drawer-warnings-section").hidden = content.warnings.length === 0;
    document.getElementById("drawer-tasks").replaceChildren(...tmpl.drawerTaskItems(content.tasks));
    renderBlockers(doc.plan);
    const statusEl = document.createElement("plan-status");
    if (deps.readonly) statusEl.setAttribute("readonly", "");
    statusEl.record = doc.plan;
    statusMount.replaceChildren(statusEl);
    // Recommended-next CTA (hidden when there's no clear recommendation) + the unified ⋯ menu.
    const ctaEl = document.getElementById("drawer-cta");
    if (content.cta) {
      ctaEl.textContent = content.cta.label;
      ctaEl.hidden = false;
      ctaEl.onclick = () => copyPrompt(content.cta.command, [doc.plan.key], "repository-aware");
    } else {
      ctaEl.hidden = true;
      ctaEl.onclick = null;
    }
    document.getElementById("drawer-menu").panelContent = content.menu;
    if (!dialog.open) dialog.showModal();
  }

  // Blocked by (this plan's own blocked_by, resolved) and Blocking (other plans that list this one)
  // render as two independent warning-styled sections above the drawer's main content — each hidden
  // when empty. Every resolved entry re-opens this drawer on the target plan; unresolved blocked_by
  // ids render as plain text (see resolveBlockers).
  function renderBlockers(record) {
    const plans = deps.getPlans();
    const blockedBy = resolveBlockers(record, plans);
    const blocking = resolveBlocking(record, plans);
    document.getElementById("drawer-blocked-by-section").hidden = blockedBy.length === 0;
    document.getElementById("drawer-blocked-by-links").replaceChildren(...blockedBy.map((b) => tmpl.blockerLink(b, open)));
    document.getElementById("drawer-blocking-section").hidden = blocking.length === 0;
    document.getElementById("drawer-blocking-links").replaceChildren(...blocking.map((b) => tmpl.blockerLink(b, open)));
  }

  return {
    open,
    render,
    copyText,
    copyPrompt,
    toast,
    skillModal,
    close: () => dialog.close(),
    get isOpen() { return dialog.open; },
    get openKey() { return openKey; },
    // The drawer's mounted <plan-status>, for a page re-setting its record after a mutation.
    get statusElement() { return statusMount.querySelector("plan-status"); },
    statusMount,
  };
}
