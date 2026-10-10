// <portal-notice variant="alert|warning|info|success"> — shared notification CHROME wrapper. It
// owns theme only (border color + background tint + a leading variant icon); it does NOT manage a
// list of items or fetch anything. Slot whatever content you want inside it (a title, a list, a
// paragraph) and it keeps working — the wrapper just frames it consistently across pages.
//
// Light-DOM (no shadow root) like the other shared elements (portal-close-button, portal-icon), so
// page CSS can still target the slotted content and existing id/data-slot wiring keeps working. All
// visual styling lives in portal/shared/base.css under `.portal-notice` so every page picks it up.
//
// Usage:
//   <portal-notice variant="warning">
//     <p class="notice-title">Heads up</p>
//     <div>…your content…</div>
//   </portal-notice>
//
// variant defaults to "info". Set the `no-icon` attribute to drop the leading icon, or `icon` to
// name a different one (an info notice has none by default; a prompt can opt into "info").

import { portalTpl as tpl, portalFillSlots as fill } from "./api.js";

const VARIANT_ICON = {
  alert: "warning",
  warning: "warning",
  info: null,
  success: null,
};

const VALID = new Set(["alert", "warning", "info", "success"]);

class PortalNotice extends HTMLElement {
  static observedAttributes = ["variant", "no-icon", "icon"];

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const variant = VALID.has(this.getAttribute("variant")) ? this.getAttribute("variant") : "info";
    // Reflect the resolved variant to a class so base.css can style purely off the class (and so a
    // bad/absent attribute value still lands on the "info" styling rather than nothing).
    this.classList.add("portal-notice");
    for (const v of VALID) this.classList.toggle(`notice-${v}`, v === variant);

    // The leading icon is a chrome affordance the wrapper owns, kept separate from the slotted
    // content. Re-created on each render so a variant change swaps it; the caller's content children
    // are left untouched (only our own [data-notice-icon] node is replaced).
    const existingIcon = this.querySelector(":scope > [data-notice-icon]");
    if (existingIcon) existingIcon.remove();
    const iconName = this.getAttribute("icon") || VARIANT_ICON[variant];
    if (iconName && !this.hasAttribute("no-icon")) {
      const wrap = fill(tpl("tpl-notice-icon"), { icon: { name: iconName } });
      this.prepend(wrap);
    }
  }
}

if (!customElements.get("portal-notice")) customElements.define("portal-notice", PortalNotice);
