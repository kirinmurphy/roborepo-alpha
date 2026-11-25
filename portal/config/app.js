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
import { offerHookReview } from "/portal/shared/hook-review-offer.js";
import * as api from "./api.js";
import * as tmpl from "./templates.js";
import {
  createAddSourceDialog,
  createConfigModal,
  createDisableDependentsDialog,
  createPackageActionDialog,
  createRecommendationsDialog,
} from "./panels.js";
import { snapshotChanged, inspectChipSpecs, contentsEntryChipSpec, setBulkInFlight, isBulkInFlight } from "./state.js";
import { clearRepositoryScope, currentRepositoryScope } from "/portal/shared/repository-scope.js";
import { onRepositoryScopeResolved, repositoryScopeUnavailableNotice } from "/portal/shared/repository-scope-selector.js";
import { onRepositoriesChanged } from "/portal/shared/repository-list-change.js";

const modal = createConfigModal();
const recommendationsDialog = createRecommendationsDialog();
const disableDependentsDialog = createDisableDependentsDialog();
const packageActionDialog = createPackageActionDialog();
const addSourceDialog = createAddSourceDialog();
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
    onPackageAction: handlePackageAction,
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
    ...renderPackageTabs(packageSections, snap.contextCost),
    ...otherSections.map((section) => renderSection(section, snap.contextCost)).filter(Boolean),
    // Last panel on the page: app-level lifecycle, well below the day-to-day controls.
    tmpl.maintenancePanel({
      onPreview: api.fetchUninstallPreview,
      onExecute: api.executeUninstall,
    }),
  );
}

// --------------------------------------------------------------------------- package sources
//
// Package rows split into System, Custom, and Third Party tabs, from the package service's view
// (/api/packages, what `roborepo package list --json` prints). The config snapshot still drives the
// categories and switches; the view adds each Custom and Third Party card's source, commit, and
// Install, Update, and Remove. Sources sit in their own section below the tabs. Only the All repos
// scope shows any of this: sources and installs are machine-wide.

const TAB_STORAGE_KEY = "roborepo.agents.packageTab";
let packageData = null; // packageView()
let sourcesData = null; // listSources()
let packageLoadError = null;
let activeTab = readStoredTab();
const sourcesState = { pending: [], status: null, expanded: new Map(), busy: new Set() };

function readStoredTab() {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY) || "system";
  } catch {
    return "system";
  }
}

function selectTab(tab, { focus = false } = {}) {
  activeTab = tab;
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // The tab is only remembered when storage is available.
  }
  render(lastSnapshot);
  if (focus) document.getElementById(`package-tab-${tab}`)?.focus();
}

const rowKey = (sourceId, id) => `${sourceId}/${id}`;

// Every source's tab, so an unresolved or shadowed record lands on the tab of the source it names.
function sourceTabOf(sourceId) {
  return sourcesData?.find((source) => source.id === sourceId)?.tab || null;
}

function renderPackageTabs(packageSections, contextCost) {
  if (!packageData) {
    // Without the package view the page still shows every package, untabbed, as before.
    const sections = packageSections.map((section) => renderSection(section, contextCost)).filter(Boolean);
    return packageLoadError ? [tmpl.packageLoadFailed(packageLoadError.message), ...sections] : sections;
  }
  const tabs = packageData.tabs;
  if (!tabs.some((tab) => tab.id === activeTab)) activeTab = tabs[0]?.id || "system";
  const rows = new Map(packageData.packages.map((row) => [rowKey(row.sourceId, row.id), row]));
  const shown = new Set();
  const sections = packageSections
    .map((section) => {
      const items = section.items
        .filter((item) => (item.tab || "system") === activeTab)
        .map((item) => {
          const state = rows.get(rowKey(item.sourceId, item.id));
          if (state) shown.add(rowKey(state.sourceId, state.id));
          return activeTab === "system" || !state ? item : { ...item, packageState: state };
        });
      return { ...section, items };
    })
    .filter((section) => section.items.length > 0);
  const extra = activeTab === "system" ? [] : [availableSection(shown), attentionSection()].filter(Boolean);
  const panel = document.createElement("div");
  panel.className = "package-tab-panel";
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", `package-tab-${activeTab}`);
  const rendered = [...extra, ...sections].map((section) => renderSection(section, contextCost)).filter(Boolean);
  panel.replaceChildren(...(rendered.length ? rendered : [tmpl.emptyPackageTab(tabs.find((tab) => tab.id === activeTab)?.label)]));
  return [
    tmpl.packageTabs(tabs, activeTab, selectTab),
    panel,
    sourcesData ? tmpl.sourcesSection(sourcesData, sourcesState, sourceCallbacks) : null,
  ].filter(Boolean);
}

// Packages a source offers that the config snapshot has no row for: not installed from a GitHub
// source yet, so their only control is Install.
function availableSection(shown) {
  const items = packageData.packages
    .filter((row) => row.tab === activeTab && !shown.has(rowKey(row.sourceId, row.id)) && !PACKAGES_CONTROLLED_ELSEWHERE.has(row.id))
    .map((row) => ({ id: row.id, label: row.label, description: row.description, sourceId: row.sourceId, active: row.active, toggle: null, packageState: row }));
  if (items.length === 0) return null;
  return { categoryId: "available", category: "Available to Install", items };
}

// Installed records the catalog cannot use: unresolved (with the service's reason) and shadowed
// (another source's package with the same id is in use). A record whose source is gone shows on
// both Custom and Third Party, since only its source says which tab it belongs to.
function attentionSection() {
  const onThisTab = (sourceId) => {
    const tab = sourceTabOf(sourceId);
    return tab ? tab === activeTab : activeTab !== "system";
  };
  const unresolved = (packageData.unresolved || [])
    .filter((entry) => onThisTab(entry.sourceId))
    .map((entry) => ({
      id: entry.id,
      label: rowKey(entry.sourceId, entry.id),
      active: false,
      toggle: null,
      packageNote: `Can't be found: ${entry.reason}`,
      packageActions: ["remove"],
      removeRef: rowKey(entry.sourceId, entry.id),
    }));
  const shadowed = (packageData.shadowed || []).flatMap((entry) => entry.hidden
    .filter((name) => onThisTab(name.split("/")[0]))
    .map((name) => ({ id: entry.id, label: name, active: false, toggle: null, packageNote: `Hidden by ${entry.chosen}` })));
  const items = [...unresolved, ...shadowed];
  if (items.length === 0) return null;
  return { categoryId: "attention", category: "Needs Attention", items };
}

function handlePackageAction(kind, item) {
  if (kind === "install") return installFlow(item);
  if (kind === "update") return updateFlow(item);
  if (kind === "remove") return removeFlow(item);
}

// The install preview is bound to the plan it showed: a source refreshed in between refuses with
// the new plan, which replaces the dialog's contents and asks again, as the CLI re-prompts.
async function installFlow(item) {
  const ref = item.packageState.qualifiedName;
  const title = `Install ${item.label}`;
  packageActionDialog.show({ title, body: tmpl.loadingText("Reading what it would install…"), confirmLabel: "Install", loading: true });
  let preview;
  try {
    preview = await api.fetchInstallPreview(ref);
  } catch (err) {
    return packageActionDialog.fail(err.message);
  }
  const confirm = async () => {
    try {
      await api.installPackage(ref, preview.plan);
    } catch (err) {
      if (!err.details?.planChanged) throw err;
      preview = { ...preview, packages: err.details.preview, plan: err.details.plan };
      return { body: tmpl.installPreviewBody(preview, { notice: err.message }) };
    }
    await reloadAll();
    return true;
  };
  return packageActionDialog.show({ title, body: tmpl.installPreviewBody(preview), confirmLabel: "Install", onConfirm: confirm });
}

// The unconfirmed update returns the change to show (a GitHub fetch, so it can take a while);
// confirming sends that change's `to` and `from`. If either moved, the refusal carries the current
// change, which replaces the dialog's contents and asks again.
async function updateFlow(item) {
  const ref = item.packageState.qualifiedName;
  const title = `Update ${item.label}`;
  packageActionDialog.show({ title, body: tmpl.loadingText("Fetching its source for the new revision…"), confirmLabel: "Update", loading: true });
  let change;
  try {
    const result = await api.updatePackage(ref);
    // Nothing to confirm: up to date, a restored copy, or a folder package used in place.
    packageActionDialog.show({ title, body: tmpl.updateResultText(result), confirmLabel: "Done", onConfirm: async () => true });
    await reloadAll();
    return;
  } catch (err) {
    if (err.code !== "confirmationRequired" || !err.details?.change) return packageActionDialog.fail(err.message);
    change = err.details.change;
  }
  const confirm = async () => {
    try {
      await api.updatePackage(ref, change);
    } catch (err) {
      if (err.code !== "confirmationRequired" || !err.details?.change) throw err;
      change = err.details.change;
      return { body: tmpl.updateChangeBody(change, { notice: err.message }) };
    }
    await reloadAll();
    return true;
  };
  return packageActionDialog.show({ title, body: tmpl.updateChangeBody(change), confirmLabel: "Update", onConfirm: confirm });
}

function removeFlow(item) {
  const ref = item.removeRef || item.packageState.qualifiedName;
  return packageActionDialog.show({
    title: `Remove ${item.label}`,
    body: tmpl.removePackageBody(item.packageState),
    confirmLabel: "Remove",
    danger: true,
    onConfirm: async () => {
      await api.removePackage(ref);
      await reloadAll();
      return true;
    },
  });
}

const sourceCallbacks = {
  // The dialog closes on submit and the add shows as a pending row, so the page stays usable while
  // a GitHub repo is fetched.
  async onAdd() {
    const request = await addSourceDialog.ask();
    if (!request) return;
    const entry = { location: request.location };
    sourcesState.pending.push(entry);
    sourcesState.status = null;
    render(lastSnapshot);
    try {
      const result = await api.addPackageSource(request.location, request.id);
      const count = result.packages.length;
      sourcesState.status = { text: `Added ${result.source.id}: ${count} package${count === 1 ? "" : "s"} available.${result.warning ? ` ${result.warning}` : ""}` };
    } catch (err) {
      sourcesState.status = { text: err.message, error: true };
    } finally {
      sourcesState.pending = sourcesState.pending.filter((pending) => pending !== entry);
    }
    await reloadAll();
  },
  async onRefresh(source, button) {
    sourcesState.busy.add(source.id);
    tmpl.busy(button);
    try {
      const [result] = await api.refreshPackageSource(source.id);
      sourcesState.status = { text: result.changed ? `${source.id} is now at ${result.revision.slice(0, 12)}.` : `${source.id} is up to date.` };
    } catch (err) {
      sourcesState.status = { text: err.message, error: true };
    } finally {
      sourcesState.busy.delete(source.id);
    }
    await reloadAll();
  },
  async onToggle(source, enabled) {
    await api.setPackageSourceEnabled(source.id, enabled);
    await reloadAll();
  },
  onRemove(source) {
    const { node, keepInstalled } = tmpl.removeSourceBody(source);
    return packageActionDialog.show({
      title: `Remove ${source.id}`,
      body: node,
      confirmLabel: "Remove Source",
      danger: true,
      onConfirm: async () => {
        await api.removePackageSource(source.id, { keepInstalled: keepInstalled() });
        sourcesState.expanded.delete(source.id);
        await reloadAll();
        return true;
      },
    });
  },
  async onExpand(source) {
    if (sourcesState.expanded.has(source.id)) {
      sourcesState.expanded.delete(source.id);
      return render(lastSnapshot);
    }
    sourcesState.expanded.set(source.id, "loading");
    render(lastSnapshot);
    try {
      sourcesState.expanded.set(source.id, (await api.fetchSourceInfo(source.id)).packages);
    } catch (err) {
      sourcesState.expanded.set(source.id, err);
    }
    if (sourcesState.expanded.has(source.id)) render(lastSnapshot);
  },
};

async function loadPackageState() {
  if (currentRepositoryScope()) return;
  try {
    [packageData, sourcesData] = await Promise.all([api.fetchPackages(), api.fetchSources()]);
    packageLoadError = null;
  } catch (err) {
    packageLoadError = err;
  }
}

// After any package or source action: the snapshot, the package view, and the sources, together.
async function reloadAll() {
  const [snap] = await Promise.all([api.fetchConfig(), loadPackageState()]);
  last = null;
  applySnapshot(snap);
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
  // The package view and sources render beside the snapshot, so a change in either redraws too.
  const changed = snapshotChanged(last, { snap, packageData, sourcesData, packageLoadError: packageLoadError?.message || null });
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
    const [snap, setup] = await Promise.all([api.fetchConfig(), api.fetchSetupState(), loadPackageState()]);
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
// A package change made from the CLI shows as soon as the page is looked at again.
window.addEventListener("focus", () => void load());
// Theme toggle + nav live in the shared /portal/shared/theme.js. The config page has no
// canvas to redraw, so it needs no "portal:themechange" listener.
