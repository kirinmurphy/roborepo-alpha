// Singleton controller for #blockers-popover — a small anchored panel listing a plan's blockers
// (or, from the drawer, its own Blocked by / Blocking sections), triggered by the card's
// "blocked by N" button. Each resolved blocker is a link; app.js's onOpenPlan callback decides
// what "open" means (closes the popover, opens the target's drawer). Unresolved ids (a blocked_by
// entry with no matching plan in the same repository) render as plain, unclickable text.
import { blockerLink } from "./templates.js";
import { positionPopoverPanel } from "/portal/shared/popover-position.js";

export function createBlockersPopover(panelEl, { onOpenPlan }) {
  const titleEl = panelEl.querySelector('[data-slot="title"]');
  const listEl = panelEl.querySelector('[data-slot="list"]');

  const close = () => { panelEl.hidden = true; };
  document.addEventListener("click", (event) => {
    if (panelEl.hidden || panelEl.contains(event.target)) return;
    close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panelEl.hidden) close();
  });
  window.addEventListener("scroll", () => { if (!panelEl.hidden) close(); }, true);

  // blockers: [{id, title, key, resolved}], anchor: the button that triggered this popover.
  function open({ blockers, anchor }) {
    titleEl.textContent = blockers.length === 1 ? "Blocked by" : `Blocked by ${blockers.length}`;
    listEl.replaceChildren(...blockers.map((blocker) => blockerLink(blocker, (key) => {
      close();
      onOpenPlan(key);
    })));
    panelEl.hidden = false;
    positionPopoverPanel(panelEl, anchor);
  }

  return { open, close };
}
