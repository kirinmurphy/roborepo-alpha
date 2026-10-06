import { portalHideLoading, portalSetUpdatedAt } from "/portal/shared/api.js";
import { createRepositorySourcesDialog } from "/portal/shared/repository-sources-dialog.js";
import * as api from "./api.js";
import { harnessRow } from "./templates.js";

const errorNode = document.getElementById("settings-error");
const summaryNode = document.getElementById("repositories-summary");
const autoToggle = document.getElementById("auto-discovery-toggle");
const harnessList = document.getElementById("harness-list");
const telemetryToggle = document.getElementById("telemetry-toggle");
const checkHarnesses = document.getElementById("check-harnesses");
let setup = null;
let pending = false;

const sourcesDialog = createRepositorySourcesDialog({ onChange: refresh });
document.getElementById("manage-repositories").addEventListener("click", () => sourcesDialog.open());
autoToggle.addEventListener("click", toggleAutoDiscovery);
checkHarnesses.addEventListener("click", refreshHarnesses);
telemetryToggle.addEventListener("change", toggleTelemetry);

async function refresh() {
  if (pending) return;
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
    portalHideLoading();
  }
}

function render() {
  const repos = setup.repositories;
  const sourceLabel = repos.hasConfiguredSources ? "Explicit repository or folder sources are configured." : "No explicit repository or folder sources are configured.";
  summaryNode.textContent = `${repos.knownCount} known ${repos.knownCount === 1 ? "repository" : "repositories"} · ${repos.visibleCount} visible. ${sourceLabel}`;
  autoToggle.textContent = repos.autoDiscoveryEnabled ? "Turn off" : "Turn on";
  autoToggle.setAttribute("aria-pressed", String(repos.autoDiscoveryEnabled));
  telemetryToggle.checked = setup.telemetry.enabled;
  const detected = new Map(setup.harnesses.detected.map((harness) => [harness.id, harness]));
  harnessList.replaceChildren(...setup.harnesses.supported.map((harness) => harnessRow(harness, detected, toggleHarness)));
}

async function toggleAutoDiscovery() {
  autoToggle.disabled = true;
  try {
    await api.setSourceEnabled("auto-discovery", !setup.repositories.autoDiscoveryEnabled);
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    autoToggle.disabled = false;
  }
}

async function refreshHarnesses() {
  checkHarnesses.disabled = true;
  showError(null);
  try {
    await api.refreshHarnesses();
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    checkHarnesses.disabled = false;
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
  try {
    await api.setTelemetryEnabled(telemetryToggle.checked);
    await refresh();
  } catch (error) {
    telemetryToggle.checked = setup.telemetry.enabled;
    showError(error);
  } finally {
    telemetryToggle.disabled = false;
  }
}

function showError(error) {
  errorNode.hidden = !error;
  errorNode.textContent = error ? String(error.message || error) : "";
}

refresh();
