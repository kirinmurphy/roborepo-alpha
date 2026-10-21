// Panel-factory for a "view docs" popup that renders a server-side Markdown guide in place —
// same idiom as skill-detail-modal.js's createSkillDetailModal (a page-singleton <dialog>, wired
// once, opened/closed via showModal()/close()). The content comes from a caller-supplied fetch
// function so this stays reusable across pages instead of hardcoding one API route; the Telemetry
// page passes fetchTelemetryGuide (GET /api/telemetry/guide -> server-rendered
// docs/user/guides/telemetry.md), so the popup and the on-disk guide are always the same content, never
// a second copy that can drift.
//
// Section scoping: open(anchorId) shows only the guide section under the heading whose slug id
// matches anchorId (renderMarkdown() in scripts/cli/markdown-render.mjs gives every heading a stable
// GitHub-style slug id), titled with that heading. Info icons pass their page section's anchor, so
// each popup explains the one thing next to it instead of the whole guide. open() with no anchor,
// or an anchor the guide lacks, shows the full guide.
import { portalWireBackdropClose } from "./api.js";
// Diagram rendering now lives in portal/shared/markdown-mermaid.js so /agents and /plans get it too
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
    trigger.setAttribute("aria-expanded", "true");
    open(trigger.dataset.docAnchor);
  });
  dialogEl.addEventListener("close", () => {
    for (const trigger of document.querySelectorAll("[data-doc-anchor][aria-expanded='true']")) {
      trigger.setAttribute("aria-expanded", "false");
    }
  });

  let guide = null;

  async function open(anchorId = null) {
    dialogEl.showModal();
    if (guide == null) {
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
        guide = { title: data.title || "Guide", path: data.path || "", html: data.html || "" };
      } catch (err) {
        titleEl.textContent = "docs unavailable";
        contentEl.textContent = "error: " + err.message;
        return;
      }
    }
    // guide.html always holds the ORIGINAL fetched markup (unrendered <pre class="mermaid">
    // blocks) — re-parsing it on every open, including reopens, is what makes this idempotent to
    // re-run renderMermaidBlocks against each time, rather than trying to skip it and risk leaving
    // a reopened guide's diagrams unrendered.
    const template = document.createElement("template");
    template.innerHTML = guide.html;
    const section = anchorId ? sectionUnder(template.content, anchorId) : null;
    titleEl.textContent = section ? section.title : guide.title;
    pathEl.textContent = guide.path;
    contentEl.replaceChildren(...(section ? section.nodes : template.content.childNodes));
    contentEl.scrollTop = 0;
    renderMermaidBlocks(contentEl);
  }

  // The heading's following siblings up to the next heading of the same or higher rank. The
  // heading itself becomes the dialog title rather than repeating inside the body.
  function sectionUnder(fragment, anchorId) {
    const heading = fragment.querySelector(`#${CSS.escape(anchorId)}`);
    const rank = headingRank(heading);
    if (!rank) return null;
    const nodes = [];
    for (let node = heading.nextSibling; node; node = node.nextSibling) {
      const nodeRank = headingRank(node);
      if (nodeRank && nodeRank <= rank) break;
      nodes.push(node);
    }
    return { title: heading.textContent, nodes };
  }

  function headingRank(node) {
    const match = node && /^H([1-6])$/.exec(node.nodeName);
    return match ? Number(match[1]) : 0;
  }

  function close() {
    dialogEl.close();
  }

  return { open, close };
}
