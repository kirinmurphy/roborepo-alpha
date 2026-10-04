// Thin wrappers around the Plans page's own /api/plans/* endpoints. Pure request/response — no
// state, no DOM. app.js decides what to do with the results.

import { portalGetJson, portalPostJson } from "/portal/shared/api.js";

export function fetchSnapshot() {
  return portalGetJson("/api/plans");
}

export function refreshSnapshot() {
  return portalPostJson("/api/plans/refresh", {});
}

export function saveDiscoveryRoots(discoveryRoots) {
  return portalPostJson("/api/plans/settings", { discoveryRoots });
}

export function updatePlanPriority(id, key, priority, expectedPriority, mtimeMs, repositoryId) {
  return portalPostJson("/api/plans/priority", { id, key, priority, expectedPriority, mtimeMs, repositoryId });
}

export function updatePlanLifecycle(id, key, lifecycle, expectedLifecycle, mtimeMs, repositoryId, skipDestinationValidation) {
  return portalPostJson("/api/plans/lifecycle", { id, key, lifecycle, expectedLifecycle, mtimeMs, repositoryId, skipDestinationValidation });
}

export function fetchPlanDocument(key) {
  return portalGetJson(`/api/plans/document?key=${encodeURIComponent(key)}`);
}

export function generatePrompt(action, keys, mode = "repository-aware") {
  return portalPostJson("/api/plans/prompt", { action, keys, mode }).then(
    (result) => result.prompt,
  );
}

// The plan suite's packages, in lifecycle order. The onboarding banner enables them as one unit
// through the config section's bulk endpoint: one preflight, one reconcile pass.
export const PLAN_SUITE_PACKAGES = ["plan-write", "plan-promote", "plan-start", "plan-close", "session-close"];

export function enablePlanSuitePackages() {
  return portalPostJson("/api/config/packages/bulk", {
    ids: PLAN_SUITE_PACKAGES,
    enabled: true,
  });
}
