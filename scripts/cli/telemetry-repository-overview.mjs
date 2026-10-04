import { isFixtureRepository } from "../../modules/developer-runtime/snapshot.mjs";
import { analyzeTelemetry } from "./telemetry-analyze.mjs";
import { repositoryRefForEvent } from "./telemetry-repository.mjs";

// Home's Tokens projection. With capture switched off it reads as unavailable even when an older
// spool is still on disk, matching the Tokens page, which shows its setup banner instead of that
// spool. Dev fixture repositories carry their fixture spool's warnings (`fixtureRepositories`) either
// way, so their cards show the domain without anyone enabling capture.
export function homeTelemetryProjection({ enabled, projection, fixtureRepositories = {} }) {
  if (!enabled) return { status: "unavailable", updatedAt: null, message: "Token tracking is off", repositories: {}, fixtureRepositories };
  return { ...projection, fixtureRepositories };
}

// Per-repository summaries for the dev fixtures, from spool-format rows run through the same
// analysis as captured telemetry. Rows naming any other repository are dropped, so fixture data can
// never put warnings on a real repository's card.
export function fixtureTelemetryRepositories(events) {
  const fixtureEvents = events.filter((event) => isFixtureRepository(event.repo?.repository_id));
  if (!fixtureEvents.length) return {};
  return buildTelemetryRepositoryProjection(fixtureEvents, analyzeTelemetry(fixtureEvents, {}), null).repositories;
}

export function buildTelemetryRepositoryProjection(events, report, repositoryHashIndex) {
  const repositoryBySession = new Map();
  let updatedAt = null;
  for (const event of events) {
    if (!updatedAt || event.ts > updatedAt) updatedAt = event.ts;
    const repositoryId = repositoryRefForEvent(event, repositoryHashIndex).repositoryId;
    if (repositoryId) repositoryBySession.set(sessionKey(event), repositoryId);
  }

  const repositories = {};
  const ensure = (repositoryId) => repositories[repositoryId] || (repositories[repositoryId] = {
    sessionCount: 0,
    warningCount: 0,
    highestSeverity: null,
    recent: [],
    warnings: [],
  });
  for (const session of report.sessions || []) {
    const repositoryId = repositoryBySession.get(sessionKey(session));
    if (repositoryId) ensure(repositoryId).sessionCount += 1;
  }
  for (const [kind, severity, rows] of [
    ["spike", "high", report.spikes || []],
    ["loop", "high", report.loops || []],
    ["read-warning", "warn", report.read_warnings || []],
  ]) {
    for (const row of rows) addWarning(repositoryBySession, ensure, kind, severity, row);
  }
  for (const summary of Object.values(repositories)) {
    summary.warnings.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    summary.recent = summary.warnings.slice(0, 5);
  }
  return { status: "available", updatedAt, repositories };
}

function addWarning(repositoryBySession, ensure, kind, severity, row) {
  const repositoryId = repositoryBySession.get(sessionKey(row));
  if (!repositoryId) return;
  const summary = ensure(repositoryId);
  summary.warningCount += 1;
  if (summary.highestSeverity !== "high") summary.highestSeverity = severity;
  // Model comes from the conditions ledger attached in analyzeTelemetry; Home rolls warnings up by it.
  summary.warnings.push({ kind, severity, sessionId: row.session_id, harness: row.harness || null, model: row.condition_context?.model || null, at: row.ts || null });
}

function sessionKey(record) {
  return `${record.harness || "unknown"}:${record.session_id || "unknown"}`;
}
