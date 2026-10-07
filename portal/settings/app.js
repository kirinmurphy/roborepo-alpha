import { portalHideLoading, portalSetUpdatedAt } from "/portal/shared/api.js";
import { createRepositorySourcesInline } from "/portal/shared/repository-sources-dialog.js";
import * as api from "./api.js";
import { harnessEmptyState, harnessRow } from "./templates.js";

const main = document.getElementById("main");
const errorNode = document.getElementById("settings-error");
const harnessList = document.getElementById("harness-list");
const telemetryToggle = document.getElementById("telemetry-toggle");
const checkHarnesses = document.getElementById("check-harnesses");
let setup = null;
let pending = false;

createRepositorySourcesInline({ onChange: refresh });
checkHarnesses.addEventListener("click", refreshHarnesses);
telemetryToggle.addEventListener("click", toggleTelemetry);

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
    main.setAttribute("aria-busy", "false");
    portalHideLoading();
  }
}

function render() {
  const telemetryOn = setup.telemetry.enabled;
  const telemetryAction = telemetryOn ? "Disable" : "Enable";
  telemetryToggle.textContent = telemetryAction;
  telemetryToggle.setAttribute("aria-pressed", String(telemetryOn));
  telemetryToggle.setAttribute("aria-label", `${telemetryAction} token telemetry`);
  telemetryToggle.disabled = false;
  const detected = new Map(setup.harnesses.detected.map((harness) => [harness.id, harness]));
  const rows = setup.harnesses.supported.length
    ? setup.harnesses.supported.map((harness) => harnessRow(harness, detected, toggleHarness))
    : [harnessEmptyState()];
  harnessList.replaceChildren(...rows);
}

async function refreshHarnesses() {
  checkHarnesses.disabled = true;
  checkHarnesses.setAttribute("aria-busy", "true");
  checkHarnesses.textContent = "Checking…";
  showError(null);
  try {
    await api.refreshHarnesses();
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    checkHarnesses.disabled = false;
    checkHarnesses.removeAttribute("aria-busy");
    checkHarnesses.textContent = "Check for installs";
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
