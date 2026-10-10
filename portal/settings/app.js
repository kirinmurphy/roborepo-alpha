import { portalHideLoading, portalSetUpdatedAt } from "/portal/shared/api.js";
import { runHarnessCheck } from "/portal/shared/harness-warning.js";
import { createRepositorySourcesInline } from "/portal/shared/repository-sources-dialog.js";
import * as api from "./api.js";
import { harnessEmptyState, harnessRow } from "./templates.js";

const main = document.getElementById("main");
const errorNode = document.getElementById("settings-error");
const harnessList = document.getElementById("harness-list");
const telemetryToggle = document.getElementById("telemetry-toggle");
const tokenTrackingActive = document.getElementById("token-tracking-active");
const tokenTrackingEnableCopy = document.getElementById("token-tracking-enable-copy");
const checkHarnesses = document.getElementById("check-harnesses");
const repoSyncStatus = document.getElementById("settings-repo-sync-status");
const repoSyncStatusText = repoSyncStatus.querySelector("[data-slot=text]");
let setup = null;
let pending = false;
let refreshQueued = false;
let syncPollTimer = null;
let repositorySyncPending = false;

let repositorySurface;
repositorySurface = createRepositorySourcesInline({
  onChange: refresh,
  onPending: setRepositorySyncPending,
  onAutoDiscoveryEnabled: refreshRepositoriesAfterRuntimeScan,
});
checkHarnesses.addEventListener("click", refreshHarnesses);
telemetryToggle.addEventListener("click", toggleTelemetry);

async function refresh() {
  if (pending) {
    refreshQueued = true;
    return;
  }
  pending = true;
  showError(null);
  try {
    setup = await api.fetchSetupState();
    render();
    portalSetUpdatedAt(new Date());
  } catch (error) {
    showError(error);
  } finally {
    pending = false;
    main.setAttribute("aria-busy", "false");
    portalHideLoading();
    void refreshRepositorySyncStatus();
  }
  if (refreshQueued) {
    refreshQueued = false;
    await refresh();
  }
}

function setRepositorySyncPending(isPending) {
  repositorySyncPending = isPending;
  if (isPending) {
    repoSyncStatus.hidden = false;
    repoSyncStatus.classList.remove("is-synced", "is-failed");
    repoSyncStatus.classList.add("is-syncing");
    repoSyncStatusText.textContent = "Syncing";
    clearTimeout(syncPollTimer);
  } else {
    void refreshRepositorySyncStatus();
  }
}

async function refreshRepositorySyncStatus() {
  if (repositorySyncPending) return;
  repoSyncStatus.hidden = setup?.repositories?.autoDiscoveryEnabled !== true;
  try {
    const overview = await api.fetchHomeOverview();
    if (repositorySyncPending) return;
    const state = overview.sync?.state || "synced";
    repoSyncStatus.hidden = overview.autoDiscovery?.enabled !== true;
    repoSyncStatus.classList.toggle("is-syncing", state === "syncing");
    repoSyncStatus.classList.toggle("is-synced", state === "synced");
    repoSyncStatus.classList.toggle("is-failed", state === "failed");
    repoSyncStatusText.textContent = ({ syncing: "Syncing", synced: "Synced", failed: "Sync failed" })[state] || "Synced";
    clearTimeout(syncPollTimer);
    if (state === "syncing") syncPollTimer = setTimeout(refreshRepositorySyncStatus, 750);
  } catch {
    if (repositorySyncPending) return;
    clearTimeout(syncPollTimer);
    repoSyncStatus.classList.remove("is-syncing", "is-synced");
    repoSyncStatus.classList.add("is-failed");
    repoSyncStatusText.textContent = "Sync status unavailable";
  }
}

function render() {
  const telemetryOn = setup.telemetry.enabled;
  const telemetryAction = telemetryOn ? "Disable" : "Enable";
  telemetryToggle.textContent = telemetryAction;
  telemetryToggle.setAttribute("data-btn", telemetryOn ? "secondary" : "cta");
  telemetryToggle.setAttribute("aria-pressed", String(telemetryOn));
  telemetryToggle.setAttribute("aria-label", `${telemetryAction} token tracking`);
  telemetryToggle.disabled = false;
  tokenTrackingActive.hidden = !telemetryOn;
  tokenTrackingEnableCopy.hidden = telemetryOn;
  const detected = new Map(setup.harnesses.detected.map((harness) => [harness.id, harness]));
  const rows = setup.harnesses.supported.length
    ? setup.harnesses.supported.map((harness) => harnessRow(harness, detected, toggleHarness))
    : [harnessEmptyState()];
  harnessList.replaceChildren(...rows);
}

async function refreshHarnesses() {
  showError(null);
  await runHarnessCheck(checkHarnesses, async () => {
    await api.refreshHarnesses();
    await refresh();
  }).catch(showError);
}

async function refreshRepositoriesAfterRuntimeScan() {
  setRepositorySyncPending(true);
  try {
    await api.refreshDeveloperRuntime();
    await repositorySurface.refresh();
    await refresh();
  } catch (error) {
    showError(error);
    repoSyncStatus.classList.remove("is-syncing", "is-synced");
    repoSyncStatus.classList.add("is-failed");
    repoSyncStatusText.textContent = "Sync failed";
  } finally {
    repositorySyncPending = false;
    await refreshRepositorySyncStatus();
  }
}

async function toggleHarness(id, enabled) {
  showError(null);
  try {
    await api.setHarnessEnabled(id, enabled);
    await refresh();
  } catch (error) {
    showError(error);
  }
}

async function toggleTelemetry() {
  telemetryToggle.disabled = true;
  telemetryToggle.setAttribute("aria-busy", "true");
  telemetryToggle.textContent = "Saving…";
  try {
    await api.setTelemetryEnabled(telemetryToggle.getAttribute("aria-pressed") !== "true");
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    telemetryToggle.disabled = false;
    telemetryToggle.removeAttribute("aria-busy");
    if (setup) render();
  }
}

function showError(error) {
  errorNode.hidden = !error;
  errorNode.textContent = error ? String(error.message || error) : "";
  if (error && !setup) {
    telemetryToggle.disabled = true;
  }
}

refresh();
