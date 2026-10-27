// <portal-copy-menu> — an icon-only copy trigger with a caret that opens a list of copy actions.
//
// The widget owns everything behavioral: the popover toggle, outside-click and Escape, per-item
// clipboard writes, and the per-item green check confirmation. Call sites supply only DATA — an array
// of { label, value } — and never build markup or wire a listener:
//
//   const menu = document.createElement("portal-copy-menu");
//   menu.items = [
//     { label: "Copy branch name", value: () => root.git.branch },
//     { label: "Copy worktree path", value: root.projectRoot },
//   ];
//
// `value` is a string, or a function returning one (sync or async), resolved lazily at click time so
// a row with ten items does not compute ten strings up front. An item whose value resolves to empty
// is skipped rather than copying "" over the user's clipboard.
//
// Single-item lists still render as a menu rather than collapsing to a bare button: the caret is
// what tells the user more than one thing is copyable here, and a control that silently changes
// shape based on item count is harder to hit twice in a row than one that does not.
import { portalCopyText, portalTpl as tpl } from "/portal/shared/api.js";
import { positionPopoverPanel } from "/portal/shared/popover-position.js";

// Matches portal-copy-button's COPIED_DURATION_MS so every copy affordance on the site confirms for
// the same length of time.
const COPIED_DURATION_MS = 5000;
// How long the open panel holds its own green check before closing and handing the confirmation off
// to the trigger flash. Short — the panel has served its purpose once the value is on the
// clipboard, and leaving it open for the full five seconds blocks the row underneath.
const COPIED_FEEDBACK_MS = 600;

class PortalCopyMenu extends HTMLElement {
  connectedCallback() {
    // Property set before upgrade (the common case — callers assign `.items` right after
    // createElement) would otherwise shadow the accessor and never trigger a render.
    if (Object.prototype.hasOwnProperty.call(this, "items")) {
      const pending = this.items;
      delete this.items;
      this.items = pending;
    }
    this._open = false;
    // A click on the trigger reaches document too; without this the same click that opens the panel
    // would immediately close it.
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
    clearTimeout(this._resetTimer);
    clearTimeout(this._flashTimer);
  }

  set items(value) {
    this._items = Array.isArray(value) ? value.filter((item) => item && item.label) : [];
    if (this.isConnected) this.render();
  }
  get items() {
    return this._items || [];
  }

  open() {
    if (this._open) return;
    this._open = true;
    this.render();
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

  async #copy(item, button) {
    const value = typeof item.value === "function" ? item.value() : item.value;
    const text = await value;
    if (typeof text !== "string" || !text) return;
    await portalCopyText(text, () => {
      // Confirms in the item first — the panel is what the pointer is on, so that is where the
      // acknowledgement is looked for.
      button.querySelector("[data-slot=icon]").setAttribute("name", "check");
      button.classList.add("copied");
      button.setAttribute("aria-label", "Copied");
      button.disabled = true;
      clearTimeout(this._resetTimer);
      // Then closes and flashes over the trigger, so the confirmation survives the panel that was
      // showing it — otherwise closing the menu would erase the only signal that anything happened.
      this._resetTimer = setTimeout(() => {
        this.close();
        this.#flashTrigger();
      }, COPIED_FEEDBACK_MS);
    });
  }

  // The same IN-PLACE confirmation the plain copy button uses: the trigger's copy glyph swaps to a
  // check (color flips green via .copy-menu-trigger.copied) inside the same box — no overlay, no
  // alignment drift.
  //
  // Tracked as state rather than toggled directly on the node: render() rebuilds the trigger on
  // every open/close, so a flag the renderer reads is what keeps the confirmation alive across the
  // close that immediately follows a copy.
  #flashTrigger() {
    this._flashing = true;
    this.#syncFlash();
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      this._flashing = false;
      this.#syncFlash();
    }, COPIED_DURATION_MS);
  }

  #syncFlash() {
    const trigger = this.querySelector(".copy-menu-trigger");
    if (trigger) {
      // Boolean(): before the first copy _flashing is undefined, and classList.toggle treats an
      // undefined force argument as "flip" — which turned every idle trigger green on first render.
      trigger.classList.toggle("copied", Boolean(this._flashing));
      trigger.setAttribute("aria-label", this._flashing ? "Copied" : "Copy");
      const icon = trigger.querySelector('[data-slot="icon"]');
      if (icon) icon.setAttribute("name", this._flashing ? "check" : "copy");
    }
  }

  render() {
    const trigger = tpl("tpl-copy-menu-trigger");
    trigger.setAttribute("aria-expanded", String(this._open));
    trigger.addEventListener("click", (event) => {
      // Several call sites sit inside a <summary>, where an unhandled click also toggles the
      // surrounding <details>.
      event.preventDefault();
      event.stopPropagation();
      this._justToggled = true;
      this.toggle();
    });

    const nodes = [trigger];
    if (this._open && this.items.length) {
      const panel = tpl("tpl-copy-menu-panel");
      for (const item of this.items) {
        const button = tpl("tpl-copy-menu-item");
        button.querySelector("[data-slot=label]").textContent = item.label;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.#copy(item, button);
        });
        panel.append(button);
      }
      // Clicks inside the panel must not reach the document handler that closes it.
      panel.addEventListener("click", (event) => event.stopPropagation());
      nodes.push(panel);
    }
    this.replaceChildren(...nodes);
    // Re-applied after every rebuild, so an in-flight confirmation survives the close that follows
    // a copy (the trigger node it was set on is gone by then).
    this.#syncFlash();
    if (this._open) {
      const panel = this.querySelector(".copy-menu-panel");
      if (panel) positionPopoverPanel(panel, trigger);
    }
  }
}

if (!customElements.get("portal-copy-menu")) customElements.define("portal-copy-menu", PortalCopyMenu);
