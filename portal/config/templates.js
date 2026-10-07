// All markup construction for the Config page. Every export takes plain data (plus callbacks for
// the handful of elements that need a listener) and returns a DOM node. Nothing here reads or
// writes app state directly, and nothing here imports the modal — app.js wires callbacks in.

import { portalTpl as tpl, portalFillSlots as fill } from "/portal/shared/api.js";
import { presentedHarnesses } from "/portal/shared/harness-cohort.js";
import { harnessWarningElement } from "/portal/shared/harness-warning.js";
import {
  resolveDriftChip,
  harnessChipSpec,
  rulesChipSpec,
  tokenWarningEntries,
  isBulkInFlight,
} from "./state.js";

// Applies a chip spec ({ tokens, level, detail, breakdown, legend }) to a <token-chip> element;
// hides the element when there is no spec (e.g. old snapshot without contextCost).
export function applyTokenChip(chipEl, spec) {
  if (!chipEl) return;
  if (!spec) {
    chipEl.hidden = true;
    return;
  }
  chipEl.hidden = false;
  chipEl.tokens = spec.tokens;
  chipEl.level = spec.level ?? null;
  chipEl.detail = spec.detail || null;
  chipEl.breakdown = spec.breakdown || [];
  chipEl.legend = spec.legend || null;
}

function applyWarningTokenChip(chipEl, spec) {
  if (!spec || !["medium", "high"].includes(spec.level)) {
    applyTokenChip(chipEl, null);
    return;
  }
  applyTokenChip(chipEl, spec);
}

// Builds a "Label: [chip]" pair for the popup cost row / row-level warning chips.
export function labeledTokenChip({ label, spec }) {
  const wrap = fill(tpl("tpl-labeled-token-chip"), { label: label + ":" });
  applyTokenChip(wrap.querySelector("[data-slot=chip]"), spec);
  return wrap;
}

function warningInfoIcon(info) {
  const wrap = fill(tpl("tpl-warning-info-icon"), { tip: info });
  const tip = wrap.querySelector("[data-slot=tip]");

  const show = () => {
    tip.hidden = false;
    wrap.setAttribute("aria-expanded", "true");
  };
  const hide = () => {
    tip.hidden = true;
    wrap.setAttribute("aria-expanded", "false");
  };
  wrap.addEventListener("mouseenter", show);
  wrap.addEventListener("mouseleave", hide);
  wrap.addEventListener("focus", show);
  wrap.addEventListener("blur", hide);
  wrap.addEventListener("click", () => (tip.hidden ? show() : hide()));
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  return wrap;
}

function tokenWarningItem({ name, suffix, spec, info }) {
  const row = fill(tpl("tpl-token-warning-item"), { name, suffix: suffix || "" });
  if (info) row.querySelector("[data-slot=info]").append(warningInfoIcon(info));
  applyTokenChip(row.querySelector("[data-slot=chip]"), spec);
  return row;
}

function wireDefaultButton(btn, ruleKey, rulePath, label, rules, onDefaultClick) {
  btn.dataset.ruleKey = ruleKey;
  btn.dataset.rulePath = rulePath;
  btn.textContent = label;
  const entry = rules[ruleKey];
  btn.disabled = !entry?.html;
  btn.addEventListener("click", () => onDefaultClick(label, rulePath, entry));
}

export function modalDefaults(rules, harnesses, onDefaultClick) {
  const defaults = tpl("tpl-modal-defaults");
  for (const btn of defaults.querySelectorAll("[data-rule-key]")) {
    wireDefaultButton(btn, btn.dataset.ruleKey, btn.dataset.rulePath, btn.textContent.trim(), rules, onDefaultClick);
  }
  const slot = defaults.querySelector("[data-slot=\"per-harness\"]");
  for (const harness of harnesses || []) {
    const btn = tpl("tpl-modal-defaults-harness-button");
    wireDefaultButton(btn, harness.id, `globals/rules/${harness.id}`, `${harness.displayName} specifics`, rules, onDefaultClick);
    slot.append(btn);
  }
  return defaults;
}

function bucketControl({ current, onSelect }) {
  const node = document.createElement("bucket-control");
  node.current = current;
  node.onSelect = onSelect;
  return node;
}

// Shows/hides a data-slot element by selector; when `show` is truthy and `text` is given, fills
// its textContent too. Centralizes the "conditional slot" idiom used across the behavior/
// arbitrary-command row templates, where several optional pieces (badges, notes, buttons) only
// appear when the item's data warrants them.
function toggleSlot(node, name, show, text) {
  const slot = node.querySelector(`[data-slot="${name}"]`);
  slot.hidden = !show;
  if (show && text != null) slot.textContent = text;
  return slot;
}

// One row shape for every permission entry, named behavior or arbitrary command alike: label, a
// deny/ask/allow segmented control, and — only on a row the user customized — a delete affordance.
// The two kinds differ only in how the mutate endpoint addresses them (behaviorId vs a token
// array), so that is the only branch; everything the user sees is identical.
//
// Confirms before moving OUT of deny, since that is the loosening direction.
export function behaviorRow(item, { onApplyBucket }) {
  const row = tpl("tpl-permission-row");
  const wrap = tpl("tpl-behavior-row");
  const err = wrap.querySelector('[data-slot="err"]');
  const target = item.kind === "behavior"
    ? { behaviorId: item.id }
    : { tokens: item.tokens || item.label.split(" ") };

  fill(wrap, { label: item.label });
  toggleSlot(wrap, "codex-only", item.codexOnly);
  toggleSlot(wrap, "description", item.description, item.description);
  // A default row states no default — it IS the default; saying so twice is noise.
  toggleSlot(wrap, "default-bucket", item.overridden && item.defaultBucket,
    "default: " + item.defaultBucket);

  // Delete shows only on a row the user actually customized. "revert" restores the shipped
  // default; "remove" drops a user-added command that has no default to fall back to. Both are
  // the same request — bucket "default" — the labels differ because the outcomes differ.
  //
  // A row without a delete swaps the button for an inert placeholder of the same width instead of
  // hiding it, so the bucket controls stay in one column across both groups.
  const del = wrap.querySelector('[data-slot="reset"]');
  if (item.deletable) {
    del.hidden = false;
    del.textContent = item.deletable === "remove" ? "remove" : "revert";
    del.addEventListener("click", async () => {
      if (item.deletable === "remove") {
        const ok = window.confirm("Remove \"" + item.label + "\" from your permissions?");
        if (!ok) return;
      }
      await onApplyBucket({ ...target, bucket: "default" }, err);
    });
  } else {
    const placeholder = document.createElement("span");
    placeholder.className = "reset-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    del.replaceWith(placeholder);
  }

  wrap.querySelector('[data-slot="bucket-control"]').replaceWith(bucketControl({
    current: item.bucket,
    onSelect: async (b) => {
      if (item.bucket === "deny" && b !== "deny") {
        const ok = window.confirm(
          "Moving \"" + item.label + "\" out of deny loosens safety. Apply anyway?",
        );
        if (!ok) return;
      }
      await onApplyBucket({ ...target, bucket: b }, err);
    },
  }));

  fill(row, { content: wrap });
  return row;
}

// Whether the defaults list is expanded, kept outside the panel because a permission change
// rebuilds the whole section from the new snapshot. Without this, changing a bucket on a default
// row collapses the list out from under the click that caused it — the exact moment the user is
// most likely to have it open. Module-level rather than per-panel since only one renders.
let defaultsExpanded = false;

// Permissions renders as one list split by authorship, not by entry kind: the user's own settings
// first, then the shipped defaults collapsed behind a count. Someone who has changed three things
// sees three rows, not 39 — but every default stays one click away rather than hidden.
export function permissionsSection(section, callbacks) {
  const panel = tpl("tpl-permissions-section");
  const items = section.items || [];
  const yours = items.filter((it) => it.overridden);
  const defaults = items.filter((it) => !it.overridden);

  const yoursSlot = panel.querySelector('[data-slot="yours"]');
  const emptySlot = panel.querySelector('[data-slot="yours-empty"]');
  yoursSlot.replaceChildren(...yours.map((it) => permissionRow(it, callbacks)));
  // With nothing customized, a bare "Yours" heading over empty space reads as broken.
  emptySlot.hidden = yours.length > 0;
  panel.querySelector('[data-slot="yours-head"]').hidden = yours.length === 0;

  // Defaults are grouped by category, in manifest order (safest first), so 38 rows read as seven
  // short lists instead of one wall. A category with no entries is skipped rather than shown
  // empty. Anything whose category is missing from the taxonomy lands in a trailing "Other" group
  // rather than vanishing — a row the user cannot see is worse than an imperfectly filed one.
  const defaultsSlot = panel.querySelector('[data-slot="defaults"]');
  const categories = section.categories || [];
  const remaining = new Set(defaults);
  const groups = [];
  for (const category of categories) {
    const rows = defaults.filter((it) => it.category === category.id);
    for (const row of rows) remaining.delete(row);
    if (rows.length > 0) groups.push({ label: category.label, description: category.description, rows });
  }
  if (remaining.size > 0) groups.push({ label: "Other", description: "", rows: [...remaining] });

  defaultsSlot.replaceChildren(...groups.flatMap((group) => {
    const head = tpl("tpl-perm-category");
    fill(head, { label: group.label, count: String(group.rows.length) });
    toggleSlot(head, "description", group.description, group.description);
    return [head, ...group.rows.map((it) => permissionRow(it, callbacks))];
  }));
  const toggle = panel.querySelector('[data-slot="defaults-toggle"]');
  const setOpen = (open) => {
    defaultsExpanded = open;
    defaultsSlot.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open
      ? `Hide defaults (${defaults.length})`
      : `Show defaults (${defaults.length})`;
  };
  setOpen(defaultsExpanded);
  toggle.addEventListener("click", () => setOpen(defaultsSlot.hidden));
  panel.querySelector('[data-slot="defaults-head"]').hidden = defaults.length === 0;

  // Adding a command is a section-level action now that there is no separate arbitrary list to
  // hang it off. New commands land in `ask`, the conservative choice for something unreviewed.
  const input = panel.querySelector('[data-slot="input"]');
  const addErr = panel.querySelector('[data-slot="add-err"]');
  panel.querySelector('[data-slot="add-btn"]').addEventListener("click", async () => {
    const tokens = input.value.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;
    const ok = await callbacks.onApplyBucket({ tokens, bucket: "ask" }, addErr);
    if (ok) input.value = "";
  });

  return panel;
}

// Read-only view of what roborepo keeps on disk. No reset control here on purpose — clearing a
// store is destructive and belongs behind `roborepo maintenance stores reset <id>`.
export function storesSection(section) {
  const panel = tpl("tpl-stores-section");
  panel.querySelector('[data-slot="description"]').textContent = section.description || "";
  panel.querySelector('[data-slot="rows"]').replaceChildren(...section.items.map(storeRow));
  // Collapsed by default: store paths are diagnostics, not daily controls — the same
  // show/hide-with-count pattern the Permissions section uses for its defaults list.
  const rows = panel.querySelector('[data-slot="rows"]');
  const toggle = panel.querySelector('[data-slot="stores-toggle"]');
  const setOpen = (open) => {
    rows.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open
      ? `Hide stores (${section.items.length})`
      : `Show stores (${section.items.length})`;
  };
  setOpen(false);
  toggle.addEventListener("click", () => setOpen(rows.hidden));
  return panel;
}

function storeRow(item) {
  const row = tpl("tpl-store-row");
  row.querySelector('[data-slot="label"]').textContent = item.label;
  row.querySelector('[data-slot="path"]').textContent = item.path;
  const size = item.maxBytes
    ? `${formatBytes(item.bytes)} of ${formatBytes(item.maxBytes)}`
    : formatBytes(item.bytes);
  row.querySelector('[data-slot="size"]').textContent = item.over ? `${size} — over cap` : size;
  // Only an over-cap store is worth colouring; a store at 3% and one at 80% are both fine, and
  // shading the difference would imply an action the user does not need to take.
  row.querySelector('[data-slot="dot"]').classList.add(item.over ? "off" : "on");
  return row;
}

// Duplicated from modules/retention/policy.mjs rather than imported: this file is served to the
// browser, which cannot resolve a repo-relative Node module path. Keep the two in step — a store
// shown as "18.8MB" in the portal and something else in the CLI reads as two different numbers.
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function permissionRow(item, callbacks) {
  // Both permission kinds render through the same row; behaviorRow branches internally only on
  // how the entry is addressed when mutating it.
  if (item.kind === "behavior" || item.kind === "arbitrary-item") return behaviorRow(item, callbacks);
  const row = tpl("tpl-permission-row");
  row.querySelector('[data-slot="content"]').remove();
  return row;
}

function configItemElement(item, actions) {
  const node = document.createElement("config-item");
  node.item = item;
  node.actions = actions;
  return node;
}

// Every package category renders through one template, driven by the section data the server
// already sends. No per-category branch: a category added to the manifest appears here without a
// portal edit, and none can be silently dropped for lacking a template.
//
// Bulk sections (section.bulkToggle): the head carries one <config-toggle> — the SAME switch
// chrome as the per-package rows — whose state is derived from the section's items on every
// render, so individual and group selections can never disagree (bidirectional by construction:
// any mutation re-renders from the fresh server snapshot). All-on => on + "Deselect All";
// anything else (mixed or all-off) => off + "Select All".
export function standardSection(section, { onInspectClick, onToggle, onBulkToggle, contextCost }) {
  const panel = tpl("tpl-section-packages");
  panel.classList.toggle("wide", !!section.wide);
  toggleSlot(panel, "heading", true, section.category);
  toggleSlot(panel, "description", !!section.description, section.description);
  toggleSlot(panel, "footnote", !!section.footnote, section.footnote);

  const itemsSlot = panel.querySelector('[data-slot="items"]');
  itemsSlot.replaceChildren(
    ...section.items.map((item) => configItemElement(item, { onInspect: onInspectClick, onToggle, contextCost })),
  );

  const bulkWrap = panel.querySelector('[data-slot="bulk"]');
  if (section.bulkToggle && typeof onBulkToggle === "function") {
    const toggleableItems = section.items.filter((item) => item.toggle);
    const activeCount = toggleableItems.filter((item) => item.active).length;
    const allOn = toggleableItems.length > 0 && activeCount === toggleableItems.length;
    const label = panel.querySelector('[data-slot="bulk-label"]');
    label.textContent = allOn ? "Deselect All" : "Select All";
    // createElement (not the template clone): a cloned-but-unconnected custom element upgrades
    // only on connect, so property assignments before that would land as own properties and
    // permanently shadow the class's accessors (the exact trap config-item.js avoids the same
    // way). createElement on a registered tag upgrades synchronously.
    const bulkToggle = document.createElement("config-toggle");
    bulkToggle.item = { active: allOn, label: `${section.category}: ${label.textContent}` };
    bulkToggle.statusSlot = panel.querySelector('[data-slot="bulk-status"]');
    // Each group action captures exactly the rows it owns; the handler flips them all to one
    // target (from mixed or all-off => select all; from all-on => disable all).
    bulkToggle.onToggle = (item, enabled) => onBulkToggle(section, toggleableItems, enabled);
    panel.querySelector('[data-slot="bulk-toggle"]').replaceWith(bulkToggle);
    bulkWrap.hidden = false;
  }

  // While a batch is in flight every per-row toggle in THIS section is disabled, so a click can
  // never interleave with the batch. (config-toggle re-renders and re-enables itself once the
  // snapshot-driven re-render replaces the panel.)
  if (isBulkInFlight()) {
    for (const toggle of panel.querySelectorAll("config-toggle")) {
      toggle.disabled = true;
    }
  }
  return panel;
}

export function contextWarnings(snap) {
  const entries = tokenWarningEntries(snap);
  if (!entries.length) return null;
  const panel = tpl("tpl-context-warnings");
  const hasHigh = entries.some((entry) => entry.spec.level === "high");
  // <portal-notice> owns the callout chrome now; escalate to the alert (red) variant when any
  // element is in high token use, otherwise the default warning (amber) tint.
  panel.setAttribute("variant", hasHigh ? "alert" : "warning");
  panel.querySelector('[data-slot="title"]').textContent = hasHigh
    ? "The following elements have a high token use:"
    : "The following elements have elevated token use:";
  panel.querySelector('[data-slot="items"]').replaceChildren(...entries.map(tokenWarningItem));
  return panel;
}

// The "install a supported harness" warning banner — rendered from the SHARED module
// (harness-warning.js + tpl-harness-notice) so /config and /tokens can never drift. Null when
// the machine has at least one active harness.
export function harnessWarning(snap, options) {
  return harnessWarningElement(snap, options);
}

// Persistent intro above the package sections. Always rendered (not an ephemeral onboarding
// banner) — it explains what the package manager provides, whatever the onboarding state.
export function packagesIntro() {
  return tpl("tpl-packages-intro");
}

function wireInspectButton(btn, kind, id, harness, label, onInspectClick) {
  btn.textContent = label;
  btn.addEventListener("click", () => onInspectClick({ kind, id, harness, label }));
}

function configUsageCell(harness, snap) {
  const cell = tpl("tpl-config-usage-cell");
  applyTokenChip(cell.querySelector("[data-slot=chip]"), harnessChipSpec(snap.contextCost, harness.id));
  return cell;
}

function configRulesCell(harness, snap, onInspectClick) {
  const cell = tpl("tpl-config-rules-cell");
  wireInspectButton(cell.querySelector("[data-slot=button]"), "live-rules", "agent-rules", harness.id, harness.rulesFile, onInspectClick);
  applyWarningTokenChip(cell.querySelector("[data-slot=chip]"), rulesChipSpec(snap.contextCost, harness.id));
  return cell;
}

function configConfigCell(harness, snap, onInspectClick) {
  const cell = tpl("tpl-config-config-cell");
  wireInspectButton(cell.querySelector("[data-slot=button]"), "config-file", `${harness.id}-settings`, undefined, harness.settingsFile, onInspectClick);
  const chip = cell.querySelector("[data-slot=drift]");
  const spec = resolveDriftChip(snap.rootConfig, harness.id);
  if (spec) {
    chip.hidden = false;
    chip.className = "drift-chip " + spec.cls;
    chip.textContent = spec.label;
    chip.title = spec.title;
  }
  return cell;
}

function configHooksCell(harness, onInspectClick) {
  const cell = tpl("tpl-config-hooks-cell");
  wireInspectButton(cell.querySelector("[data-slot=button]"), "harness-hooks", "hooks", harness.id, harness.hooksFile, onInspectClick);
  return cell;
}

export function configFiles(snap, { onInspectClick }) {
  const harnesses = presentedHarnesses(snap).filter((harness) => harness.enabled !== false);
  if (harnesses.length === 0) return null;
  const panel = tpl("tpl-config-files");
  panel.querySelector(".config-grid").style.setProperty("--provider-count", harnesses.length);
  const head = panel.querySelector("[data-slot=head]");
  const rows = {
    usage: panel.querySelector("[data-slot=row-usage]"),
    rules: panel.querySelector("[data-slot=row-rules]"),
    config: panel.querySelector("[data-slot=row-config]"),
    hooks: panel.querySelector("[data-slot=row-hooks]"),
  };
  for (const harness of harnesses) {
    head.append(fill(tpl("tpl-config-header-cell"), { label: harness.displayName }));
    rows.usage.append(configUsageCell(harness, snap));
    rows.rules.append(configRulesCell(harness, snap, onInspectClick));
    rows.config.append(configConfigCell(harness, snap, onInspectClick));
    rows.hooks.append(configHooksCell(harness, onInspectClick));
  }
  return panel;
}

// --------------------------------------------------------------------------- maintenance

// Managed cleanup panel. Preview -> explicit confirm -> result, all server-driven: the browser
// never decides what gets removed, it only renders the plan the server produced and posts back a
// confirmation. Workspace deletion is deliberately not offered here (see index.html).
export function maintenancePanel({ onPreview, onExecute }) {
  const panel = tpl("tpl-maintenance");
  const detail = panel.querySelector("[data-slot=detail]");
  const previewBtn = panel.querySelector("[data-slot=preview]");

  previewBtn.addEventListener("click", async () => {
    previewBtn.disabled = true;
    try {
      const preview = await onPreview();
      detail.replaceChildren(renderPreview(preview, { onExecute, detail, previewBtn }));
      detail.hidden = false;
    } catch (err) {
      detail.replaceChildren(errorText(err));
      detail.hidden = false;
    } finally {
      previewBtn.disabled = false;
    }
  });

  return panel;
}

function renderPreview(preview, { onExecute, detail, previewBtn }) {
  const node = tpl("tpl-maintenance-preview");
  const preserved = node.querySelector("[data-slot=preserved]");
  preserved.textContent = preview.workspace
    ? `Your workspace will be preserved: ${preview.workspace}`
    : "No workspace found.";

  const list = node.querySelector("[data-slot=removals]");
  for (const line of preview.removals || []) {
    const li = document.createElement("li");
    li.textContent = line;
    list.append(li);
  }
  if (!(preview.removals || []).length) {
    const li = document.createElement("li");
    li.textContent = "Nothing managed left to remove.";
    list.append(li);
  }

  const errorEl = node.querySelector("[data-slot=error]");
  node.querySelector("[data-slot=cancel]").addEventListener("click", () => {
    detail.hidden = true;
    detail.replaceChildren();
  });

  const confirmBtn = node.querySelector("[data-slot=confirm]");
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    errorEl.textContent = "";
    try {
      const result = await onExecute();
      detail.replaceChildren(renderResult(result));
      previewBtn.disabled = true;
    } catch (err) {
      errorEl.textContent = (err && err.message) || String(err);
      confirmBtn.disabled = false;
    }
  });

  return node;
}

function renderResult(result) {
  const node = tpl("tpl-maintenance-result");
  node.querySelector("[data-slot=preserved]").textContent = result.workspace
    ? `Your workspace was preserved: ${result.workspace}`
    : "";
  node.querySelector("[data-slot=npm]").textContent = result.npmCommand || "";
  return node;
}

function errorText(err) {
  const div = document.createElement("div");
  div.className = "maintenance-error";
  div.textContent = (err && err.message) || String(err);
  return div;
}
