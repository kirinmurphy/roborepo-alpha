export const ORACLE_RESULT_SCHEMA_VERSION = 1;

const CHECKS = ["sessions", "operations", "conditions", "boundaries", "gating", "regression", "loops"];
const FIELDS = ["policy", "session_count", "token_session_count", "operation_count", "token_operation_count", "conditions", "changes", "regression"];
const ISSUES = ["malformed_evidence", "unsupported_analysis_options", "duplicate_snapshot_id", "duplicate_marker_id",
  "unresolved_marker_supersedes", "missing_snapshot", "malformed_evidence_accounting", "skipped_evidence",
  "malformed_repository_registry", "ambiguous_repository_registry", "malformed_event", "unsupported_event_schema",
  "unidentified_session", "invalid_timestamp", "malformed_tokens", "malformed_repository", "unsupported_bare_tool",
  "unresolved_repository", "unknown_model", "malformed_snapshot", "unsupported_snapshot_schema", "unknown_snapshot_condition",
  "malformed_marker", "unsupported_marker_schema", "unsupported_marker_type", "missing_marker_kinds", "unsupported_marker_kind",
  "unknown_marker_scope", "unknown_session_condition", "changing_session_snapshot"];
const ERRORS = ["comparison_error", "evidence_read_error"];
const SUMMARIES = {
  passed: "Production and oracle calculations agree for the checked supported evidence.",
  partial: "Covered calculations agree, but required evidence is incomplete or unresolved.",
  unavailable: "A complete comparable input could not be evaluated.",
  failed: "Production and oracle calculations disagree on covered fields.",
};

export const ORACLE_STATUSES = Object.freeze(Object.keys(SUMMARIES));

// Construct an explicit output projection: never spread comparison data or exception text into it.
// A comparison that breaks its own shape rules cannot claim agreement, so it reports unavailable.
export function createOracleResult(comparison, metadata) {
  if (!validComparison(comparison) || !validMetadata(metadata)) {
    return projectResult(emptyOracleResult("comparison_error"), metadata);
  }
  return projectResult(comparison, metadata);
}

export function emptyOracleResult(errorCategory = null) {
  return { schema: ORACLE_RESULT_SCHEMA_VERSION, status: "unavailable", checked_at: null, duration_ms: null,
    event_count: 0, session_count: 0, operation_count: 0,
    coverage: { supported_events: 0, unsupported_events: 0, comparable: false, complete: false, issues: [], checks: [] },
    differences: [], summary: SUMMARIES.unavailable,
    ...(errorCategory ? { error_category: ERRORS.includes(errorCategory) ? errorCategory : "comparison_error" } : {}),
  };
}

// The single public field allowlist for every printed result.
function projectResult(source, metadata) {
  const coverage = source.coverage;
  const { checked_at, duration_ms } = validMetadata(metadata) ? metadata : { checked_at: null, duration_ms: null };
  // The comparison boundary reports empty input as comparable and complete before returning
  // unavailable. Zero events were never checked, so the output must not say they were.
  const checked = !(source.status === "unavailable" && source.event_count === 0);
  return {
    schema: ORACLE_RESULT_SCHEMA_VERSION, status: source.status, checked_at, duration_ms,
    event_count: source.event_count, session_count: source.session_count, operation_count: source.operation_count,
    coverage: { supported_events: coverage.supported_events, unsupported_events: coverage.unsupported_events,
      comparable: checked && coverage.comparable, complete: checked && coverage.complete,
      issues: coverage.issues.map(({ category, count }) => ({ category, count })), checks: [...coverage.checks] },
    differences: [...source.differences], summary: SUMMARIES[source.status],
    ...(source.status === "unavailable" && source.error_category ? { error_category: source.error_category } : {}),
  };
}

function validMetadata(value) {
  return Boolean(value) && count(value.duration_ms)
    && typeof value.checked_at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.checked_at)
    && Number.isFinite(Date.parse(value.checked_at)) && new Date(value.checked_at).toISOString() === value.checked_at;
}

function validComparison(value) {
  if (!value || !ORACLE_STATUSES.includes(value.status)) return false;
  if (!validCountsAndCoverage(value)) return false;
  const coverage = value.coverage;
  if (value.status === "unavailable") return value.differences.length === 0;
  if (!coverage.comparable || value.event_count === 0 || coverage.checks.length !== CHECKS.length) return false;
  if (value.status === "failed") return value.differences.length > 0;
  if (value.differences.length) return false;
  const complete = coverage.unsupported_events === 0 && coverage.issues.length === 0;
  return value.status === "passed" ? coverage.complete && complete : !coverage.complete && !complete;
}

function validCountsAndCoverage(value) {
  if (![value.event_count, value.session_count, value.operation_count].every(count)) return false;
  if (value.session_count > value.event_count || value.operation_count > value.event_count) return false;
  const coverage = value.coverage;
  if (!coverage || ![coverage.supported_events, coverage.unsupported_events].every(count)
    || coverage.supported_events + coverage.unsupported_events !== value.event_count
    || typeof coverage.comparable !== "boolean" || typeof coverage.complete !== "boolean") return false;
  if (!Array.isArray(coverage.issues) || coverage.issues.length > ISSUES.length
    || coverage.issues.some((issue) => !issue || !ISSUES.includes(issue.category) || !count(issue.count) || issue.count === 0)) return false;
  if (!allowedList(coverage.checks, CHECKS) || !allowedList(value.differences, FIELDS)) return false;
  return value.error_category == null || (value.status === "unavailable" && ERRORS.includes(value.error_category));
}

function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function allowedList(values, allowed) {
  return Array.isArray(values) && values.length <= allowed.length && new Set(values).size === values.length
    && values.every((value) => allowed.includes(value));
}
