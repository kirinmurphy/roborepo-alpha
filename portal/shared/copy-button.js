// <portal-copy-button label="Copy"></portal-copy-button> — a button that copies text to the
// clipboard and shows a green check for a few seconds instead of managing state per call site.
//
// Usage: set `.copySource` right after creation to a string, or a function returning a string
// (sync or async) — resolved lazily at click time so callers can build the text on demand instead
// of computing it up front for every row. Attributes: `label` (button text; omit for an icon-only
// button), `icon` (portal-icon name, defaults to "copy"), `aria-label` (the inner button's idle
// accessible name, for an icon-only button whose label would otherwise be the generic "Copy").
//
// While the confirmation shows, the element carries a `copied` attribute, so a caller can restyle its
// surroundings (e.g. `:has(portal-copy-button[copied])`) without reaching into the button's markup.
//
// Confirmation swaps the icon to a green check while keeping the idle label and button size.
// The accessible name announces success without adding visible confirmation text.
import { portalCopyText, portalTpl as tpl, portalFillSlots as fill } from "./api.js";

const COPIED_DURATION_MS = 5000;

class PortalCopyButton extends HTMLElement {
  static observedAttributes = ["label", "icon", "icon-size", "disabled", "aria-label"];

  connectedCallback() {
    if (this.button) {
      this.syncAttributes();
      return;
    }
    const label = this.getAttribute("label");
    const iconName = this.getAttribute("icon") || "copy";

    const button = fill(tpl("tpl-copy-button"), {
      icon: { name: iconName },
      label: label || "",
    });
    button.addEventListener("click", () => this.#handleClick());

    this.button = button;
    this.replaceChildren(button);
    this.syncAttributes();
  }

  // A button removed mid-confirmation (a closed popover panel, say) resets now: its timer dies with
  // it, so a later reconnect would otherwise keep its disabled green check for good.
  disconnectedCallback() {
    clearTimeout(this._resetTimer);
    if (this._copied) this.#resetCopied();
  }

  attributeChangedCallback() {
    this.syncAttributes();
  }

  syncAttributes() {
    if (!this.button) return;
    const label = this.getAttribute("label");
    this.button.setAttribute("aria-label", this._copied ? "Copied" : this.getAttribute("aria-label") || label || "Copy");
    this.button.disabled = this.hasAttribute("disabled") || this._copied;
    // Idle icon/label text live in slots; when copied, #showCopied swaps their content in place
    // and this method only refreshes the aria-label + disabled state.
    if (!this._copied) {
      const icon = this.button.querySelector('[data-slot="icon"]');
      if (icon) {
        icon.setAttribute("name", this.getAttribute("icon") || "copy");
        // An icon-only button beside an icon dropdown passes the dropdown's step so the two match.
        icon.setAttribute("size", this.getAttribute("icon-size") || "sm");
      }
      const labelEl = this.button.querySelector('[data-slot="label"]');
      if (labelEl) labelEl.textContent = label || "";
    }
  }

  async #handleClick() {
    if (this._copied) return;
    const source = typeof this.copySource === "function" ? this.copySource() : this.copySource;
    const text = await source;
    if (typeof text !== "string") return;
    await portalCopyText(text, () => this.#showCopied());
  }

  // Keep the label in place so icon-only controls stay icon-only and labeled controls keep their width.
  #showCopied() {
    this._copied = true;
    this.setAttribute("copied", "");
    this.button.classList.add("copy-button-copied");
    const icon = this.button.querySelector('[data-slot="icon"]');
    if (icon) icon.setAttribute("name", "check");
    this.button.setAttribute("aria-label", "Copied");
    this.button.disabled = true;
    clearTimeout(this._resetTimer);
    this._resetTimer = setTimeout(() => this.#resetCopied(), COPIED_DURATION_MS);
  }

  #resetCopied() {
    this._copied = false;
    this.removeAttribute("copied");
    this.button.classList.remove("copy-button-copied");
    this.syncAttributes(); // restores idle icon + label + aria-label
  }
}

if (!customElements.get("portal-copy-button"))
  customElements.define("portal-copy-button", PortalCopyButton);
