// <plan-card> — set .record (plan record) and .actions (cardActions bag: onOpen, onCopyPath,
// onCopyContext, onPlanAction, mergeFor, planSuiteEnabled, planSuitePackage,
// skillModal, onEnablePackage, onError) as properties right after creation, then append to the
// DOM. The title/description trigger onOpen; the status component owns its separate controls. The
// modified time, warnings, actions, and work status live in <plan-status>, shared with the detail
// drawer and stacked below the card's title and description in every lifecycle. An optional
// actions.titleFor(record) replaces the displayed title; Backlog uses it for the namespace label.
import { portalTpl as tpl, portalFillSlots as fill } from "/portal/shared/api.js";
import { cardActionMenu, cardPrimaryAction } from "/portal/plans/templates.js";
import { incompleteDependencies } from "/portal/plans/plan-actions.js";
import { currentRepositoryScope, hrefWithRepositoryScope, setRepositoryScope } from "/portal/shared/repository-scope.js";

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

    const node = fill(tpl("tpl-plan-card"), {
      description: truncate(plan.excerpt || "No description", EXCERPT_DISPLAY_LENGTH),
    });
    const statusEl = document.createElement("plan-status");
    const primary = cardPrimaryAction(record, cardActions);
    const menu = cardActionMenu(record, cardActions);
    statusEl.actionContent = plan.lifecycle === "backlog" && incompleteDependencies(record, cardActions.plans || []).length
      ? [menu, primary]
      : [...(primary ? [primary] : []), menu];
    statusEl.merge = cardActions.mergeFor?.(record.key) || null;
    statusEl.record = record;
    node.querySelector("[data-slot=status-mount]").replaceWith(statusEl);
    renderRepoBadge(node.querySelector("[data-slot=repo-badge]"), record.repository);
    node.querySelector("[data-slot=title-link]").textContent = cardActions.titleFor?.(record) ?? plan.title;
    // Only title/description open the document; metadata and actions are separate siblings.
    const docDetails = node.querySelector(".doc-details");
    docDetails.tabIndex = 0;
    docDetails.setAttribute("role", "button");
    const isInteractiveTarget = (event) =>
      event.target.closest("button, option-dropdown, portal-menu-button, a[href], input, select");
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

// The badge applies the page's repo filter, the same as choosing the repo in the selector. Once
// any repo filter is set it stays inert, since following it could only reload the current view.
function renderRepoBadge(badge, repository) {
  badge.textContent = repository.name;
  if (!repository.urlKey || currentRepositoryScope()) {
    badge.setAttribute("aria-disabled", "true");
    return;
  }
  badge.href = hrefWithRepositoryScope(location.href, repository.urlKey);
  badge.title = `Show only ${repository.name} plans`;
  badge.addEventListener("click", (event) => {
    // Modified clicks open the filtered page in a new tab or window as usual.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setRepositoryScope(repository.urlKey);
  });
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}…`;
}
