// This entry point is safe to import at runtime: no fixtures, I/O, logging, or production helpers.
import { acceptedRows, canonicalOperations, buildSessions, hasTokens, sessionKey, repositoryEvidence, eventSupport, isRecord } from "./telemetry-oracle-observations.mjs";
import { spikeSessions, loopSessions, readWarningSessions } from "./telemetry-oracle-findings.mjs";
import { conditionRows, changeRows, snapshotSupport, markerSupport, sessionSupport } from "./telemetry-oracle-cohorts.mjs";
import { regression } from "./telemetry-oracle-regression.mjs";

export function runTelemetryOracle(events, { snapshots = [], markers = [], repositoryRegistry = null } = {}) {
  const rawRows = acceptedRows(events), operations = canonicalOperations(rawRows);
  const sessions = buildSessions(rawRows, repositoryEvidence(repositoryRegistry).index);
  const affectedByKind = new Map([
    ["spike", spikeSessions(operations.rows)], ["loop", loopSessions(operations.rows)], ["read-warning", readWarningSessions(operations.rows)],
  ]);
  return { session_count: sessions.length,
    token_session_count: new Set(operations.rows.filter(hasTokens).map(sessionKey)).size,
    operation_count: operations.count, token_operation_count: operations.rows.filter(hasTokens).length,
    conditions: conditionRows(sessions, snapshots, affectedByKind),
    changes: changeRows(sessions, snapshots, markers, affectedByKind), regression: regression(operations.rows),
    affected_session_counts: Object.fromEntries([...affectedByKind].map(([kind, sessions]) => [kind, sessions.size])) };
}

// Coverage counts every supplied row, including rows normalization would otherwise discard.
// Readers must also report skipped/malformed persisted records in skippedEvidence.
export function inspectOracleEvidence(events, options = {}) {
  if (!isRecord(options)) return { supported_events: 0, unsupported_events: Array.isArray(events) ? events.length : 0,
    comparable: false, complete: false, issues: [{ category: "malformed_evidence", count: 1 }] };
  const { snapshots = [], markers = [], repositoryRegistry = null, skippedEvidence = {} } = options;
  const issues = new Map();
  let comparable = true, supported = 0;
  function record(support) {
    comparable &&= support.comparable;
    for (const category of support.issues) issues.set(category, (issues.get(category) ?? 0) + 1);
  }
  if (!Array.isArray(events) || !Array.isArray(snapshots) || !Array.isArray(markers)) {
    return { supported_events: 0, unsupported_events: Array.isArray(events) ? events.length : 0,
      comparable: false, complete: false, issues: [{ category: "malformed_evidence", count: 1 }] };
  }
  const registry = repositoryEvidence(repositoryRegistry);
  record({ issues: registry.issues, comparable: registry.issues.length === 0 });
  if (Object.keys(options).some((key) => !["snapshots", "markers", "repositoryRegistry", "skippedEvidence"].includes(key))) {
    record({ issues: ["unsupported_analysis_options"], comparable: false });
  }
  const snapshotIndex = new Map();
  for (const snapshot of snapshots) {
    record(snapshotSupport(snapshot));
    if (snapshotIndex.has(snapshot?.snapshot_id)) record({ issues: ["duplicate_snapshot_id"], comparable: false });
    snapshotIndex.set(snapshot?.snapshot_id, snapshot);
  }
  const markerIds = new Set();
  for (const marker of markers) {
    record(markerSupport(marker));
    if (markerIds.has(marker?.marker_id)) record({ issues: ["duplicate_marker_id"], comparable: false });
    markerIds.add(marker?.marker_id);
  }
  for (const marker of markers) {
    if (marker?.supersedes && !markerIds.has(marker.supersedes)) record({ issues: ["unresolved_marker_supersedes"], comparable: true });
  }
  for (const row of events) {
    const support = eventSupport(row, registry.index);
    const snapshot = snapshotIndex.get(row?.config_snapshot_id);
    support.issues.push(...(snapshot ? snapshotSupport(snapshot).issues : ["missing_snapshot"]));
    record(support);
    if (!support.issues.length) supported++;
  }
  if (comparable) record(sessionSupport(buildSessions(acceptedRows(events), registry.index)));
  if (!isRecord(skippedEvidence) || Object.values(skippedEvidence).some((count) => !Number.isSafeInteger(count) || count < 0)) {
    record({ issues: ["malformed_evidence_accounting"], comparable: false });
  } else {
    const skipped = Object.values(skippedEvidence).reduce((sum, count) => sum + count, 0);
    if (skipped > 0) issues.set("skipped_evidence", skipped);
  }
  return { supported_events: supported, unsupported_events: events.length - supported,
    comparable, complete: issues.size === 0,
    issues: [...issues].map(([category, count]) => ({ category, count })).sort((a, b) => a.category.localeCompare(b.category)) };
}
