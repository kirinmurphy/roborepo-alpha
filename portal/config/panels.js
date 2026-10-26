// Wiring for the Config page's self-contained chrome panels: the source-inspect /
// snapshot-view <dialog>, and the post-enable recommendations <dialog>. app.js calls into this controller instead of owning the modal's DOM
// refs and listeners itself. This is a
// panel-factory (like createInfoModal in plans/panels.js), not a custom element: the modal is a
// page singleton referenced by id, never declaratively instantiated or cloned.

import { portalWireBackdropClose } from "/portal/shared/api.js";
import { renderMermaidBlocks } from "/portal/shared/markdown-mermaid.js";
import * as api from "./api.js";
import * as tmpl from "./templates.js";

export function createConfigModal() {
  const dialogEl = document.getElementById("config-modal");
  const titleEl = document.getElementById("modal-title");
  const pathEl = document.getElementById("modal-path");
  const costRowEl = document.getElementById("modal-cost-row");
  const contentEl = document.getElementById("modal-content");
  const footerEl = document.getElementById("modal-footer");
  const backEl = document.getElementById("modal-back");
  let onBack = null;
  // Bumped by every view change, so a source fetch that resolves after the user moved on (Back
  // pressed mid-load) does not overwrite the view now showing.
  let viewSeq = 0;

  document.getElementById("modal-close").addEventListener("click", close);
  portalWireBackdropClose(dialogEl, close);
  backEl.addEventListener("click", () => onBack?.());

  // Back shows only on a source view opened from a package's contents view, and re-renders that
  // view in this same dialog rather than stacking a second one.
  function setBack(handler) {
    onBack = handler || null;
    backEl.hidden = !onBack;
  }

  function setPaths(pathText) {
    const paths = Array.isArray(pathText)
      ? pathText
      : String(pathText || "").split(" + ");
    pathEl.replaceChildren(
      ...paths
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const row = document.createElement("span");
          row.textContent = p;
          return row;
        }),
    );
  }

  // `chips` is an array of { label, spec } — a dedicated row below the path, one labeled chip
  // per moment a cost applies ("Startup:", "When loaded:"), never mixed into the title line.
  function setHeader(title, pathText, chips = []) {
    titleEl.textContent = title || "";
    setPaths(pathText);
    costRowEl.replaceChildren(...chips.map((entry) => tmpl.labeledTokenChip(entry)));
    costRowEl.hidden = chips.length === 0;
  }

  function setContent(data) {
    if (data?.html) {
      contentEl.innerHTML = data.html;
      // Inspected sources are rendered markdown (skills, rules, guides), so any ```mermaid block
      // in them becomes a real diagram instead of raw source text.
      renderMermaidBlocks(contentEl);
    } else {
      contentEl.textContent = data?.content || "(empty)";
    }
  }

  function setFooter(node) {
    if (node) {
      footerEl.replaceChildren(node);
      footerEl.hidden = false;
    } else {
      footerEl.replaceChildren();
      footerEl.hidden = true;
    }
  }

  function open() {
    if (!dialogEl.open) dialogEl.showModal();
  }

  function close() {
    dialogEl.close();
  }

  // fetch-then-show: the source-inspect entry point (inspect-click, config-files grid click).
  async function openSource(inspect, { rules, harnesses, onDefaultClick, chips = [], back = null }) {
    const seq = ++viewSeq;
    setBack(back);
    setHeader(inspect.label || inspect.id, "loading…");
    contentEl.innerHTML = "";
    setFooter(null);
    open();
    try {
      const data = await api.fetchSource(inspect);
      if (seq !== viewSeq) return;
      if (!data.ok) {
        setHeader(inspect.label || inspect.id, "");
        contentEl.textContent = "error: " + (data.error || "failed to load");
        return;
      }
      setHeader(data.title || inspect.label, data.paths || data.path || "", chips);
      setContent(data);
      if (inspect.kind === "live-rules") {
        setFooter(tmpl.modalDefaults(rules, harnesses, onDefaultClick));
      }
    } catch (e) {
      if (seq !== viewSeq) return;
      setHeader(inspect.label || inspect.id, "");
      contentEl.textContent = "error: " + e.message;
    }
  }

  // The contents view of a package with several skills. Everything it lists is already in the
  // snapshot, so nothing is fetched; selecting an entry calls `onSelect(entry)`, which opens that
  // entry's source view with a Back that calls showContents again.
  function showContents(inspect, { chips = [], entryChipSpec, onSelect }) {
    viewSeq += 1;
    setBack(null);
    setHeader(inspect.label || inspect.id, "", chips);
    contentEl.replaceChildren(tmpl.packageContents(inspect, { entryChipSpec, onSelect }));
    setFooter(null);
    open();
  }

  // show-already-known-data: the defaults-menu entry point (globals baseline/per-harness/packages).
  function openSnapshot(title, pathText, data) {
    viewSeq += 1;
    setBack(null);
    setHeader(title, pathText);
    setContent(data);
    setFooter(null);
    open();
  }

  return { openSource, openSnapshot, showContents };
}

// The recommendations dialog: after an enable that left some recommended packages off, ask which
// to enable too. Resolves to the chosen ids, or [] when the user continues without them (closing
// the dialog counts as that). Never enables anything itself; app.js does, with the user's choice.
export function createRecommendationsDialog() {
  const dialogEl = document.getElementById("recommendations-modal");
  const titleEl = document.getElementById("recommendations-title");
  const listEl = document.getElementById("recommendations-list");
  let settle = null;

  function finish(ids) {
    const resolve = settle;
    settle = null;
    if (dialogEl.open) dialogEl.close();
    resolve?.(ids);
  }

  document.getElementById("recommendations-close").addEventListener("click", () => finish([]));
  document.getElementById("recommendations-skip").addEventListener("click", () => finish([]));
  document.getElementById("recommendations-enable").addEventListener("click", () => {
    finish([...listEl.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value));
  });
  dialogEl.addEventListener("cancel", () => finish([]));
  portalWireBackdropClose(dialogEl, () => finish([]));

  function ask(packageLabel, recommendations) {
    finish([]);
    titleEl.textContent = `${packageLabel} is on`;
    listEl.replaceChildren(...recommendations.map((rec) => tmpl.recommendationOption(rec)));
    dialogEl.showModal();
    return new Promise((resolve) => { settle = resolve; });
  }

  return { ask };
}
