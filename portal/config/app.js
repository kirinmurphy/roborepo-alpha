// --------------------------------------------------------------------------- behavior view
//
// The user-facing section model is computed ONCE, server-side, in buildBehaviorView() (config.mjs)
// and shipped in the snapshot as snap.behaviorView. Items carry web fields (toggle, inspect, urls)
// and terminal fields (hint). Token telemetry and its Codex hook warning live on Settings, not here.
//
// Wiring only: DOM refs, event listeners, and orchestration between api.js (server calls),
// state.js (constants/pure lookups), and templates.js (markup). No markup construction should
// live in this file — add a template in templates.js instead.

import { portalSetUpdatedAt, portalHideLoading } from "/portal/shared/api.js";
import * as api from "./api.js";
import * as tmpl from "./templates.js";
import { createConfigModal } from "./panels.js";
import { snapshotChanged, inspectChipSpecs, setBulkInFlight, isBulkInFlight } from "./state.js";
import { clearRepositoryScope, currentRepositoryScope } from "/portal/shared/repository-scope.js";
import { onRepositoryScopeResolved, repositoryScopeUnavailableNotice } from "/portal/shared/repository-scope-selector.js";

const modal = createConfigModal();
// Keep the warning renderer/template available while the Agents-page banner is temporarily hidden.
const SHOW_CONTEXT_WARNINGS = false;
// Packages whose on/off control lives on another page. Settings owns token telemetry, so a second
// toggle here would only duplicate it; the terminal `roborepo config` view still lists it.
const PACKAGES_CONTROLLED_ELSEWHERE = new Set(["telemetry"]);

function withoutPackagesControlledElsewhere(view) {
  return view
    .map((section) => (section.categoryId
      ? { ...section, items: section.items.filter((item) => !PACKAGES_CONTROLLED_ELSEWHERE.has(item.id)) }
      : section))
    .filter((section) => !section.categoryId || section.items.length > 0);
}

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
  // Scoped to a repository, the page shows only what is true for it: a coming-soon splash, or the
  // unavailable state. Until the selector has resolved the scope, nothing global is drawn either.
  const scope = currentRepositoryScope();
  if (scope) {
    const resolution = scopeResolution?.scope === scope ? scopeResolution : null;
    if (resolution?.status === "repository") {
      main.replaceChildren(tmpl.repositorySplash(clearRepositoryScope));
    } else if (resolution?.status === "unavailable") {
      main.replaceChildren(repositoryScopeUnavailableNotice());
    }
    return;
  }
  const view = withoutPackagesControlledElsewhere(snap.behaviorView || []);
  // Package-category sections (everything the packages intro describes) vs the non-package
  // sections that follow. The intro sits between the harness file grid and the first package
  // section; the harness-warning notice (no active harness) stays at the top of the page.
  const packageSections = view.filter((section) => section.categoryId);
  const otherSections = view.filter((section) => !section.categoryId);
  main.replaceChildren(
    ...[
      tmpl.harnessWarning(lastSetup || snap, { onRefreshed: reloadSetup, watch: false }),
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
let scopeResolution = null;
// The splash and the global view are whole-page swaps, so a scope change redraws even when the
// config snapshot itself has not changed.
onRepositoryScopeResolved((resolution) => {
  scopeResolution = resolution;
  if (lastSnapshot) render(lastSnapshot);
});
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

// The banner runs the harness check itself; this only re-reads what it changed. The page's own
// poll already re-reads setup state, so the banner does not watch it separately.
async function reloadSetup() {
  const [snap, setup] = await Promise.all([api.fetchConfig(), api.fetchSetupState()]);
  lastSetup = setup;
  applySnapshot(snap);
}

const POLL_INTERVAL_MS = 10000;

load();
setInterval(load, POLL_INTERVAL_MS);
// Theme toggle + nav live in the shared /portal/shared/theme.js. The config page has no
// canvas to redraw, so it needs no "portal:themechange" listener.
