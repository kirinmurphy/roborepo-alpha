// <config-item></config-item> — one row in a standard config section (Monitoring,
// Commands, Code Conventions, Chat-Time Output), or in the post-enable recommendations dialog. A
// row's required packages travel with its inspect click, so the source popup can list them, and a
// row with required or recommended packages gets a Dependencies popover listing both. Set
// .item (the behaviorView item) and .actions ({onInspect, onToggle, onDependency, offersOnEnable})
// as properties right after creation. Builds itself from the tpl-config-item template, owns
// conditional listener wiring (inspect-click, toggle-swap) internally, embeds <config-toggle> in
// its toggle slot when the item is mutable.
import { portalTpl as tpl, portalFillSlots as fill, portalMiddleEllipsis } from "/portal/shared/api.js";
import { applyTokenChip, packageDependencies } from "../templates.js";
import { contextCostChipSpecs } from "../state.js";

// Package status strings surfaced as badges (config.mjs packagePresentationItem). "partial" and
// "pending" mean something needs attention; "configured" means fully installed with a service that
// is simply turned off (not broken) — it must NOT share the warning styling that "partial" gets, or
// an administratively-off telemetry service looks like a failed install.
const STATUS_BADGE_CLASS = {
  partial: "badge-warn",
  pending: "badge-warn",
  configured: "badge-info",
  external: "badge-info",
  inactive: "badge-info",
};

// tpl-badge's root element IS the data-slot="text" node, and portalFillSlots only matches
// descendants — so this sets textContent directly instead of going through fill(). A badge is
// either a bare status string or { text, status, title } when its words differ from the status key.
function badge(spec) {
  const { text, status = text, title } = typeof spec === "string" ? { text: spec } : spec;
  const node = tpl("tpl-badge");
  node.textContent = text;
  if (title) node.title = title;
  const statusClass = STATUS_BADGE_CLASS[status];
  node.classList.add(statusClass || (text.startsWith("/") ? "badge-cmd" : "badge-skill"));
  return node;
}

// Row-level token-cost chip. Real <token-chip> (not a plain badge) so it carries the same
// hover/click tooltip and legend as every other cost chip on the page.
function rowCostChip(spec) {
  const chip = document.createElement("token-chip");
  applyTokenChip(chip, spec);
  return chip;
}

// A Custom or Third Party card's source state, from the package service's view (item.packageState,
// one `packageView()` row): its source badge, pinned commit, what its source no longer offers, and
// the Install, Update, and Remove actions. `item.packageNote` is a state the row cannot carry (an
// unresolved or shadowed package). Returns whether the on/off switch shows: every package but a
// GitHub one not installed yet.
const STATE_NOTES = {
  sourceChanged: "Its source now points at a different repo",
  unavailable: "No longer offered by its source",
};

function renderPackageState(row, item, { onPackageAction }) {
  const state = item.packageState;
  const noteEl = row.querySelector('[data-slot="package-note"]');
  const actionsEl = row.querySelector('[data-slot="package-actions"]');
  const revisionEl = row.querySelector('[data-slot="revision"]');
  const notes = [
    item.packageNote,
    state?.sourceChanged ? STATE_NOTES.sourceChanged : null,
    state && state.available === false ? STATE_NOTES.unavailable : null,
  ].filter(Boolean);
  noteEl.textContent = notes.join(". ");
  noteEl.hidden = notes.length === 0;
  // A GitHub badge is owner/repo; a local repo's is its whole path, so long names keep both ends.
  if (state?.sourceBadge) {
    row.querySelector('[data-slot="badges"]').prepend(badge({ text: portalMiddleEllipsis(state.sourceBadge, 40), status: "inactive", title: `Source: ${state.sourceBadge}` }));
  }
  if (!state && !item.packageActions?.length) return true;
  if (state?.sourceType === "git" && state.revision) {
    revisionEl.textContent = `@ ${state.revision.slice(0, 12)}`;
    revisionEl.title = state.revision;
    revisionEl.hidden = false;
  }
  // Only a GitHub package needs an install before it can be turned on. A folder package is used in
  // place, and its switch installs it, as `roborepo package enable` does.
  const needsInstall = state?.sourceType === "git" && !state.installed;
  const kinds = item.packageActions || [
    ...(needsInstall ? ["install"] : []),
    ...(state.updateAvailable && !state.sourceChanged ? ["update"] : []),
    ...(state.removable ? ["remove"] : []),
  ];
  actionsEl.replaceChildren(...kinds.map((kind) => {
    const button = tpl("tpl-package-action");
    button.textContent = ACTION_LABELS[kind];
    button.dataset.action = kind;
    if (kind === "install") button.dataset.btn = "cta";
    button.setAttribute("aria-label", `${ACTION_LABELS[kind]} ${item.label}`);
    button.addEventListener("click", () => onPackageAction?.(kind, item, button));
    return button;
  }));
  actionsEl.hidden = kinds.length === 0;
  return !needsInstall;
}

const ACTION_LABELS = { install: "Install", update: "Update", remove: "Remove" };

class ConfigItemElement extends HTMLElement {
  connectedCallback() {
    if (this._item && this._actions) this.render();
  }

  set item(value) {
    this._item = value;
    if (this.isConnected && this._actions) this.render();
  }
  get item() {
    return this._item;
  }

  set actions(value) {
    this._actions = value;
    if (this.isConnected && this._item) this.render();
  }
  get actions() {
    return this._actions;
  }

  render() {
    const item = this._item;
    const { onInspect, onToggle, onDependency, offersOnEnable = true, contextCost } = this._actions;
    const row = fill(tpl("tpl-config-item"), {
      description: item.description,
      note: item.note,
      hint: item.hint,
    });

    const dotEl = row.querySelector('[data-slot="dot"]');
    dotEl.classList.add(item.active ? "on" : "off");

    // Inspectable items (skills/commands/chat-time rules) get a clickable label that opens the
    // source popup. The label still reflects active/dim state.
    const labelEl = row.querySelector('[data-slot="label"]');
    labelEl.classList.toggle("dim", !item.active);
    labelEl.classList.toggle("clickable", !!item.inspect);
    labelEl.textContent = item.label;
    if (item.inspect) {
      labelEl.title = "view source";
      // Pass the item's cost along so the source popup can show its token chip.
      labelEl.addEventListener("click", () => onInspect(item.inspect, item.contextCost, { builtIn: item.builtIn, requires: item.requires || [] }));
    }

    // Info URL (GitHub / docs / PyPI): a single inline icon on the label row, opening the FIRST
    // urls[] entry. Items with more than one URL only expose that first one via the portal — any
    // additional related links must be reachable from that page instead (e.g. its README).
    const linkEl = row.querySelector('[data-slot="link-icon"]');
    if (item.urls && item.urls.length) {
      linkEl.href = item.urls[0].url;
      linkEl.title = item.urls[0].url;
      linkEl.hidden = false;
    }

    row.querySelector('[data-slot="description"]').hidden = !item.description;
    row.querySelector('[data-slot="note"]').hidden = !item.note;
    row.querySelector('[data-slot="hint"]').hidden = !item.hint;

    row.querySelector('[data-slot="badges"]').replaceChildren(
      ...(item.badges || []).map((b) => badge(b)),
      ...contextCostChipSpecs(item, contextCost).map(({ spec }) => rowCostChip(spec)),
    );

    const dependenciesSlot = row.querySelector('[data-slot="dependencies"]');
    if (onDependency && (item.requires?.length || item.recommends?.length)) {
      // createElement, not a template clone: the element must upgrade before panelContent is set.
      const menu = document.createElement("portal-menu-button");
      menu.className = "package-deps-trigger";
      menu.label = "Dependencies";
      menu.panelContent = packageDependencies(item, onDependency, { offersOnEnable });
      dependenciesSlot.replaceWith(menu);
    } else {
      dependenciesSlot.remove();
    }

    const statusEl = row.querySelector('[data-slot="status"]');
    const toggleSlot = row.querySelector('[data-slot="toggle"]');
    const showToggle = renderPackageState(row, item, this._actions);
    if (item.toggle && showToggle) {
      const toggle = document.createElement("config-toggle");
      toggle.item = item;
      toggle.onToggle = onToggle;
      toggle.statusSlot = statusEl;
      toggleSlot.replaceWith(toggle);
    } else {
      toggleSlot.remove();
    }

    this.replaceChildren(row);
  }
}

customElements.define("config-item", ConfigItemElement);
