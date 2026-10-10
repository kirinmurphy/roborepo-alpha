// Panel-factory for a "view docs" popup that renders a server-side Markdown guide in place —
// same idiom as skill-detail-modal.js's createSkillDetailModal (a page-singleton <dialog>, wired
// once, opened/closed via showModal()/close()). The content comes from a caller-supplied fetch
// function so this stays reusable across pages instead of hardcoding one API route; the Telemetry
// page passes fetchTelemetryGuide (GET /api/telemetry/guide -> server-rendered
// docs/user/guides/telemetry.md), so the popup and the on-disk guide are always the same content, never
// a second copy that can drift.
//
// Deep-linking: open(anchorId) scrolls the freshly-rendered content to the heading whose slug id
// matches anchorId once it exists in the DOM (renderMarkdown() in scripts/cli/markdown-render.mjs
// gives every heading a stable GitHub-style slug id) — info icons throughout the host page pass
// their section's anchor so "view docs" from any panel lands on the relevant section, not the top.
//
// Triggers: any element with data-doc-anchor opens the guide at that anchor, through one delegated
// listener the factory owns. The trigger reports aria-expanded while the guide is open, and a
// trigger inside another open dialog closes that dialog first, since the guide replaces it.
import { portalWireBackdropClose } from "./api.js";
// Diagram rendering now lives in portal/shared/markdown-mermaid.js so /config and /plans get it too
// — it was private to this modal, which is why only the Telemetry guide rendered diagrams.
import { renderMermaidBlocks } from "./markdown-mermaid.js";

export function createDocGuideModal(dialogEl, fetchGuide) {
  const titleEl = dialogEl.querySelector('[data-slot="title"]');
  const pathEl = dialogEl.querySelector('[data-slot="path"]');
  const contentEl = dialogEl.querySelector('[data-slot="content"]');

  dialogEl.querySelector('[data-slot="close"]').addEventListener("click", close);
  portalWireBackdropClose(dialogEl, close);
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-doc-anchor]");
    if (!trigger) return;
    const host = trigger.closest("dialog");
    if (host && host !== dialogEl && host.open) host.close();
    trigger.setAttribute("aria-expanded", "true");
    open(trigger.dataset.docAnchor);
  });
  dialogEl.addEventListener("close", () => {
    for (const trigger of document.querySelectorAll("[data-doc-anchor][aria-expanded='true']")) {
      trigger.setAttribute("aria-expanded", "false");
    }
  });

  let cachedHtml = null;

  async function open(anchorId = null) {
    dialogEl.showModal();
    if (cachedHtml == null) {
      titleEl.textContent = "loading…";
      pathEl.textContent = "";
      contentEl.innerHTML = "";
      try {
        const data = await fetchGuide();
        if (!data.ok) {
          titleEl.textContent = "docs unavailable";
          contentEl.textContent = "error: " + (data.error || "failed to load");
          return;
        }
        titleEl.textContent = data.title || "Guide";
        pathEl.textContent = data.path || "";
        cachedHtml = data.html || "";
      } catch (err) {
        titleEl.textContent = "docs unavailable";
        contentEl.textContent = "error: " + err.message;
        return;
      }
    }
    // cachedHtml always holds the ORIGINAL fetched markup (unrendered <pre class="mermaid">
    // blocks) — reassigning it here on every open, including reopens, is what makes this
    // idempotent to re-run renderMermaidBlocks against each time, rather than trying to skip it
    // and risk leaving a reopened guide's diagrams unrendered.
    contentEl.innerHTML = cachedHtml;
    scrollToAnchor(anchorId);
    renderMermaidBlocks(contentEl);
  }

  function scrollToAnchor(anchorId) {
    if (!anchorId) {
      contentEl.scrollTop = 0;
      return;
    }
    const target = contentEl.querySelector(`#${CSS.escape(anchorId)}`);
    if (target) target.scrollIntoView({ block: "start" });
    else contentEl.scrollTop = 0;
  }

  function close() {
    dialogEl.close();
  }

  return { open, close };
}
