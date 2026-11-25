// Thin wrappers around the Config page's own /api/config/* endpoints. Pure request/response — no
// state, no DOM. app.js decides what to do with the results.

import { portalGetJson, portalPostJson, portalSendJson } from "/portal/shared/api.js";
import { fetchSetupState } from "/portal/shared/setup-api.js";
import { TOGGLE_ENDPOINT } from "./state.js";

export { fetchSetupState };

export function fetchConfig() {
  return portalGetJson("/api/config");
}

export function fetchSource({ kind, id, harness }) {
  const qs = new URLSearchParams({ kind, id });
  if (harness) qs.set("harness", harness);
  return portalGetJson("/api/config/source?" + qs.toString());
}

// The selected repo's own agent files (read-only), and one file's preview by its inventory id.
export function fetchRepositoryInventory(scope) {
  return portalGetJson("/api/config/repository?" + new URLSearchParams({ repo: scope }).toString());
}

export function fetchRepositorySource(scope, id) {
  return portalGetJson("/api/config/repository/source?" + new URLSearchParams({ repo: scope, id }).toString());
}

// `cascade` (package disables only) also disables the selected packages that include `id`.
export function toggleItem(kind, id, enabled, { cascade = false } = {}) {
  return portalPostJson(TOGGLE_ENDPOINT[kind], cascade ? { id, enabled, cascade } : { id, enabled });
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

// Package sources and installs (/api/packages/*): the same package service the CLI calls. Each
// route answers { ok, result }; these return the result. A refusal throws with the service's
// message, `code`, and `details`.
const resultOf = (request) => request.then((data) => data.result);
const segment = (value) => encodeURIComponent(value);

export function fetchPackages() {
  return resultOf(portalGetJson("/api/packages"));
}

export function fetchSources() {
  return resultOf(portalGetJson("/api/packages/sources"));
}

export function fetchSourceInfo(id) {
  return resultOf(portalGetJson(`/api/packages/sources/${segment(id)}`));
}

export function addPackageSource(location, id = null) {
  return resultOf(portalPostJson("/api/packages/sources", id ? { location, id } : { location }));
}

export function refreshPackageSource(id) {
  return resultOf(portalPostJson(`/api/packages/sources/${segment(id)}/refresh`, {}));
}

export function setPackageSourceEnabled(id, enabled) {
  return resultOf(portalPostJson(`/api/packages/sources/${segment(id)}/enabled`, { enabled }));
}

export function removePackageSource(id, { keepInstalled = false } = {}) {
  return resultOf(portalSendJson("DELETE", `/api/packages/sources/${segment(id)}${keepInstalled ? "?keepInstalled=1" : ""}`));
}

export function fetchInstallPreview(ref) {
  return resultOf(portalGetJson(`/api/packages/install-preview?${new URLSearchParams({ ref })}`));
}

export function installPackage(ref, expectedPlan) {
  return resultOf(portalPostJson("/api/packages/install", { ref, expectedPlan }));
}

// Without `change`, asks what an update would change: the service refuses with
// `confirmationRequired` and `details.change` when there is a change. With it, moves to exactly
// that change's `to`, from its `from`.
export function updatePackage(ref, change = null) {
  const body = change ? { ref, confirmed: true, expectedRevision: change.to, expectedFrom: change.from } : { ref };
  return resultOf(portalPostJson("/api/packages/update", body));
}

// `ref` is encoded so a qualified name (`team/tool`) stays one path segment.
export function removePackage(ref) {
  return resultOf(portalSendJson("DELETE", `/api/packages/installed/${segment(ref)}`));
}
