// <config-toggle></config-toggle> — one on/off switch for a mutable config item. Set .item (the
// behaviorView item, needs .active/.label) and .onToggle (async (item, enabled) => void — caller
// owns the POST + re-render) as properties right after creation. Optimistic-disable while the
// POST is in flight, with a spinner just left of the switch; reverts + shows the error on failure.
// Error text renders into a sibling .item-status node the caller passes as .statusSlot (the row's
// own status line, shared with other item feedback — not owned by this element). Built from tpl-config-toggle
// (portal/config/index.html) — page-owned, only used from /agents.
import { portalTpl as tpl } from "/portal/shared/api.js";

class ConfigToggleElement extends HTMLElement {
  connectedCallback() {
    if (this._item) this.render();
  }

  set item(value) {
    this._item = value;
    if (this.isConnected) this.render();
  }
  get item() {
    return this._item;
  }

  set onToggle(fn) {
    this._onToggle = fn;
  }
  get onToggle() {
    return this._onToggle;
  }

  set statusSlot(node) {
    this._statusSlot = node;
  }
  get statusSlot() {
    return this._statusSlot;
  }

  // External lock (e.g. section batch in flight): re-render so the input picks up disabled.
  // Property, not attribute — callers hold the element reference, and the re-render path is the
  // same one every other state change goes through.
  set disabled(value) {
    this._disabled = value;
    if (this.isConnected) this.render();
  }
  get disabled() {
    return this._disabled;
  }

  render() {
    const wrap = tpl("tpl-config-toggle");
    const input = wrap.querySelector('[data-slot="input"]');
    const spinner = wrap.querySelector('[data-slot="spinner"]');
    input.checked = !!this._item.active;
    input.disabled = !!this._disabled;
    input.setAttribute("aria-label", this._item.label);
    spinner.setAttribute("aria-label", `Applying ${this._item.label}`);

    input.addEventListener("change", async () => {
      const enabled = input.checked;
      const statusSlot = this._statusSlot;
      input.disabled = true;
      spinner.hidden = false;
      if (statusSlot) {
        statusSlot.className = "item-status";
        statusSlot.textContent = "";
      }
      try {
        await this._onToggle?.(this._item, enabled);
      } catch (e) {
        input.checked = !enabled; // revert
        if (statusSlot) {
          statusSlot.className = "item-status error";
          statusSlot.textContent = e.message;
        }
      } finally {
        spinner.hidden = true;
        input.disabled = false;
      }
    });

    this.replaceChildren(wrap);
  }
}

customElements.define("config-toggle", ConfigToggleElement);
