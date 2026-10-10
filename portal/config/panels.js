// Wiring for the Config page's single self-contained chrome panel: the source-inspect /
// snapshot-view <dialog>. app.js calls into this controller instead of owning the modal's DOM
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

  document.getElementById("modal-close").addEventListener("click", close);
  portalWireBackdropClose(dialogEl, close);

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
  async function openSource(inspect, { rules, harnesses, onDefaultClick, chips = [] }) {
    setHeader(inspect.label || inspect.id, "loading…");
    contentEl.innerHTML = "";
    setFooter(null);
    open();
    try {
      const data = await api.fetchSource(inspect);
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
      setHeader(inspect.label || inspect.id, "");
      contentEl.textContent = "error: " + e.message;
    }
  }

  // show-already-known-data: the defaults-menu entry point (globals baseline/per-harness/packages).
  function openSnapshot(title, pathText, data) {
    setHeader(title, pathText);
    setContent(data);
    setFooter(null);
    open();
  }

  return { openSource, openSnapshot };
}
