import { portalHideLoading, portalSetUpdatedAt } from "/portal/shared/api.js";
import { harnessSetupPromptElement } from "/portal/shared/harness-warning.js";
import { createPlanDrawer } from "/portal/plans/plan-drawer.js";
import { fetchSnapshot as fetchPlansSnapshot } from "/portal/plans/api.js";
import * as api from "./api.js";
import { mountHomeLinks } from "./links.js";
import { repositoryDirectory, unresolvedActivity } from "./templates.js";
import { createRepositorySourcesDialog } from "/portal/shared/repository-sources-dialog.js";
import { autoDiscoveryPrompt, repositoryEmptyState } from "/portal/shared/repository-sources-templates.js";
import { fetchSetupState } from "/portal/shared/setup-api.js";

const POLL_MS = 10_000;
const content = document.getElementById("home-content");
const warning = document.getElementById("home-warning");
const harnessBanner = document.getElementById("home-harness-banner");
const autoDiscoveryMount = document.getElementById("home-auto-discovery");
const mockDisclaimer = document.getElementById("home-mock-disclaimer");
const homeHeading = document.querySelector(".home-heading");
const homeSyncStatus = document.getElementById("home-sync-status");
const manageRepositories = document.getElementById("manage-repositories");
let homeAutoDiscoveryEnabled = false;
let renderedVersion = null;
let pending = false;
let forceQueued = false;
let syncRetryTimer = null;
let plansSnapshot = null;

// The same plan detail drawer the Plans page opens. Read-only here: lifecycle and priority edits
// go through the Plans page's mutation flow, which Home does not carry.
const planDrawer = createPlanDrawer({
  getPlans: () => plansSnapshot?.plans || [],
  getPlanWritePackage: () => plansSnapshot?.planWritePackage || {},
  onEnablePackage: () => { location.href = "/plans"; },
  onError: showWarning,
  readonly: true,
});

// Any source change can add or remove repositories, so Home re-reads its overview right away.
const sourcesDialog = createRepositorySourcesDialog({
  onPending: (isPending) => { if (isPending) { homeAutoDiscoveryEnabled = true; setHomeSyncStatus("syncing"); } },
  onChange: () => refresh({ force: true }),
});
  manageRepositories.addEventListener("click", (event) => {
    event.preventDefault();
    sourcesDialog.open();
  });
const onboarding = {
  onEnable: () => sourcesDialog.enableAutoDiscovery(),
  onAddFolder: () => sourcesDialog.open({ addFolder: true }),
};

const menuActions = {
  onMountLinks: (slot, entrypoint) => mountHomeLinks(slot, entrypoint, { onStale: refresh }),
  onToggleMenu: toggleActionMenu,
  onSelectMenu: selectRepositoryAction,
  onOpenPlan: openPlan,
};

// The plans snapshot supplies what the drawer resolves against (blockers, plan-write package state); it is
// fetched on open rather than polled, since Home only needs it while a drawer is showing.
async function openPlan(plan) {
  try {
    plansSnapshot = await fetchPlansSnapshot();
  } catch (error) {
    showWarning(error);
    return;
  }
  await planDrawer.open(plan.key);
}

function showWarning(error) {
  warning.textContent = `Plan unavailable: ${error.message || error}`;
  warning.hidden = false;
}

// `force` skips the active-control guard. After a menu action the clicked item keeps focus inside
// `content`, so without it the guard would hold back the very change the user just made. A forced
// call that lands mid-poll is queued rather than dropped, since that poll may have read pre-action
// state.
async function refresh({ force = false } = {}) {
  if (pending) {
    if (force) forceQueued = true;
    return;
  }
  pending = true;
  setHomeSyncStatus("syncing");
  try {
    const overview = await api.loadHomeOverview();
    homeAutoDiscoveryEnabled = overview.autoDiscovery?.enabled === true;
    setHomeSyncStatus(overview.sync?.state || "synced");
    scheduleSyncRefresh(overview.sync?.state);
    const version = JSON.stringify(overview);
    const hasActiveControl = !force && (content.contains(document.activeElement) || content.querySelector("details[open], .menu-button-panel, [data-menu]:not([hidden])") || document.querySelector("dialog[open]"));
    if (version !== renderedVersion && !hasActiveControl) {
      const known = overview.repositories.length > 0;
      const autoDiscoveryEnabled = overview.autoDiscovery?.enabled === true;
      const firstRunWithoutMocks = !known && !autoDiscoveryEnabled;
      const body = known
        ? repositoryDirectory(overview.repositories, menuActions)
        : firstRunWithoutMocks
          ? null
          : repositoryEmptyState({ autoDiscoveryEnabled, ...onboarding });
      content.replaceChildren(...(body ? [body] : []));
      homeHeading.hidden = firstRunWithoutMocks;
      manageRepositories.hidden = !known;
      autoDiscoveryMount.hidden = autoDiscoveryEnabled;
      autoDiscoveryMount.replaceChildren(...(autoDiscoveryMount.hidden ? [] : [autoDiscoveryPrompt(onboarding)]));
      mockDisclaimer.hidden = true;
      if (overview.unresolvedActivity.length) content.append(unresolvedActivity(overview.unresolvedActivity));
      renderedVersion = version;
    }
    warning.hidden = true;
    portalSetUpdatedAt(new Date(), { cadenceMs: POLL_MS });
  } catch (error) {
    clearSyncRefresh();
    setHomeSyncStatus("failed");
    warning.textContent = `Repository overview unavailable: ${error.message}`;
    warning.hidden = false;
    mockDisclaimer.hidden = true;
    if (!content.hasChildNodes()) content.replaceChildren(repositoryEmptyState({ autoDiscoveryEnabled: false, ...onboarding }));
  } finally {
    pending = false;
    portalHideLoading();
  }
  if (forceQueued) {
    forceQueued = false;
    await refresh({ force: true });
  }
}

function setHomeSyncStatus(state) {
  homeSyncStatus.hidden = !homeAutoDiscoveryEnabled;
  homeSyncStatus.classList.toggle("is-syncing", state === "syncing");
  homeSyncStatus.classList.toggle("is-synced", state === "synced");
  homeSyncStatus.classList.toggle("is-failed", state === "failed");
  const labels = { syncing: "Syncing", synced: "Synced", failed: "Sync failed" };
  homeSyncStatus.querySelector("[data-slot=text]").textContent = labels[state] || labels.syncing;
}

function scheduleSyncRefresh(state) {
  clearSyncRefresh();
  if (state !== "syncing") return;
  syncRetryTimer = setTimeout(() => {
    syncRetryTimer = null;
    refresh();
  }, 750);
}

function clearSyncRefresh() {
  if (syncRetryTimer === null) return;
  clearTimeout(syncRetryTimer);
  syncRetryTimer = null;
}

await Promise.all([refresh(), renderHarnessBanner()]);
setInterval(refresh, POLL_MS);

// The "install a supported harness" condition Agents and Tokens warn about, shown here as an info
// prompt (Home does not need a harness to work). Harness installation is a rare, out-of-band
// change, so it is checked once per page load rather than on every poll.
async function renderHarnessBanner() {
  try {
    const banner = harnessSetupPromptElement(await fetchSetupState());
    harnessBanner.replaceChildren(...(banner ? [banner] : []));
    harnessBanner.hidden = !banner;
  } catch {
    harnessBanner.hidden = true;
  }
}

function toggleActionMenu(card) {
  const menu = card.querySelector("[data-menu]");
  const trigger = card.querySelector("[data-action=menu]");
  if (!menu || !trigger) return;
  const willOpen = menu.hidden;
  closeActionMenus();
  menu.hidden = !willOpen;
  trigger.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) card.classList.add("has-open-menu");
}

function closeActionMenus() {
  for (const menu of content.querySelectorAll("[data-menu]")) {
    menu.hidden = true;
    menu.closest(".repository-card")?.classList.remove("has-open-menu");
    menu.closest(".action-menu")?.querySelector("[data-action=menu]")?.setAttribute("aria-expanded", "false");
  }
}

async function selectRepositoryAction(key, repository, item, event) {
  if (item.href) {
    closeActionMenus();
    return;
  }
  closeActionMenus();
  try {
    if (key === "pin") await api.setRepositoryPinned({ repositoryId: repository.repositoryId, pinned: !repository.pinned });
    else if (key === "hide") await api.setRepositoryVisibility({ repositoryId: repository.repositoryId, hidden: true });
    else if (key === "forget") await api.forgetRepository({ repositoryId: repository.repositoryId });
    renderedVersion = null;
    await refresh({ force: true });
  } catch (error) {
    warning.textContent = `Repository action unavailable: ${error.message}`;
    warning.hidden = false;
  }
}

document.addEventListener("click", (event) => {
  if (!event.target.closest(".action-menu")) closeActionMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeActionMenus();
});

for (const close of document.querySelectorAll("#api-route-dialog [data-close]")) {
  close.addEventListener("click", () => close.closest("dialog").close());
}
