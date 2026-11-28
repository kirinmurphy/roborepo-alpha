// --------------------------------------------------------------------------- behavior view
//
// The user-facing section model is computed ONCE, server-side, in buildBehaviorView() (config.mjs)
// and shipped in the snapshot as snap.behaviorView. Items carry web fields (toggle, inspect, urls)
// and terminal fields (hint). Token telemetry and its Codex hook warning live on Settings, not here.
//
// Wiring only: DOM refs, event listeners, and orchestration between api.js (server calls),
// state.js (constants/pure lookups), and templates.js (markup). No markup construction should
// live in this file — add a template in templates.js instead.

import { portalGetJson, portalSetUpdatedAt, portalHideLoading } from "/portal/shared/api.js";
import { offerHookReview } from "/portal/shared/hook-review-offer.js";
import * as api from "./api.js";
import * as tmpl from "./templates.js";
import { createConfigModal, createDisableDependentsDialog, createRecommendationsDialog } from "./panels.js";
import { snapshotChanged, inspectChipSpecs, contentsEntryChipSpec, setBulkInFlight, isBulkInFlight } from "./state.js";
import { clearRepositoryScope, currentRepositoryScope } from "/portal/shared/repository-scope.js";
import { onRepositoryScopeResolved, repositoryScopeUnavailableNotice } from "/portal/shared/repository-scope-selector.js";
import { onRepositoriesChanged } from "/portal/shared/repository-list-change.js";

const modal = createConfigModal();
const recommendationsDialog = createRecommendationsDialog();
const disableDependentsDialog = createDisableDependentsDialog();
// Packages whose on/off control lives on another page. Settings owns token telemetry and each Git
// host's agent account (its package id comes from the server's provider list), so a second toggle
// here would only duplicate them (and this one could switch agents to a bot that is not set up
// yet); the terminal `roborepo config` view still lists them.
const agentAccountPackages = await portalGetJson("/api/forge-providers")
  .then((providers) => providers.map((provider) => provider.packageId).filter(Boolean))
  .catch(() => []);
const PACKAGES_CONTROLLED_ELSEWHERE = new Set(["telemetry", ...agentAccountPackages]);

function withoutPackagesControlledElsewhere(view) {
  return view
    .map((section) => (section.categoryId
      ? { ...section, items: section.items.filter((item) => !PACKAGES_CONTROLLED_ELSEWHERE.has(item.id)) }
      : section))
    .filter((section) => !section.categoryId || section.items.length > 0);
}

function openSourceModal(inspect, itemCost = null, { builtIn = false, back = null, requires = [] } = {}) {
  if (inspect?.kind === "package-contents") return openContentsModal(inspect, itemCost, { builtIn, back, requires });
  const rules = lastSnapshot?.globals?.rules || {};
  const harnesses = lastSnapshot?.harnesses || [];
  const chips = inspectChipSpecs(inspect, itemCost, lastSnapshot, { builtIn });
  const reopen = () => openSourceModal(inspect, itemCost, { builtIn, back, requires });
  return modal.openSource(inspect, {
    rules, harnesses, onDefaultClick: modal.openSnapshot, chips, back, requires, onRequire: openRequiredSource(reopen, requires),
  });
}

// A required package opens its source or contents, with Back returning to the referring package.
// A reference with no inspect target stays plain text.
function openRequiredSource(reopen, requires) {
  return (ref) => openSourceModal(ref.inspect, ref.contextCost, {
    builtIn: ref.builtIn,
    back: reopen,
    requires: requires.filter((other) => ref.requiredIds?.includes(other.id)),
  });
}

// Contents list the package's resources and requirements. A resource opens its own source, with
// Back returning to the contents.
function openContentsModal(inspect, itemCost, { builtIn, back = null, requires = [] }) {
  const reopen = () => openContentsModal(inspect, itemCost, { builtIn, back, requires });
  modal.showContents(inspect, {
    back,
    chips: inspectChipSpecs(inspect, itemCost, lastSnapshot, { builtIn }),
    entryChipSpec: (entry) => contentsEntryChipSpec(entry, lastSnapshot, { builtIn }),
    onSelect: (entry) => openSourceModal(entry.inspect, entry.contextCost, { builtIn, back: reopen }),
    requires,
    onRequire: openRequiredSource(reopen, requires),
  });
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

// `offer: false` is for switches inside the recommendations dialog: a recommendation is offered
// once, when its parent is turned on, so turning one on there opens no further offer.
async function handleToggle(item, enabled, { offer = true } = {}) {
  let data;
  try {
    data = await api.toggleItem(item.toggle, item.id, enabled);
  } catch (err) {
    if (enabled || err.code !== "INCLUDED_IN_SELECTED") throw err;
    data = await disableWithDependents(item, err.details?.includedBy || []);
  }
  if (data.config) applySnapshot(data.config); // re-render from the authoritative post-mutation snapshot
  void offerHookReview(data.hookHarnesses);
  if (offer && enabled && data.recommendations?.length) await offerRecommendations(item, data.recommendations);
}

// Turning off a package that packages the user turned on include asks whether to turn those off
// too. Declining throws an error with no message: the switch flips back and shows nothing, since
// nothing changed.
async function disableWithDependents(item, includedBy) {
  const confirmed = await disableDependentsDialog.confirm(item.label, includedBy);
  if (!confirmed) throw new Error("");
  return api.toggleItem(item.toggle, item.id, false, { cascade: true });
}

// An enable that left recommended packages off lists them as ordinary rows, whose switches apply
// at once and re-render the page the same way any toggle does.
// A recommendation with no row on the page has no switch to show, so it is left out, and the
// dialog does not open when none remain.
function offerRecommendations(item, recommendations) {
  const shown = recommendations.filter((rec) => packageRow(rec.id));
  if (shown.length === 0) return Promise.resolve();
  return recommendationsDialog.ask(item.label, shown, {
    rowFor: packageRow,
    renderRow: (row) => tmpl.configItemElement(row, {
      onInspect: openSourceModal,
      onToggle: (target, enabled) => handleToggle(target, enabled, { offer: false }),
      onDependency: openDependency,
      offersOnEnable: false,
      contextCost: lastSnapshot?.contextCost || null,
    }),
  });
}

// A package's row in the latest snapshot, wherever its section is.
function packageRow(id) {
  for (const section of lastSnapshot?.behaviorView || []) {
    const row = section.categoryId && section.items.find((item) => item.id === id);
    if (row) return row;
  }
  return null;
}

// A package in a row's Dependencies opens its source, listing its own requirements.
function openDependency(ref) {
  return openSourceModal(ref.inspect, ref.contextCost, { builtIn: ref.builtIn, requires: ref.requires || [] });
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
    // One read and at most one offer for the whole batch, not one per package.
    void offerHookReview(data.hookHarnesses);
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
    onDependency: openDependency,
    contextCost,
  });
}

function renderSection(section, contextCost) {
  if (section.kind === "permissions") return renderPermissionsSection(section);
  if (section.kind === "stores") return tmpl.storesSection(section);
  return renderStandardSection(section, contextCost);
}

// --------------------------------------------------------------------------- repo inspector

const GIT_STATUS_TEXT = {
  tracked: "Tracked in Git",
  untracked: "Untracked",
  ignored: "Ignored by Git (local only)",
  unavailable: "Git status unavailable",
};

function gitLabel(git) {
  const text = GIT_STATUS_TEXT[git?.status] || GIT_STATUS_TEXT.unavailable;
  return git?.modified ? `${text}, locally modified` : text;
}

// The inventory for the scope it was requested for. A response for an earlier scope is dropped,
// so switching repos while a request is pending can never show the previous repo's files.
let repoInventory = null;
let repoInventorySeq = 0;

// `keepShown` re-reads behind the listing already on screen instead of swapping in the loading state.
async function loadRepositoryInventory(scope, { keepShown = false } = {}) {
  const seq = ++repoInventorySeq;
  if (!keepShown || repoInventory?.scope !== scope) {
    repoInventory = { scope, status: "loading" };
    renderScoped();
  }
  try {
    const data = await api.fetchRepositoryInventory(scope);
    if (seq !== repoInventorySeq || currentRepositoryScope() !== scope) return;
    repoInventory = { scope, status: "ok", data };
  } catch (error) {
    if (seq !== repoInventorySeq || currentRepositoryScope() !== scope) return;
    repoInventory = { scope, status: "error", message: error.message };
  }
  renderScoped();
}

// A row stands for one file, or one skill several harnesses carry; the popup reads the copy the
// inventory read and lists every location.
function openRepositoryEntry(group) {
  const scope = repoInventory?.scope;
  const { primary } = group;
  modal.openRepositorySource(group, { load: () => api.fetchRepositorySource(scope, primary.id), gitLabel });
}

function renderScoped() {
  const scope = currentRepositoryScope();
  const resolution = scopeResolution?.scope === scope ? scopeResolution : null;
  if (!scope || resolution?.status !== "repository") return;
  const main = document.getElementById("main");
  const inventory = repoInventory?.scope === scope ? repoInventory : null;
  if (!inventory || inventory.status === "loading") {
    main.replaceChildren(tmpl.repositoryInspectorLoading());
  } else if (inventory.status === "error") {
    main.replaceChildren(tmpl.repositoryInspectorError(inventory.message));
  } else if (inventory.data.status === "checkout-unavailable") {
    main.replaceChildren(tmpl.repositoryCheckoutUnavailable(inventory.data, clearRepositoryScope));
  } else {
    // Total Usage adds the global startup estimate, so the inspector redraws when a snapshot lands.
    main.replaceChildren(...tmpl.repositoryInspector(inventory.data, {
      onOpen: openRepositoryEntry,
      onViewGlobal: clearRepositoryScope,
      contextCost: lastSnapshot?.contextCost || null,
    }));
  }
  portalHideLoading();
}

function render(snap) {
  const main = document.getElementById("main");
  // Scoped to a repository, the page shows only what is true for it: the repo inspector, or the
  // unavailable state. Until the selector has resolved the scope, nothing global is drawn either.
  const scope = currentRepositoryScope();
  if (scope) {
    const resolution = scopeResolution?.scope === scope ? scopeResolution : null;
    if (resolution?.status === "repository") {
      renderScoped();
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
// The inspector and the global view are whole-page swaps, so a scope change redraws even when the
// config snapshot itself has not changed. A new scope closes any open preview and drops pending
// responses for the old one before the new inventory is requested.
onRepositoryScopeResolved((resolution) => {
  const previous = scopeResolution?.scope ?? null;
  scopeResolution = resolution;
  if (resolution.scope !== previous) {
    modal.reset();
    repoInventorySeq += 1;
    repoInventory = null;
  }
  if (resolution.status === "repository" && repoInventory?.scope !== resolution.scope) {
    void loadRepositoryInventory(resolution.scope);
    return;
  }
  if (lastSnapshot) render(lastSnapshot);
  else renderScoped();
});
// A repo that stays listed after a Manage Repos change can still have moved or been refreshed, so the
// inspector re-reads it. A selected repo that left the list was already cleared to All repos, and
// the selector's resolution redraws the global page.
onRepositoriesChanged(() => {
  const scope = currentRepositoryScope();
  if (!scope || scopeResolution?.scope !== scope || scopeResolution.status !== "repository") return;
  return loadRepositoryInventory(scope, { keepShown: true });
});
function applySnapshot(snap) {
  lastSnapshot = snap;
  const changed = snapshotChanged(last, snap);
  if (changed) {
    last = changed;
    render(snap);
    recommendationsDialog.refresh();
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
