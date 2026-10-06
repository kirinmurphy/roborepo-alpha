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
import { repositoryEmptyState } from "/portal/shared/repository-sources-templates.js";
import { createLifecycleErrorDialog } from "./lifecycle-error-dialog.js";
import { createPlanDrawer } from "./plan-drawer.js";
import { createBlockersPopover } from "./blockers-popover.js";
import {
  FILTER_IDS,
  FILTER_DEFAULTS,
  FILTER_OPTION_DEFS,
  LIFECYCLE_LABELS,
  filteredPlans,
  sortForLifecycle,
  isNotStarted,
  completionRatio,
  isVisible,
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

const state = {
  snapshot: null,
  filters: { ...FILTER_DEFAULTS },
  filtersExpanded: false,
  selectedLifecycle: lifecycleFromSearchParams(new URLSearchParams(location.search)),
};

const groupsEl = document.getElementById("groups");
const warningsEl = document.getElementById("warnings");
const bannerEl = document.getElementById("package-banner");
const plansHeaderEl = document.getElementById("plans-header");
const filtersToggleEl = document.getElementById("filters-toggle");
const filtersBodyEl = document.getElementById("filters-body");
const filterChipsEl = document.getElementById("filter-chips");
const activeTasksBarEl = document.getElementById("active-tasks-bar");
const plansCountTextEl = document.getElementById("plans-count-text");
const reposCountTextEl = document.getElementById("repos-count-text");
const lifecycleTabsEl = document.getElementById("lifecycle-tabs");
const lifecycleDropdownMountEl = document.getElementById("lifecycle-dropdown-mount");
const onboardingEl = document.getElementById("plans-onboarding");
let lifecycleDropdownEl = null;

// Plans no longer owns which repositories exist: the header count and the onboarding states open the
// shared Manage repositories dialog, and any change there re-reads the Plans snapshot.
const sourcesDialog = createRepositorySourcesDialog({ onChange: () => api.refreshSnapshot().then(applySnapshot).catch(showError) });
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
  onEnablePackage: enablePackage,
  onError: showError,
});
const skillModal = planDrawer.skillModal;
const outcomeToast = planDrawer.toast;
const blockersPopover = createBlockersPopover(document.getElementById("blockers-popover"), {
  onOpenPlan: (key) => openPlan(key),
});
const lifecycleErrorDialog = createLifecycleErrorDialog(document.getElementById("lifecycle-error-modal"), {
  onViewPlan: (key) => openPlan(key),
});
const allTasksModal = document.getElementById("all-tasks-modal");
portalWireBackdropClose(allTasksModal, () => allTasksModal.close());

bindStaticControls();
load();

function bindStaticControls() {
  const refreshEl = document.getElementById("refresh");
  const refreshIconEl = refreshEl.querySelector("portal-icon");
  const refreshSpinnerEl = refreshEl.querySelector(".spinner");
  refreshEl.addEventListener("click", () => {
    refreshEl.disabled = true;
    refreshIconEl.hidden = true;
    refreshSpinnerEl.hidden = false;
    api.refreshSnapshot().then(applySnapshot).catch(showError).finally(() => {
      refreshEl.disabled = false;
      refreshIconEl.hidden = false;
      refreshSpinnerEl.hidden = true;
    });
  });
  document.getElementById("open-all-tasks").addEventListener("click", openAllTasks);
  reposCountTextEl.addEventListener("click", onboarding.onManage);
  document.getElementById("all-tasks-close").addEventListener("click", () => allTasksModal.close());
  for (const id of FILTER_IDS) {
    const node = document.getElementById(id);
    node.addEventListener(id === "search" ? "input" : "change", () => {
      state.filters[id] = node.value;
      render();
    });
  }
  filtersToggleEl.addEventListener("click", () => setFiltersExpanded(filtersBodyEl.hidden));
  document.getElementById("filters-done").addEventListener("click", () => setFiltersExpanded(false));
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

function setFiltersExpanded(expanded) {
  state.filtersExpanded = expanded;
  filtersBodyEl.hidden = !expanded;
}

function resetFilter(id) {
  state.filters[id] = FILTER_DEFAULTS[id];
  const node = document.getElementById(id);
  if (node) node.value = FILTER_DEFAULTS[id];
  render();
}

async function load() {
  try {
    applySnapshot(await api.fetchSnapshot());
  } catch (err) {
    showError(err);
  } finally {
    portalHideLoading();
  }
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  portalSetUpdatedAt();
  // One call to action at a time (pljvmyh §7): the package banner while plan-write is disabled,
  // then the shared repository empty state until a repository is known; the header (and its count,
  // which opens Manage repositories) only once there is something to monitor.
  plansHeaderEl.hidden = !snapshot.planWritePackage.enabled || tmpl.plansOnboardingStep(snapshot) === "no-repositories";
  setPluralCount(plansCountTextEl, snapshot.plans.length, "Plan");
  setPluralCount(reposCountTextEl, knownRepositoryCount(snapshot), "Repo");
  populateFilters(snapshot);
  render();
}

function populateFilters(snapshot) {
  for (const id of Object.keys(FILTER_OPTION_DEFS)) {
    setOptions(id, FILTER_OPTION_DEFS[id](snapshot));
  }
}

function setOptions(id, options) {
  const select = document.getElementById(id);
  const previous = select.value || "all";
  select.replaceChildren(...options.map(tmpl.selectOption));
  select.value = options.some(([value]) => value === previous) ? previous : "all";
  state.filters[id] = select.value;
}

// Refreshes each select's option labels with facet counts against the current snapshot + other
// active filters. Rewrites label text only — never touches `.value`, so it's safe to call on
// every render() without disturbing the user's current selection.
function refreshFilterCounts(snapshot) {
  for (const id of Object.keys(FILTER_OPTION_DEFS)) {
    const select = document.getElementById(id);
    const options = FILTER_OPTION_DEFS[id](snapshot);
    const counts = optionCounts(id, options.map(([value]) => value), snapshot.plans, state.filters);
    for (const option of select.options) {
      const def = options.find(([value]) => value === option.value);
      if (!def) continue;
      option.textContent = `${def[1]} (${counts.get(option.value) ?? 0})`;
    }
  }
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  renderPackageBanner(snapshot);
  const step = tmpl.plansOnboardingStep(snapshot);
  if (!snapshot.planWritePackage.enabled || step !== "plans") {
    warningsEl.hidden = true;
    activeTasksBarEl.hidden = true;
    groupsEl.replaceChildren();
    renderOnboarding(snapshot, step);
    return;
  }
  onboardingEl.hidden = true;
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
  // Set before the empty-state return below, or switching to an empty Active tab would leave the
  // previous tab's bar on screen.
  activeTasksBarEl.hidden = state.selectedLifecycle !== "active" || visiblePlans.length === 0;
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
    planWriteEnabled: snapshot.planWritePackage.enabled,
    planWritePackage: snapshot.planWritePackage,
    skillModal,
    onEnablePackage: enablePackage,
    onError: showError,
  };
  groupsEl.replaceChildren(tmpl.cardGrid(visiblePlans, cardActions));
}

function renderLifecycleTabs(plansMatchingOtherFilters) {
  const lifecycles = [...LIFECYCLE_ORDER];
  const unclassifiedCount = plansMatchingOtherFilters.filter(
    (record) => record.plan.lifecycle === "unclassified",
  ).length;
  if (unclassifiedCount > 0) lifecycles.push("unclassified");
  const counts = new Map();
  for (const life of lifecycles) {
    counts.set(
      life,
      plansMatchingOtherFilters.filter((record) => record.plan.lifecycle === life).length,
    );
  }
  lifecycleTabsEl.replaceChildren(
    ...lifecycles.map((life) =>
      tmpl.lifecycleTab(life, counts.get(life) ?? 0, life === state.selectedLifecycle, selectLifecycle),
    ),
  );
  const dropdown = ensureLifecycleDropdown();
  dropdown.options = lifecycles.map((life) => [
    life,
    `${LIFECYCLE_LABELS[life] || life} (${counts.get(life) ?? 0})`,
  ]);
  dropdown.value = state.selectedLifecycle;
}

function ensureLifecycleDropdown() {
  if (!lifecycleDropdownEl) {
    lifecycleDropdownEl = document.createElement("option-dropdown");
    lifecycleDropdownEl.onSelect = (value) => selectLifecycle(value);
    lifecycleDropdownMountEl.replaceChildren(lifecycleDropdownEl);
  }
  return lifecycleDropdownEl;
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

// mutations: property -> (record, value) => Promise<{change, record}>. Both call through the
// same shared result contract (see docs/plans/active/plan-lifecycle-toggle-control.md's "Shared
// domain mutation result"), so handlePlanChange doesn't need to know which one ran.
const mutations = {
  priority: (record, value) =>
    api.updatePlanPriority(record.plan.id, record.key, value, record.plan.priority, record.mtimeMs, record.repository.id),
  lifecycle: (record, value, { skipDestinationValidation } = {}) =>
    api.updatePlanLifecycle(record.plan.id, record.key, value, record.plan.lifecycle, record.mtimeMs, record.repository.id, skipDestinationValidation),
};

// Plan keys currently mid-mutation. Guards against two overlapping handlePlanChange calls for the
// same record (e.g. the card's and the drawer's mounted <plan-status> both showing the same plan)
// racing the server with the same expected mtimeMs/lifecycle — the loser would otherwise surface a
// confusing stale-conflict recovery for what looked like a single click.
const pendingMutationKeys = new Set();

// The one page-level mutation orchestrator, shared by card dropdowns, the drawer's mounted
// <plan-status>, and the Start/Archive/Revert/Undo shortcuts. Filesystem truth controls UI truth:
// the snapshot is only updated after the server confirms success, and the full record it returns
// replaces the old one outright rather than patching individual fields in place.
async function handlePlanChange({ property, value, record }, mutationOptions) {
  if (pendingMutationKeys.has(record.key)) return null;
  pendingMutationKeys.add(record.key);
  // Captured once up front so the outcome this mutation reports (visibility, tab, filters) always
  // describes the view the user was looking at when they triggered it — not whatever tab/filters
  // are current by the time the server responds.
  const viewAtRequestTime = { selectedLifecycle: state.selectedLifecycle, filters: { ...state.filters } };
  const wasVisible = isVisible(record, viewAtRequestTime.selectedLifecycle, viewAtRequestTime.filters);
  let result;
  try {
    result = await mutations[property](record, value, mutationOptions);
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
    if (err.code === "LIFECYCLE_REQUIREMENTS") {
      // Validation is a soft warning, not a hard gate (see movePlanLifecycle's comment) — offer
      // "move anyway," which re-enters this same function with the bypass flag so the retry gets
      // the exact same snapshot-replace/outcome handling as any other successful mutation. The
      // dialog also offers the server-generated repair prompt carried on the error, for users who
      // would rather fix the document than move past it.
      //
      // This is the single place a readiness failure surfaces. Card dropdowns, the drawer's
      // <plan-status>, and the Start/Archive/Revert shortcuts all funnel through this function,
      // which is what guarantees they show identical findings.
      lifecycleErrorDialog.open(err, () => handlePlanChange({ property, value, record }, { skipDestinationValidation: true }));
    } else {
      showError(err);
    }
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
  // (dropdown spinner) forever, since it never receives the new record. presentChangeOutcome may
  // close the drawer for a lifecycle move (a stale key by then); re-set only when it's still open
  // for this same plan.
  if (planDrawer.isOpen && planDrawer.openKey === previousKey) {
    const drawerStatus = planDrawer.statusElement;
    if (drawerStatus) drawerStatus.record = result.record;
  }
  presentChangeOutcome({ result, wasVisible, nowVisible, previousKey, view: viewAtRequestTime });
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
// needs no notification. Lifecycle moves here are the manual dropdown override; the suite commands
// (`/plan-start`, `/plan-close`) make and commit their own moves, so none gets a follow-up prompt.
function presentChangeOutcome({ result, wasVisible, nowVisible, previousKey, view }) {
  const { change, record } = result;
  // A lifecycle move invalidates the open drawer's key/path/actions — close it before showing
  // either outcome surface rather than leaving a stale detail view open behind the dialog/toast.
  if (change.property === "lifecycle" && planDrawer.isOpen && planDrawer.openKey === previousKey) {
    planDrawer.close();
  }
  if (!(wasVisible && !nowVisible)) return;
  // Use the tab/filters captured when the mutation started, not whatever is current now — the
  // toast must describe the view the user was actually looking at when they triggered the change.
  const filteredAction = filteredListActionFor(change, view);
  const label = change.property === "lifecycle" ? LIFECYCLE_LABELS[change.newValue] : change.newValue;
  outcomeToast.show({
    message: `"${record.plan.title}" ${change.property} was set to ${label}.`,
    actions: [
      { label: "Undo", run: () => handlePlanChange({ property: change.property, value: change.previousValue, record }) },
      { label: "View plan", run: () => openPlan(record.key) },
      ...(filteredAction ? [{ label: filteredAction.label, run: () => applyFilteredListAction(filteredAction) }] : []),
    ],
  });
}

function applyFilteredListAction(action) {
  if (action.type === "lifecycle") {
    selectLifecycle(action.value);
  } else if (action.type === "priority") {
    state.filters.priority = action.value;
    document.getElementById("priority").value = action.value;
    render();
  }
}

function renderFilterChips(snapshot) {
  const descriptors = tmpl.filterChipDescriptors(state.filters, FILTER_DEFAULTS, (id, value) =>
    optionLabel(snapshot, id, value),
  );
  filterChipsEl.replaceChildren(...descriptors.map(tmpl.filterChip));
}

function renderOnboarding(snapshot, step) {
  onboardingEl.hidden = !snapshot.planWritePackage.enabled;
  if (onboardingEl.hidden) return;
  const node = step === "no-repositories"
    ? repositoryEmptyState({ autoDiscoveryEnabled: snapshot.autoDiscovery?.enabled === true, ...onboarding })
    : tmpl.plansOnboardingState(snapshot, step, onboarding.onManage);
  onboardingEl.replaceChildren(node);
}

// Every known repository, scanned or not, so the header agrees with the onboarding copy, Home, and
// the Manage repositories list; one whose checkouts cannot be read is still being monitored.
function knownRepositoryCount(snapshot) {
  return (snapshot.repositoryScans || []).length;
}

function renderWarnings(snapshot) {
  const warnings = [
    ...(snapshot.errors || []).map((err) => `${err.repository || "scan"}${err.checkout ? ` (${err.checkout})` : ""}: ${err.path ? `${err.path} ` : ""}${err.error}`),
    ...(snapshot.truncated ? ["Some repositories have more plan documents than the scanner reads; the rest are not shown."] : []),
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

// Every active plan's remaining work in one view, ordered the same way the Active tab is so the
// dialog and the board never disagree about what is furthest along.
//
// Reads the plans already in the snapshot rather than fetching: `openTasks` ships with the list
// payload for active plans (see modules/plan-suite/index.mjs), so this needs no round trip and
// cannot show something staler than the cards behind it. Respects the current filters for the same
// reason — a dialog opened from a filtered board that ignored the filter would be a different
// answer to the question the user is looking at.
function openAllTasks() {
  const active = filteredPlans(state.snapshot.plans, state.filters)
    .filter((record) => record.plan.lifecycle === "active")
    .sort(sortForLifecycle("active"));

  const openCount = active.reduce((sum, record) => sum + record.plan.taskCounts.remaining, 0);
  document.getElementById("all-tasks-summary").textContent =
    `${openCount} open ${openCount === 1 ? "task" : "tasks"} across ${active.length} ${active.length === 1 ? "project" : "projects"}`;

  document.getElementById("all-tasks-body").replaceChildren(
    ...active.map((record) =>
      tmpl.allTasksProject(record, {
        notStarted: isNotStarted(record.plan),
        percent: completionRatio(record.plan),
        onViewStory: (key) => {
          // One dialog at a time: the drawer is also a modal, and leaving this one open behind it
          // would stack two backdrops and trap focus in the wrong layer.
          allTasksModal.close();
          openPlan(key);
        },
      }),
    ),
  );
  allTasksModal.showModal();
}

function copyPrompt(actionName, keys, mode = "repository-aware") {
  return planDrawer.copyPrompt(actionName, keys, mode);
}

function copyText(text) {
  return planDrawer.copyText(text);
}

function setPluralCount(node, count, noun) {
  const strong = document.createElement("strong");
  strong.textContent = count;
  node.replaceChildren(strong, ` ${noun}${count === 1 ? "" : "s"}`);
}

function showError(err) {
  warningsEl.hidden = false;
  const parts = [String(err?.message || err)];
  if (err?.resolution) parts.push(err.resolution);
  if (err?.details?.length) parts.push(err.details.join("; "));
  warningsEl.textContent = parts.join(" — ");
}
