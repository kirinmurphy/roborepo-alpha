// <portal-menu-button label="Copy"></portal-menu-button> — a trigger button that opens an
// anchored popover panel containing arbitrary caller-supplied content (not a fixed option list —
// see option-dropdown.js for the single-select listbox variant). Positioning, outside-click, and
// Escape-to-close mirror option-dropdown.js's proven pattern.
//
// Usage: set `.panelContent` to a Node right after creation. `icon`/`label` configure the trigger
// face — set as plain HTML attributes for static markup, or as JS properties to change them later.
// The panel is only mounted while open, matching option-dropdown's re-render-on-toggle approach.
import { positionPopoverPanel } from "/portal/shared/popover-position.js";
import { portalTpl as tpl } from "/portal/shared/api.js";

class PortalMenuButton extends HTMLElement {
  connectedCallback() {
    for (const key of ["panelContent", "icon", "label"]) {
      if (Object.prototype.hasOwnProperty.call(this, key)) {
        const v = this[key];
        delete this[key];
        this[key] = v;
      }
    }
    // icon/label are also settable as plain HTML attributes (declarative markup, no JS property
    // assignment needed) — fall back to those when the property wasn't set explicitly.
    if (this._icon === undefined && this.hasAttribute("icon")) this._icon = this.getAttribute("icon");
    if (this._label === undefined && this.hasAttribute("label")) this._label = this.getAttribute("label");
    this._open = false;
    this._justToggled = false;
    this._onDocClick = () => {
      if (this._justToggled) {
        this._justToggled = false;
        return;
      }
      if (this._open) this.close();
    };
    this._onKeydown = (event) => {
      if (event.key === "Escape" && this._open) this.close();
    };
    document.addEventListener("click", this._onDocClick);
    document.addEventListener("keydown", this._onKeydown);
    this.render();
  }

  disconnectedCallback() {
    document.removeEventListener("click", this._onDocClick);
    document.removeEventListener("keydown", this._onKeydown);
  }

  set panelContent(node) {
    this._panelContent = node;
    if (this.isConnected && this._open) this.render();
  }
  get panelContent() {
    return this._panelContent || null;
  }

  set icon(name) {
    this._icon = name;
    if (this.isConnected) this.render();
  }

  set label(text) {
    this._label = text;
    if (this.isConnected) this.render();
  }

  open() {
    if (this._open) return;
    this._open = true;
    this.render();
    this.positionMenu();
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.render();
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  positionMenu() {
    const menu = this.querySelector(".menu-button-panel");
    const trigger = this.querySelector(".menu-button-trigger");
    if (!menu || !trigger) return;
    positionPopoverPanel(menu, trigger);
  }

  render() {
    const trigger = tpl("tpl-menu-button-trigger");
    trigger.setAttribute("aria-expanded", String(this._open));
    // `size`, not width/height: portal-icon only observes `name` and `size`, so the width/height
    // attributes this used to set were silently ignored and every trigger icon rendered at the
    // default step anyway.
    if (this._icon) {
      const icon = document.createElement("portal-icon");
      icon.setAttribute("name", this._icon);
      icon.setAttribute("size", "sm");
      trigger.append(icon);
    }
    if (this._label) trigger.append(document.createTextNode(this._label));
    if (this.hasAttribute("aria-label")) trigger.setAttribute("aria-label", this.getAttribute("aria-label"));
    const chevron = document.createElement("portal-icon");
    chevron.setAttribute("name", "chevron");
    chevron.setAttribute("size", "sm");
    chevron.className = "menu-button-chevron";
    trigger.append(chevron);

    trigger.addEventListener("click", () => {
      this._justToggled = true;
      this.toggle();
    });

    const nodes = [trigger];
    if (this._open && this._panelContent) {
      const panel = tpl("tpl-menu-button-panel");
      panel.append(this._panelContent);
      nodes.push(panel);
    }
    this.replaceChildren(...nodes);
    if (this._open) this.positionMenu();
  }
}

if (!customElements.get("portal-menu-button"))
  customElements.define("portal-menu-button", PortalMenuButton);
