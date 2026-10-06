import { repositoryIdForUrlKey } from "../../modules/repositories/index.mjs";
import {
  composeHomeOverview,
  composeRepositoryDetail,
  plansDomainState,
  runtimeDomainState,
  telemetryDomainState,
  unavailableState,
} from "./repository-overview-projections.mjs";

// `loadAutoDiscoveryEnabled` lets Home choose between its empty states and the compact Enable
// prompt; an unreadable answer is treated as off, since off is what Runtime then does too.
export function createRepositoryOverviewService({ loadRegistry, loadRuntime, loadPlans, loadTelemetry, loadAutoDiscoveryEnabled = () => false, now = () => new Date(), loadMockHomeOverview = null, mockHomeEnabled = false }) {
  function loadHome() {
    const registry = loadRegistry();
    if (mockHomeEnabled && Object.keys(registry.repositories || {}).length === 0 && loadMockHomeOverview) {
      let enabled = false;
      try { enabled = loadAutoDiscoveryEnabled() === true; } catch {}
      return { ...loadMockHomeOverview({ now: now().toISOString() }), autoDiscovery: { enabled }, sync: { state: "synced" } };
    }
    const runtimeState = safely(loadRuntime, runtimeDomainState, "Runtime data is unavailable");
    const overview = composeHomeOverview({
      registry,
      runtimeState,
      plansState: safely(loadPlans, plansDomainState, "Plans data is unavailable"),
      telemetryState: safely(loadTelemetry, telemetryDomainState, "Tokens data is unavailable"),
      now: now(),
    });
    let enabled = false;
    try { enabled = loadAutoDiscoveryEnabled() === true; } catch {}
    return { ...overview, autoDiscovery: { enabled }, sync: syncState(runtimeState) };
  }

  function loadDetail({ urlKey }) {
    const registry = loadRegistry();
    const repositoryId = repositoryIdForUrlKey(registry, urlKey);
    if (!repositoryId) throw notFound(urlKey);
    const home = composeHomeOverview({
      registry,
      runtimeState: safely(loadRuntime, runtimeDomainState, "Runtime data is unavailable"),
      plansState: safely(loadPlans, plansDomainState, "Plans data is unavailable"),
      telemetryState: safely(loadTelemetry, telemetryDomainState, "Tokens data is unavailable"),
      now: now(),
    });
    const detail = composeRepositoryDetail(registry.repositories[repositoryId], home);
    if (!detail) throw notFound(urlKey);
    return { updatedAt: home.updatedAt, repository: detail };
  }

  return { loadHome, loadDetail };
}

function syncState(runtimeState) {
  return { state: runtimeState.data?.refresh?.state === "refreshing" ? "syncing" : "synced" };
}

function safely(loader, project, message) {
  try {
    return project(loader());
  } catch (error) {
    return unavailableState(`${message}: ${String(error?.message || error)}`);
  }
}

function notFound(urlKey) {
  const error = new Error(`unknown repository: ${urlKey}`);
  error.code = "NOT_FOUND";
  return error;
}
