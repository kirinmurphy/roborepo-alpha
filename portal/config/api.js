// Thin wrappers around the Config page's own /api/config/* endpoints. Pure request/response — no
// state, no DOM. app.js decides what to do with the results.

import { portalGetJson, portalPostJson } from "/portal/shared/api.js";
import { fetchSetupState } from "/portal/shared/setup-api.js";
import { TOGGLE_ENDPOINT } from "./state.js";

export { fetchSetupState };

export function refreshHarnesses() {
  return portalPostJson("/api/config/harnesses/refresh", {});
}

export function fetchConfig() {
  return portalGetJson("/api/config");
}

export function fetchSource({ kind, id, harness }) {
  const qs = new URLSearchParams({ kind, id });
  if (harness) qs.set("harness", harness);
  return portalGetJson("/api/config/source?" + qs.toString());
}

export function toggleItem(kind, id, enabled) {
  return portalPostJson(TOGGLE_ENDPOINT[kind], { id, enabled });
}

// Section-level bulk toggle: one request applies the whole batch, runs the single reconcile pass
// server-side, and returns the fresh snapshot. 409 = another batch in flight or preflight
// rejection (results carries per-id detail).
export function bulkTogglePackages(ids, enabled) {
  return portalPostJson("/api/config/packages/bulk", { ids, enabled });
}

export function applyPermission(payload) {
  return portalPostJson("/api/config/permissions", payload);
}

// Managed cleanup. Preview is a GET (mutates nothing); execute requires an explicit confirm flag
// server-side in addition to the portal's origin+token mutation guard.
export function fetchUninstallPreview() {
  return portalGetJson("/api/maintenance/uninstall/preview");
}

export function executeUninstall() {
  return portalPostJson("/api/maintenance/uninstall", { confirm: true });
}
