// Panel-factory for the skill-source popup (same content the Config page shows for a skill
// card), reusable from any portal page. It is a factory (like createInfoModal/createConfigModal) and not
// a custom element:
// the dialog is a page singleton, declared once as static markup in the host page's index.html,
// never cloned or instantiated more than once. Caller passes the dialog element it owns;
// this only wires behavior onto it. Depends on the shared .modal-head/<portal-close-button>/
// .modal-body chrome (each page's own styles.css) and .skill-source-view
// (portal/shared/skill-source-view.css) for the fetched content's own markup.
import { portalGetJson, portalWireBackdropClose } from "./api.js";
import { renderMermaidBlocks } from "./markdown-mermaid.js";

export function createSkillDetailModal(dialogEl) {
  const titleEl = dialogEl.querySelector('[data-slot="title"]');
  const pathEl = dialogEl.querySelector('[data-slot="path"]');
  const contentEl = dialogEl.querySelector('[data-slot="content"]');

  dialogEl.querySelector('[data-slot="close"]').addEventListener("click", close);
  portalWireBackdropClose(dialogEl, close);

  async function open(skillId, label) {
    titleEl.textContent = label || skillId;
    pathEl.textContent = "loading…";
    contentEl.innerHTML = "";
    dialogEl.showModal();
    try {
      const data = await portalGetJson(
        `/api/config/source?kind=skill&id=${encodeURIComponent(skillId)}`,
      );
      if (!data.ok) {
        pathEl.textContent = "";
        contentEl.textContent = "error: " + (data.error || "failed to load");
        return;
      }
      titleEl.textContent = data.title || label || skillId;
      pathEl.textContent = data.path || "";
      contentEl.innerHTML = data.html || "";
      // A skill body is ordinary markdown, so it can contain a ```mermaid diagram like any guide.
      renderMermaidBlocks(contentEl);
    } catch (err) {
      pathEl.textContent = "";
      contentEl.textContent = "error: " + err.message;
    }
  }

  function close() {
    dialogEl.close();
  }

  return { open, close };
}
