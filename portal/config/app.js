// --------------------------------------------------------------------------- behavior view
//
// The user-facing section model is computed ONCE, server-side, in buildBehaviorView() (config.mjs)
// and shipped in the snapshot as snap.behaviorView. Items carry web fields (toggle, inspect, urls)
// and terminal fields (hint); this page omits the telemetry package because token tracking is
// managed from Settings and Tokens.
//
// Wiring only: DOM refs, event listeners, and orchestration between api.js (server calls),
// state.js (constants/pure lookups), and templates.js (markup). No markup construction should
// live in this file — add a template in templates.js instead.

import { portalSetUpdatedAt, portalHideLoading } from "/portal/shared/api.js";
import * as api from "./api.js";
import * as tmpl from "./templates.js";
import { createConfigModal } from "./panels.js";
import { snapshotChanged, inspectChipSpecs, setBulkInFlight, isBulkInFlight } from "./state.js";

const modal = createConfigModal();
// Keep the warning renderer/template available while the Agents-page banner is temporarily hidden.
const SHOW_CONTEXT_WARNINGS = false;

function openSourceModal(inspect, itemCost = null) {
  const rules = lastSnapshot?.globals?.rules || {};
  const harnesses = lastSnapshot?.harnesses || [];
  const chips = inspectChipSpecs(inspect, itemCost, lastSnapshot);
  return modal.openSource(inspect, { rules, harnesses, onDefaultClick: modal.openSnapshot, chips });
}

// POST a bucket change for either a named behavior (behaviorId) or an arbitrary command
// (tokens), re-rendering from the returned snapshot on success. Shared by behaviorRow and the
// arbitrary-command list so both paths hit the exact same endpoint contract.
async function applyBucket(payload, errSlot) {
  errSlot.textContent = "";
  try {
    const data = await api.applyPermission(payload);
    if (data.config) applySnapshot(data.config);
    return true;
  } catch (e) {
    errSlot.textContent = e.message;
    return false;
  }
}

async function handleToggle(item, enabled) {
  const data = await api.toggleItem(item.toggle, item.id, enabled);
  if (data.config) applySnapshot(data.config); // re-render from the authoritative post-mutation snapshot
}

// Section-level batch (bulkToggle sections): one request for the whole section, server applies
// mutations + the single reconcile pass and returns the fresh snapshot. While it runs, every
// toggle in bulk sections is disabled (client flag + server 409 backstop), so nothing can
// interleave. On any failure the flag clears and the switch reverts via the fresh snapshot —
// the error surfaces on the group toggle's own status slot (errSlot) like per-row errors do.
async function handleBulkToggle(section, items, enabled) {
  setBulkInFlight(true);
  try {
    const data = await api.bulkTogglePackages(
      items.map((item) => item.id),
      enabled,
    );
    if (data.config) applySnapshot(data.config);
  } catch (err) {
    console.error(err);
    if (err.status === 409) {
      // Another batch won the race (second tab, or double-click that slipped past the disable).
      // The poll/state it reflects is authoritative — re-sync instead of surfacing an error.
      applySnapshot(await api.fetchConfig());
    } else {
      showError(err);
    }
  } finally {
    setBulkInFlight(false);
    // Re-enable controls even when the snapshot didn't change (e.g. rejected no-op batch).
    render(lastSnapshot);
  }
}

// --------------------------------------------------------------------------- section renderers

function renderPermissionsSection(section) {
  return tmpl.permissionsSection(section, { onApplyBucket: applyBucket });
}

function renderStandardSection(section, contextCost) {
  return tmpl.standardSection(section, {
    onInspectClick: openSourceModal,
    onToggle: handleToggle,
    onBulkToggle: handleBulkToggle,
    contextCost,
  });
}

function renderSection(section, contextCost) {
  if (section.kind === "permissions") return renderPermissionsSection(section);
  if (section.kind === "stores") return tmpl.storesSection(section);
  return renderStandardSection(section, contextCost);
}

function render(snap) {
  const main = document.getElementById("main");
  // Use the server-owned section model, excluding the telemetry package from the Agents surface.
  const view = (snap.behaviorView || [])
    .map((section) => section.categoryId
      ? { ...section, items: section.items.filter((item) => item.id !== "telemetry") }
      : section)
    .filter((section) => !section.categoryId || section.items.length > 0);
  // Package-category sections (everything the packages intro describes) vs the non-package
  // sections that follow. The intro sits between the harness file grid and the first package
  // section; the harness-warning notice (no active harness) stays at the top of the page.
  const packageSections = view.filter((section) => section.categoryId);
  const otherSections = view.filter((section) => !section.categoryId);
  main.replaceChildren(
    ...[
      tmpl.harnessWarning(lastSetup || snap, { onCheck: refreshHarnesses }),
      ...(SHOW_CONTEXT_WARNINGS ? [tmpl.contextWarnings(snap)] : []),
      tmpl.configFiles(snap, { onInspectClick: openSourceModal }),
      tmpl.packagesIntro(),
    ].filter(Boolean),
    ...packageSections.map((section) => renderSection(section, snap.contextCost)).filter(Boolean),
    ...otherSections.map((section) => renderSection(section, snap.contextCost)).filter(Boolean),
    // Last panel on the page: app-level lifecycle, well below the day-to-day controls.
    tmpl.maintenancePanel({
      onPreview: api.fetchUninstallPreview,
      onExecute: api.executeUninstall,
    }),
  );
}

// --------------------------------------------------------------------------- poll

let last = null;
let lastSnapshot = null;
let lastSetup = null;
function applySnapshot(snap) {
  lastSnapshot = snap;
  const changed = snapshotChanged(last, snap);
  if (changed) {
    last = changed;
    render(snap);
  }
  portalSetUpdatedAt(new Date(), { cadenceMs: POLL_INTERVAL_MS });
}
function showError(err) {
  console.error(err);
}

async function load() {
  try {
    const [snap, setup] = await Promise.all([api.fetchConfig(), api.fetchSetupState()]);
    lastSetup = setup;
    applySnapshot(snap);
  } catch (e) {
    showError(e);
  } finally {
    portalHideLoading();
  }
}

async function refreshHarnesses() {
  await api.refreshHarnesses();
  const [snap, setup] = await Promise.all([api.fetchConfig(), api.fetchSetupState()]);
  lastSetup = setup;
  applySnapshot(snap);
}

const POLL_INTERVAL_MS = 10000;

load();
setInterval(load, POLL_INTERVAL_MS);
// Theme toggle + nav live in the shared /portal/shared/theme.js. The config page has no
// canvas to redraw, so it needs no "portal:themechange" listener.
