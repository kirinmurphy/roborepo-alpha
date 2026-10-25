// <plan-card> — set .record (plan record) and .actions (cardActions bag: onOpen, onCopyPath,
// onCopyContext, onCopyPortableContext, onPlanAction, mergeFor, planSuiteEnabled, planSuitePackage,
// skillModal, onEnablePackage, onError) as properties right after creation, then append to the
// DOM. The whole card triggers onOpen on click, except interactive widgets (the mounted
// <plan-status>, the recommended-next CTA, and the ⋯ actions menu) inside it. The priority
// control, readiness/blocked chips, and completion live in the mounted <plan-status> element
// (shared with the detail drawer), stacked below the card's main content in every lifecycle.
import { portalTpl as tpl, portalFillSlots as fill } from "/portal/shared/api.js";
import { cardActionMenu, cardPrimaryAction, chip } from "/portal/plans/templates.js";

// Card shows a shortened preview; full text (up to 500 chars) still lives in plan.excerpt
// for copy-context/drawer use — only the on-card display is truncated further here.
const EXCERPT_DISPLAY_LENGTH = 190;

class PlanCardElement extends HTMLElement {
  connectedCallback() {
    if (this.record && this.actions) this.render();
  }

  set record(value) {
    this._record = value;
    if (this.isConnected && this.actions) this.render();
  }
  get record() {
    return this._record;
  }

  set actions(value) {
    this._actions = value;
    if (this.isConnected && this.record) this.render();
  }
  get actions() {
    return this._actions;
  }

  render() {
    const record = this._record;
    const cardActions = this._actions;
    const plan = record.plan;
    const warnings = plan.validation.warnings.length;

    const node = fill(tpl("tpl-plan-card"), {
      description: truncate(plan.excerpt || "No description", EXCERPT_DISPLAY_LENGTH),
    });
    const statusEl = document.createElement("plan-status");
    statusEl.merge = cardActions.mergeFor?.(record.key) || null;
    statusEl.record = record;
    node.querySelector("[data-slot=status-mount]").replaceWith(statusEl);
    node.querySelector("[data-slot=chips]").append(
      warnings ? chip(`${warnings} warnings`, "warn") : chip("valid", "ok"),
    );
    node.querySelector("[data-slot=title-link]").textContent = plan.title;
    // One primary command (Start, Continue, Update, or Close) when the plan has a way forward,
    // then the unified ⋯ menu shared with the drawer.
    const primary = cardPrimaryAction(record, cardActions);
    node.querySelector("[data-slot=actions]").append(
      ...(primary ? [primary] : []),
      cardActionMenu(record, cardActions),
    );
    // doc-details (title/description/footer) is the click surface — status-section (priority,
    // completion) sits outside it as its own sibling, so it's naturally excluded rather than
    // needing a manual closest() exclusion. Clicks/keypresses landing on an interactive widget
    // inside doc-details (priority dropdown, action buttons) are still ignored so they only do
    // their own thing. tabindex+role make doc-details itself keyboard-reachable now that
    // title/description are plain text, not buttons.
    const docDetails = node.querySelector(".doc-details");
    docDetails.tabIndex = 0;
    docDetails.setAttribute("role", "button");
    const isInteractiveTarget = (event) =>
      event.target.closest("button, option-dropdown, portal-menu-button, a, input, select");
    docDetails.addEventListener("click", (event) => {
      if (isInteractiveTarget(event)) return;
      cardActions.onOpen(record.key);
    });
    docDetails.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (isInteractiveTarget(event)) return;
      event.preventDefault();
      cardActions.onOpen(record.key);
    });
    this.replaceChildren(node);
  }
}

customElements.define("plan-card", PlanCardElement);

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}…`;
}
