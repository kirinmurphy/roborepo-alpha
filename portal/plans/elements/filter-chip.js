// <filter-chip filter-id="priority" label="priority" value="high"></filter-chip>
// Dispatches a bubbling "chip-remove" CustomEvent (detail: filterId) when its × is clicked.
// Built from tpl-filter-chip (portal/plans/index.html) — this element is page-owned (only used
// from /plans), so unlike skill-detail-modal it can rely on the host page's template.
import { portalTpl as tpl, portalFillSlots as fill } from "/portal/shared/api.js";

class FilterChipElement extends HTMLElement {
  connectedCallback() {
    if (this.querySelector(".filter-chip")) return; // already rendered
    const node = fill(tpl("tpl-filter-chip"), {
      label: this.getAttribute("label") || "",
      value: this.getAttribute("value") || "",
    });
    node.querySelector('[data-slot="remove"]').addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("chip-remove", { detail: this.getAttribute("filter-id"), bubbles: true }),
      );
    });
    this.replaceChildren(node);
  }
}

customElements.define("filter-chip", FilterChipElement);
