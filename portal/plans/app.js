// Wiring only: DOM refs, event listeners, and orchestration between api.js (server calls),
// state.js (filtering/sorting/matching), and templates.js (markup). No markup construction
// should live in this file — add a template in templates.js instead.

import {
  portalSetUpdatedAt,
  portalHideLoading,
  portalWireBackdropClose,
} from "/portal/shared/api.js";
import * as api from "./api.js";
import * as tmpl from "./templates.js";
import { createRepositorySourcesDialog } from "/portal/shared/repository-sources-dialog.js";
import { createPlanDrawer } from "./plan-drawer.js";
import { createBlockersPopover } from "./blockers-popover.js";
import { mountOverflowNav } from "/portal/shared/overflow-nav.js";
import { clearRepositoryScope, currentRepositoryScope, isRepositoryScopeUnavailable, onRepositoryScopeChange } from "/portal/shared/repository-scope.js";
import { onRepositoryScopeResolved, repositoryScopeUnavailableNotice } from "/portal/shared/repository-scope-selector.js";
import {
  FILTER_IDS,
  FILTER_DEFAULTS,
  FILTER_OPTION_DEFS,
  LIFECYCLE_LABELS,
  filteredPlans,
  sortForLifecycle,
  isVisible,
  mergedPlanBranches,
  replaceRecord,
  filteredListActionFor,
  resolveBlockers,
  optionCounts,
  optionLabel,
  repositoryContext,
  lifecycleFromSearchParams,
  urlForLifecycle,
} from "./state.js";

const LIFECYCLE_ORDER = ["backlog", "active", "completed", "archived"];
// Rarely-visited lifecycles sit behind the row's ⋮ menu rather than taking a tab.
const SECONDARY_LIFECYCLES = new Set(["completed", "archived", "unclassified"]);

const state = {
  snapshot: null,
  filters: { ...FILTER_DEFAULTS },
  selectedLifecycle: lifecycleFromSearchParams(new URLSearchParams(location.search)),
  // Active plans whose worktree has merged, from the same overview Home renders (see
  // mergedPlanBranches); keyed by plan key.
  mergedPlans: new Map(),
};

const groupsEl = document.getElementById("groups");
const warningsEl = document.getElementById("warnings");
const bannerEl = document.getElementById("package-banner");
const plansHeaderEl = document.getElementById("plans-header");
const filtersToggleEl = document.getElementById("filters-toggle");
const filtersDialogEl = document.getElementById("filters-dialog");
const filtersUpdateEl = document.getElementById("filters-update");
const filterChipsEl = document.getElementById("filter-chips");
const lifecycleBarEl = document.getElementById("lifecycle-bar");
const lifecycleTitleEl = document.getElementById("lifecycle-title");
const lifecycleTabsEl = document.getElementById("lifecycle-tabs");
const onboardingEl = document.getElementById("plans-onboarding");
// Below 640px the tabs collapse into one menu whose trigger names the selected lifecycle.
const lifecycleNav = mountOverflowNav(lifecycleTabsEl, {
  menuLabel: "More lifecycles",
  collapseBelow: 640,
  collapsedFace: "current",
  highlightSecondarySelection: false,
});
let syncPollTimer = null;
// Scope changes can overlap; only the latest load may paint, so a slow response for the previous
// repository never replaces the current one.
let loadSequence = 0;
let repositorySyncPending = false;
let repositorySyncState = "synced";
let repositoryAutoDiscoveryEnabled = false;

// Plans no longer owns which repositories exist: the header count and the onboarding states open the
// shared Manage repositories dialog, and any change there re-reads the Plans snapshot.
const sourcesDialog = createRepositorySourcesDialog({
  onPending: setPlansSyncPending,
  onChange: () => api.refreshSnapshot().then(applySnapshot).catch(showLoadError),
});
const onboarding = {
  onEnable: () => sourcesDialog.enableAutoDiscovery(),
  onAddFolder: () => sourcesDialog.open({ addFolder: true }),
  onManage: () => sourcesDialog.open(),
};
// The shared plan detail drawer (plan-drawer.js) — the same popup Home opens. It owns the copy
// toast and the plan-write skill modal, so the page reuses those rather than creating its own.
const planDrawer = createPlanDrawer({
  getPlans: () => state.snapshot.plans,
  getPlanWritePackage: () => state.snapshot.planWritePackage,
  mergeFor: (key) => state.mergedPlans.get(key) || null,
  onEnablePackage: enablePackage,
  onError: showError,
});
const skillModal = planDrawer.skillModal;
const outcomeToast = planDrawer.toast;
const blockersPopover = createBlockersPopover(document.getElementById("blockers-popover"), {
  onOpenPlan: (key) => openPlan(key),
});

bindStaticControls();
load();
void refreshOverview();
// The shared header selector (and back/forward) changes the scope without a reload; filters and
// the lifecycle tab are page state and stay as they are.
onRepositoryScopeChange(() => void load());
// The empty state names the selected repository, which the selector learns after the snapshot.
let scopedRepositoryName = null;
onRepositoryScopeResolved(({ scope, repository }) => {
  scopedRepositoryName = scope === currentRepositoryScope() ? repository?.displayName ?? null : null;
  if (state.snapshot && !onboardingEl.hidden) render();
});

function bindStaticControls() {
  const refreshEl = document.getElementById("refresh");
  const refreshIconEl = refreshEl.querySelector("portal-icon");
  const refreshSpinnerEl = refreshEl.querySelector(".spinner");
  refreshEl.addEventListener("click", () => {
    refreshEl.disabled = true;
    refreshIconEl.hidden = true;
    refreshSpinnerEl.hidden = false;
    void refreshOverview();
    api.refreshSnapshot().then(applySnapshot).catch(showLoadError).finally(() => {
      refreshEl.disabled = false;
      refreshIconEl.hidden = false;
      refreshSpinnerEl.hidden = true;
    });
  });
  // The popup drafts: the board waits for Update, but each control's option counts follow the
  // draft as it changes, so the other filters show what is left to pick.
  for (const id of FILTER_IDS) {
    document.getElementById(id).addEventListener(id === "search" ? "input" : "change", onFilterDraftChange);
  }
  document.getElementById("search").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !filtersUpdateEl.disabled) filtersUpdateEl.click();
  });
  filtersToggleEl.addEventListener("click", () => {
    discardFilterDraft();
    filtersDialogEl.showModal();
  });
  filtersUpdateEl.addEventListener("click", applyFilterDraft);
  document.getElementById("filters-cancel").addEventListener("click", () => filtersDialogEl.close());
  document.getElementById("filters-close").addEventListener("click", () => filtersDialogEl.close());
  portalWireBackdropClose(filtersDialogEl, () => filtersDialogEl.close());
  // Esc, Cancel, the X, and the backdrop all close the same way, and an unapplied draft goes with it.
  filtersDialogEl.addEventListener("close", discardFilterDraft);
  filterChipsEl.addEventListener("chip-remove", (event) => resetFilter(event.detail));
  // One delegated listener each for cards (bubbles through groupsEl) and the drawer's mounted
  // <plan-status> — both dispatch the same `plan-change` event, so both route through the same
  // mutation orchestrator.
  groupsEl.addEventListener("plan-change", (event) => handlePlanChange(event.detail));
  document.getElementById("drawer-status-mount").addEventListener("plan-change", (event) => handlePlanChange(event.detail));
  // Same delegation for the "blocked by N" badge — card and drawer both mount <plan-status>.
  groupsEl.addEventListener("blocked-click", (event) => openBlockersPopover(event.detail));
  document.getElementById("drawer-status-mount").addEventListener("blocked-click", (event) => openBlockersPopover(event.detail));
}

function openBlockersPopover({ record, anchor }) {
  blockersPopover.open({ blockers: resolveBlockers(record, state.snapshot.plans), anchor });
}

function filterControl(id) {
  return document.getElementById(id);
}

// Update is only worth pressing when some control differs from the filters currently applied.
function updateFiltersDirty() {
  filtersUpdateEl.disabled = !FILTER_IDS.some((id) => filterControl(id).value !== state.filters[id]);
}

function draftFilters() {
  return Object.fromEntries(FILTER_IDS.map((id) => [id, filterControl(id).value]));
}

function onFilterDraftChange() {
  updateFiltersDirty();
  if (state.snapshot) refreshFilterCounts(state.snapshot);
}

// Puts every control back to the applied filters.
function discardFilterDraft() {
  for (const id of FILTER_IDS) filterControl(id).value = state.filters[id];
  updateFiltersDirty();
  if (state.snapshot) refreshFilterCounts(state.snapshot);
}

function applyFilterDraft() {
  for (const id of FILTER_IDS) state.filters[id] = filterControl(id).value;
  filtersDialogEl.close();
  render();
}

function resetFilter(id) {
  state.filters[id] = FILTER_DEFAULTS[id];
  const node = document.getElementById(id);
  if (node) node.value = FILTER_DEFAULTS[id];
  render();
}

async function load() {
  const sequence = ++loadSequence;
  try {
    const snapshot = await api.fetchSnapshot();
    if (sequence === loadSequence) applySnapshot(snapshot);
  } catch (err) {
    if (sequence === loadSequence) showLoadError(err);
  } finally {
    portalHideLoading();
  }
}

// The scope names no listed repository: show that, never another repository's plans.
function showScopeUnavailable() {
  state.snapshot = null;
  plansHeaderEl.hidden = true;
  filterChipsEl.replaceChildren();
  onboardingEl.hidden = true;
  warningsEl.hidden = true;
  bannerEl.hidden = true;
  groupsEl.replaceChildren(repositoryScopeUnavailableNotice());
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  portalSetUpdatedAt();
  // One call to action at a time (pljvmyh §7): the package banner while plan-write is disabled,
  // then the shared repository empty state until a repository is known; the header only once there
  // is something to monitor.
  plansHeaderEl.hidden = !snapshot.planWritePackage.enabled || tmpl.plansOnboardingStep(snapshot) === "no-repositories";
  populateFilters(snapshot);
  render();
  renderRepositorySyncStatus();
}

function renderRepositorySyncStatus() {
  const labels = { syncing: "Syncing", synced: "Synced", failed: "Sync failed", unavailable: "Sync status unavailable" };
  for (const node of document.querySelectorAll("[data-repository-sync-status]")) {
    node.hidden = !repositoryAutoDiscoveryEnabled;
    node.classList.toggle("is-syncing", repositorySyncState === "syncing");
    node.classList.toggle("is-synced", repositorySyncState === "synced");
    node.classList.toggle("is-failed", repositorySyncState === "failed" || repositorySyncState === "unavailable");
    node.querySelector("[data-slot=text]").textContent = labels[repositorySyncState] || labels.synced;
  }
}

function setPlansSyncPending(isPending) {
  repositorySyncPending = isPending;
  if (isPending) {
    repositoryAutoDiscoveryEnabled = true;
    repositorySyncState = "syncing";
    clearTimeout(syncPollTimer);
    renderRepositorySyncStatus();
  } else {
    void refreshOverview();
  }
}

// Home's overview carries two things Plans shows: repository sync status, and which active plans'
// worktrees have merged (the `merged` completion badge).
async function refreshOverview() {
  if (repositorySyncPending) return;
  try {
    const overview = await api.fetchHomeOverview();
    if (repositorySyncPending) return;
    repositoryAutoDiscoveryEnabled = overview.autoDiscovery?.enabled === true;
    repositorySyncState = overview.sync?.state || "synced";
    applyMergedPlans(mergedPlanBranches(overview));
  } catch {
    if (repositorySyncPending) return;
    repositorySyncState = "unavailable";
  }
  renderRepositorySyncStatus();
  clearTimeout(syncPollTimer);
  if (repositorySyncState === "syncing") syncPollTimer = setTimeout(refreshOverview, 750);
}

// Re-renders only when the merged set actually changed, so a sync poll does not rebuild the cards
// (and reset an in-flight priority dropdown) for nothing.
function applyMergedPlans(merged) {
  const signature = (map) => JSON.stringify([...map].sort(([a], [b]) => a.localeCompare(b)));
  if (signature(merged) === signature(state.mergedPlans)) return;
  state.mergedPlans = merged;
  render();
  const drawerStatus = planDrawer.isOpen ? planDrawer.statusElement : null;
  if (drawerStatus) {
    drawerStatus.merge = state.mergedPlans.get(drawerStatus.record.key) || null;
    drawerStatus.record = drawerStatus.record;
  }
}

function populateFilters(snapshot) {
  for (const id of Object.keys(FILTER_OPTION_DEFS)) {
    setOptions(id, FILTER_OPTION_DEFS[id](snapshot));
  }
}

function setOptions(id, options) {
  const select = document.getElementById(id);
  const has = (value) => options.some(([candidate]) => candidate === value);
  // The applied filter survives a refreshed option list unless its option is gone; a draft the
  // user is still editing in the open popup is kept the same way.
  if (!has(state.filters[id])) state.filters[id] = "all";
  const draft = filtersDialogEl.open ? select.value : state.filters[id];
  select.replaceChildren(...options.map(tmpl.selectOption));
  select.value = has(draft) ? draft : state.filters[id];
  updateFiltersDirty();
}

// Refreshes each select's option labels with facet counts against the current snapshot + the other
// filters (the applied ones, or the popup's draft while it is being edited), and disables options
// that match nothing. Never touches `.value`, so it's safe to call on every render() without
// disturbing the user's current selection.
function refreshFilterCounts(snapshot, filters = filtersDialogEl.open ? draftFilters() : state.filters) {
  for (const id of Object.keys(FILTER_OPTION_DEFS)) {
    const select = document.getElementById(id);
    const options = FILTER_OPTION_DEFS[id](snapshot);
    const counts = optionCounts(id, options.map(([value]) => value), snapshot.plans, filters);
    for (const option of select.options) {
      const def = options.find(([value]) => value === option.value);
      if (!def) continue;
      const count = counts.get(option.value) ?? 0;
      option.textContent = `${def[1]} (${count})`;
      // An option that matches nothing cannot be picked; the one already chosen (applied, or in the
      // popup's draft) stays enabled so the select never shows a disabled selection.
      option.disabled = count === 0 && option.value !== "all" && option.value !== select.value && option.value !== state.filters[id];
    }
  }
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  renderPackageBanner(snapshot);
  const step = tmpl.plansOnboardingStep(snapshot);
  if (!snapshot.planWritePackage.enabled || step !== "plans") {
    lifecycleBarEl.dataset.board = "false";
    filterChipsEl.replaceChildren();
    warningsEl.hidden = true;
    groupsEl.replaceChildren();
    renderOnboarding(snapshot, step);
    return;
  }
  onboardingEl.hidden = true;
  lifecycleBarEl.dataset.board = "true";
  renderWarnings(snapshot);
  renderFilterChips(snapshot);
  refreshFilterCounts(snapshot);
  const allMatchingCurrentFilters = filteredPlans(snapshot.plans, state.filters);
  renderLifecycleTabs(allMatchingCurrentFilters);
  // Sorted here rather than inside filteredPlans: that result spans every lifecycle, and the tabs
  // read it for counts. Completion ordering is Active-only, so it applies to the visible slice,
  // after the tab filter has narrowed it to one lifecycle.
  const visiblePlans = allMatchingCurrentFilters
    .filter((record) => record.plan.lifecycle === state.selectedLifecycle)
    .sort(sortForLifecycle(state.selectedLifecycle));
  if (visiblePlans.length === 0) {
    groupsEl.replaceChildren(tmpl.emptyState());
    return;
  }
  const cardActions = {
    onOpen: openPlan,
    onCopyPath: copyText,
    onCopyContext: (record) => copyText(repositoryContext(record)),
    onCopyPortableContext: (key) => copyPrompt(null, [key], "portable"),
    onPlanAction: (key, command) => copyPrompt(command, [key], "repository-aware"),
    mergeFor: (key) => state.mergedPlans.get(key) || null,
    planWriteEnabled: snapshot.planWritePackage.enabled,
    planWritePackage: snapshot.planWritePackage,
    skillModal,
    onEnablePackage: enablePackage,
    onError: showError,
  };
  groupsEl.replaceChildren(tmpl.cardGrid(visiblePlans, cardActions));
}

function renderLifecycleTabs(plansMatchingOtherFilters) {
  lifecycleTitleEl.textContent = `${LIFECYCLE_LABELS[state.selectedLifecycle] || state.selectedLifecycle} Plans`;
  const lifecycles = [...LIFECYCLE_ORDER];
  const unclassifiedCount = plansMatchingOtherFilters.filter(
    (record) => record.plan.lifecycle === "unclassified",
  ).length;
  // A URL can select Unclassified while no plan is; keep it listed so the row still names it.
  if (unclassifiedCount > 0 || state.selectedLifecycle === "unclassified") lifecycles.push("unclassified");
  const counts = new Map();
  for (const life of lifecycles) {
    counts.set(
      life,
      plansMatchingOtherFilters.filter((record) => record.plan.lifecycle === life).length,
    );
  }
  lifecycleNav.setItems(
    lifecycles.map((life) => ({
      label: `${LIFECYCLE_LABELS[life] || life} Plans`,
      current: life === state.selectedLifecycle,
      secondary: SECONDARY_LIFECYCLES.has(life),
      render: () =>
        tmpl.lifecycleTab(life, counts.get(life) ?? 0, life === state.selectedLifecycle, selectLifecycle),
    })),
  );
}

function selectLifecycle(life) {
  state.selectedLifecycle = life;
  history.pushState(null, "", urlForLifecycle(life));
  render();
}

// Back/forward nav: re-read the tab from the URL (now restored by the browser) and repaint
// without a full reload — pushState above is what makes this fire in the first place.
window.addEventListener("popstate", () => {
  state.selectedLifecycle = lifecycleFromSearchParams(new URLSearchParams(location.search));
  render();
});

// mutations: property -> (record, value) => Promise<{change, record}>, each returning the shared
// domain mutation result contract so handlePlanChange doesn't need to know which one ran. Lifecycle
// is not here: the plan suite's commands move plans between lifecycle folders and commit the move.
const mutations = {
  priority: (record, value) =>
    api.updatePlanPriority(record.plan.id, record.key, value, record.plan.priority, record.mtimeMs, record.repository.id),
};

// Plan keys currently mid-mutation. Guards against two overlapping handlePlanChange calls for the
// same record (e.g. the card's and the drawer's mounted <plan-status> both showing the same plan)
// racing the server with the same expected mtimeMs — the loser would otherwise surface a
// confusing stale-conflict recovery for what looked like a single click.
const pendingMutationKeys = new Set();

// The one page-level mutation orchestrator, shared by card dropdowns, the drawer's mounted
// <plan-status>, and the toast's Undo. Filesystem truth controls UI truth: the snapshot is only
// updated after the server confirms success, and the full record it returns replaces the old one
// outright rather than patching individual fields in place.
async function handlePlanChange({ property, value, record }) {
  if (pendingMutationKeys.has(record.key)) return null;
  pendingMutationKeys.add(record.key);
  // Captured once up front so the outcome this mutation reports (visibility, tab, filters) always
  // describes the view the user was looking at when they triggered it — not whatever tab/filters
  // are current by the time the server responds.
  const viewAtRequestTime = { selectedLifecycle: state.selectedLifecycle, filters: { ...state.filters } };
  const wasVisible = isVisible(record, viewAtRequestTime.selectedLifecycle, viewAtRequestTime.filters);
  let result;
  try {
    result = await mutations[property](record, value);
  } catch (err) {
    if (err.code === "STALE_PLAN") {
      await recoverFromStaleConflict(record);
      return null;
    }
    // The mutating control (a dropdown inside <plan-status>) is stuck showing a loading state
    // until it receives a fresh `record` property set — re-set the unchanged record so it clears
    // loading and reverts to the last-known-good value instead of hanging. render() (called by
    // refreshMountedStatus) rebuilds the warnings banner from snapshot data, so showError must run
    // AFTER it or its message gets immediately overwritten.
    refreshMountedStatus(record);
    showError(err);
    return null;
  } finally {
    pendingMutationKeys.delete(record.key);
  }
  state.snapshot.plans = replaceRecord(state.snapshot.plans, record.key, result.record);
  const nowVisible = isVisible(result.record, viewAtRequestTime.selectedLifecycle, viewAtRequestTime.filters);
  const previousKey = record.key;
  render();
  // The card grid's render() mounts fresh <plan-status> instances, but the drawer isn't part of
  // that render pass — its mounted <plan-status> would otherwise sit stuck at loading:true
  // (dropdown spinner) forever, since it never receives the new record. Re-set it only when the
  // drawer is still open for this same plan.
  if (planDrawer.isOpen && planDrawer.openKey === previousKey) {
    const drawerStatus = planDrawer.statusElement;
    if (drawerStatus) drawerStatus.record = result.record;
  }
  presentChangeOutcome({ result, wasVisible, nowVisible, view: viewAtRequestTime });
  return result.record;
}

// Re-renders whichever mounted <plan-status> instance(s) still reference this record — the card
// grid (full render()) or the open drawer — so a failed mutation's dropdown clears its loading
// state even though nothing about the underlying record actually changed.
function refreshMountedStatus(record) {
  render();
  if (!planDrawer.isOpen) return;
  const drawerStatus = planDrawer.statusElement;
  if (drawerStatus && drawerStatus.record?.key === record.key) drawerStatus.record = record;
}

async function recoverFromStaleConflict(record) {
  try {
    applySnapshot(await api.fetchSnapshot());
  } catch (err) {
    showError(err);
    return;
  }
  const current = state.snapshot.plans.find((item) => item.plan.id && item.plan.id === record.plan.id) ||
    state.snapshot.plans.find((item) => item.key === record.key);
  if (planDrawer.isOpen && planDrawer.openKey === record.key) {
    if (current) {
      showError({ message: `This plan changed outside the portal, so the update wasn't applied. The page has been refreshed. Current lifecycle: ${current.plan.lifecycle}.` });
      openPlan(current.key);
    } else {
      planDrawer.close();
      showError({ message: "This plan was removed or renamed outside the portal." });
    }
  } else {
    showError({ message: "This plan changed outside the portal, so the update wasn't applied. The page has been refreshed." });
  }
}

// Decides whether to show the outcome toast after a successful mutation: only when the mutation
// actually removed the record from view — an unrelated field change that keeps the record visible
// needs no notification.
function presentChangeOutcome({ result, wasVisible, nowVisible, view }) {
  const { change, record } = result;
  if (!(wasVisible && !nowVisible)) return;
  // Use the tab/filters captured when the mutation started, not whatever is current now — the
  // toast must describe the view the user was actually looking at when they triggered the change.
  const filteredAction = filteredListActionFor(change, view);
  outcomeToast.show({
    message: `"${record.plan.title}" ${change.property} was set to ${change.newValue}.`,
    actions: [
      { label: "Undo", run: () => handlePlanChange({ property: change.property, value: change.previousValue, record }) },
      { label: "View plan", run: () => openPlan(record.key) },
      ...(filteredAction ? [{ label: filteredAction.label, run: () => applyFilteredListAction(filteredAction) }] : []),
    ],
  });
}

// The only filtered-list shortcut is priority's (see filteredListActionFor).
function applyFilteredListAction(action) {
  state.filters.priority = action.value;
  document.getElementById("priority").value = action.value;
  render();
}

function renderFilterChips(snapshot) {
  const descriptors = tmpl.filterChipDescriptors(state.filters, FILTER_DEFAULTS, (id, value) =>
    optionLabel(snapshot, id, value),
  );
  filterChipsEl.replaceChildren(...descriptors.map(tmpl.filterChip));
}

// Set while a repository filter is selected; its empty state offers to drop the filter.
function scopeForEmptyState() {
  if (!currentRepositoryScope()) return null;
  return { name: scopedRepositoryName ?? "this repo", onViewAll: clearRepositoryScope };
}

function renderOnboarding(snapshot, step) {
  onboardingEl.hidden = !snapshot.planWritePackage.enabled;
  if (onboardingEl.hidden) return;
  const node = step === "no-repositories"
    ? tmpl.plansNoRepositories(onboarding.onManage)
    : tmpl.plansOnboardingState(snapshot, step, onboarding.onManage, scopeForEmptyState());
  onboardingEl.replaceChildren(node);
  renderRepositorySyncStatus();
}

function renderWarnings(snapshot) {
  const warnings = [
    ...(snapshot.errors || []).map((err) => `${err.repository || "scan"}${err.checkout ? ` (${err.checkout})` : ""}: ${err.path ? `${err.path} ` : ""}${err.error}`),
    ...(snapshot.truncated ? ["Some repos have more plan documents than the scanner reads; the rest are not shown."] : []),
  ];
  warningsEl.hidden = warnings.length === 0;
  warningsEl.replaceChildren(...warnings.map(tmpl.warningLine));
}

function renderPackageBanner(snapshot) {
  const pkg = snapshot.planWritePackage || {};
  // Banner is the step-1 onboarding prompt: visible whenever the package is disabled (even with
  // roots already configured — a mid-life disable needs its re-enable path back). Once enabled,
  // the Project Folders form is the only visible setup surface.
  if (pkg.enabled) {
    bannerEl.hidden = true;
    return;
  }
  bannerEl.hidden = false;
  bannerEl.replaceChildren(tmpl.packageBanner(pkg, enablePackage, skillModal));
}

async function enablePackage() {
  try {
    await api.enablePlanSuitePackages();
    applySnapshot(await api.fetchSnapshot());
  } catch (err) {
    showError(err);
  }
}

function openPlan(key) {
  return planDrawer.open(key);
}

function copyPrompt(actionName, keys, mode = "repository-aware") {
  return planDrawer.copyPrompt(actionName, keys, mode);
}

function copyText(text) {
  return planDrawer.copyText(text);
}

function showLoadError(err) {
  if (isRepositoryScopeUnavailable(err)) showScopeUnavailable();
  else showError(err);
}

function showError(err) {
  warningsEl.hidden = false;
  const parts = [String(err?.message || err)];
  if (err?.resolution) parts.push(err.resolution);
  if (err?.details?.length) parts.push(err.details.join("; "));
  warningsEl.textContent = parts.join(" — ");
}
