import { portalGetJson, portalPostJson } from "/portal/shared/api.js";
import { fetchSetupState } from "/portal/shared/setup-api.js";
import { setSourceEnabled } from "/portal/shared/repository-sources-api.js";

export { fetchSetupState, setSourceEnabled };

export function refreshHarnesses() {
  return portalPostJson("/api/config/harnesses/refresh", {});
}

export function setHarnessEnabled(id, enabled) {
  return portalPostJson(`/api/config/harnesses/${encodeURIComponent(id)}/enabled`, { enabled });
}

export function setTelemetryEnabled(enabled) {
  return portalPostJson("/api/config/packages", { id: "telemetry", enabled });
}

export function refreshDeveloperRuntime() {
  return portalPostJson("/api/developer-runtime/refresh", {});
}

export function fetchHomeOverview() {
  return portalGetJson("/api/home");
}
