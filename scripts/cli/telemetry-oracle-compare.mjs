import { analyzeTelemetry } from "./telemetry-analyze.mjs";
import { buildRepositoryHashIndex } from "./telemetry-repository.mjs";
import { privacyHash } from "./telemetry-schemas/hash.mjs";
import { runTelemetryOracle, inspectOracleEvidence } from "./telemetry-oracle-run.mjs";
import { stableJson } from "./telemetry-oracle-observations.mjs";
import { POLICY, rowSort } from "./telemetry-oracle-cohorts.mjs";

const CHECKS = ["sessions", "operations", "conditions", "boundaries", "gating", "regression", "loops"];

// This boundary alone knows both implementations. It never returns raw projections or errors
// to a live caller; the CI runner separately uses comparisonEntries for synthetic replay output.
export function compareTelemetryOracle(events, options = {}, { analyze = analyzeTelemetry } = {}) {
  const coverage = inspectOracleEvidence(events, options);
  const counts = { event_count: Array.isArray(events) ? events.length : 0, session_count: 0, operation_count: 0 };
  if (!coverage.comparable || !counts.event_count) return result("unavailable", counts, coverage, [], []);
  try {
    const expected = runTelemetryOracle(events, options);
    counts.session_count = expected.session_count;
    counts.operation_count = expected.operation_count;
    const repositoryHashIndex = buildRepositoryHashIndex(options.repositoryRegistry, privacyHash);
    const report = analyze(events, { snapshots: options.snapshots ?? [], markers: options.markers ?? [], repositoryHashIndex });
    const differences = comparisonEntries(report, expected)
      .filter(({ actual, expected: value }) => stableJson(actual) !== stableJson(value)).map(({ field }) => field);
    return result(differences.length ? "failed" : coverage.complete ? "passed" : "partial", counts, coverage, differences, CHECKS);
  } catch {
    // Exceptions can contain local paths, raw values, or prompt text. A fixed category is enough
    // for the observer; operational failure is not evidence of an analytics disagreement.
    return { ...result("unavailable", counts, coverage, [], []), error_category: "comparison_error" };
  }
}

export function comparisonEntries(report, expected) {
  const policy = report.conditions.policy;
  return [
    { field: "policy", actual: { minimum_cohort: policy.minimum_cohort, minimum_events: policy.minimum_events,
      display_band: policy.display_band }, expected: POLICY },
    { field: "session_count", actual: report.conditions.data_quality.sessions, expected: expected.session_count },
    { field: "token_session_count", actual: report.sessions.length, expected: expected.token_session_count },
    { field: "operation_count", actual: report.conditions.data_quality.flows, expected: expected.operation_count },
    { field: "token_operation_count", actual: report.capture_count, expected: expected.token_operation_count },
    { field: "conditions", actual: report.conditions.comparisons.map(conditionProjection).sort(rowSort),
      expected: expected.conditions.map(conditionProjection) },
    { field: "changes", actual: report.conditions.changes.map((change) => changeProjection(change.marker.marker_id, change.comparisons))
      .sort((a, b) => a.marker_id.localeCompare(b.marker_id)),
      expected: expected.changes.map((change) => changeProjection(change.marker_id, change.comparisons)) },
    { field: "regression", actual: { split_ts: report.regression.split_ts,
      groups: report.regression.groups.map((row) => ({ ...row })).sort((a, b) => a.group.localeCompare(b.group)) }, expected: expected.regression },
  ];
}

function result(status, counts, coverage, differences, checks) {
  const summaries = {
    passed: "Production and oracle calculations agree for all supplied supported evidence.",
    partial: "Covered calculations agree, but required evidence is incomplete or unresolved.",
    unavailable: "A complete comparable input could not be evaluated.",
    failed: "Production and oracle calculations disagree on covered fields.",
  };
  return { status, ...counts, coverage: { ...coverage, checks: [...checks] }, differences, summary: summaries[status] };
}

function conditionProjection(row) {
  return { dimension: row.dimension, value: row.value, event_kind: row.event_kind,
    with_condition: row.with_condition, without_condition: row.without_condition, unknown_condition: row.unknown_condition,
    known_condition: row.known_condition, total_observations: row.total_observations, coverage: row.coverage,
    with_affected: row.with_affected, without_affected: row.without_affected, with_rate: row.with_rate,
    without_rate: row.without_rate, relative_delta: row.relative_delta, comparison_available: row.comparison_available,
    percent_available: row.percent_available };
}

function changeProjection(markerId, comparisons) {
  return { marker_id: markerId, comparisons: comparisons.map((row) => ({
    event_kind: row.event_kind, before: row.before, after: row.after, ambiguous_boundary: row.ambiguous_boundary,
    spanning_boundary: row.spanning_boundary, unknown_condition: row.unknown_condition, state: row.state,
    relative_delta: row.relative_delta,
  })).sort((a, b) => a.event_kind.localeCompare(b.event_kind)) };
}
