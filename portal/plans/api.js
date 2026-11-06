// Thin wrappers around the Plans page's own /api/plans/* endpoints. Pure request/response — no
// state, no DOM. app.js decides what to do with the results. Snapshot reads carry the shared
// repository scope from the URL.

import { portalGetJson, portalPostJson } from "/portal/shared/api.js";
import { withRepositoryScope } from "/portal/shared/repository-scope.js";

export function fetchSnapshot() {
  return portalGetJson(withRepositoryScope("/api/plans"));
}

export function fetchHomeOverview() {
  return portalGetJson("/api/home");
}

export function refreshSnapshot() {
  return portalPostJson(withRepositoryScope("/api/plans/refresh"), {});
}

// One namespace's whole order. A draft opened from an older revision is refused with STALE_ORDER.
export function saveBacklogOrder({ repositoryId, namespace, order, unprioritized, revision }) {
  return portalPostJson("/api/plans/order", { repositoryId, namespace, order, unprioritized, revision });
}

export function setNamespacePinned({ repositoryId, namespace, pinned }) {
  return portalPostJson("/api/plans/namespace-pin", { repositoryId, namespace, pinned });
}

// Moves one unprioritized Backlog plan to Archived, in a commit on the repo's base branch that also
// clears it from the plans depending on it.
export function archiveBacklogPlan({ repositoryId, id, reason }) {
  return portalPostJson("/api/plans/archive", { repositoryId, id, reason });
}

export function fetchPlanDocument(key) {
  return portalGetJson(`/api/plans/document?key=${encodeURIComponent(key)}`);
}

export function generatePrompt(action, keys, mode = "repository-aware") {
  return portalPostJson("/api/plans/prompt", { action, keys, mode }).then(
    (result) => result.prompt,
  );
}

// The packages the plan suite needs: plan-suite and session-close. The onboarding banner enables them as one unit
// through the config bulk endpoint (/api/config/packages/bulk): one preflight, one reconcile pass.
export const PLAN_SUITE_PACKAGES = ["plan-suite", "session-close"];

export function enablePlanSuitePackages() {
  return portalPostJson("/api/config/packages/bulk", {
    ids: PLAN_SUITE_PACKAGES,
    enabled: true,
  });
}
