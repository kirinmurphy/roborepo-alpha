export const ORACLE_HEALTH_SCHEMA_VERSION = 1;

const CHECKS = ["sessions", "operations", "conditions", "boundaries", "gating", "regression", "loops"];
const FIELDS = ["policy", "session_count", "token_session_count", "operation_count", "token_operation_count", "conditions", "changes", "regression"];
const ISSUES = ["malformed_evidence", "unsupported_analysis_options", "duplicate_snapshot_id", "duplicate_marker_id",
  "unresolved_marker_supersedes", "missing_snapshot", "malformed_evidence_accounting", "skipped_evidence",
  "malformed_repository_registry", "ambiguous_repository_registry", "malformed_event", "unsupported_event_schema",
  "unidentified_session", "invalid_timestamp", "malformed_tokens", "malformed_repository", "unsupported_bare_tool",
  "unresolved_repository", "unknown_model", "malformed_snapshot", "unsupported_snapshot_schema", "unknown_snapshot_condition",
  "malformed_marker", "unsupported_marker_schema", "unsupported_marker_type", "missing_marker_kinds", "unsupported_marker_kind",
  "unknown_marker_scope", "unknown_session_condition", "changing_session_snapshot"];
const ERRORS = ["comparison_error", "evidence_read_error", "worker_start_error", "worker_crash", "worker_timeout",
  "invalid_worker_result", "invalid_cached_health", "signature_error"];
const SUMMARIES = {
  passed: "Production and oracle calculations agree for the checked supported evidence.",
  checking: "An independent comparison is in progress.",
  stale: "Evidence changed; the last comparison is not current.",
  partial: "Covered calculations agree, but required evidence is incomplete or unresolved.",
  unavailable: "A complete comparable input could not be evaluated.",
  failed: "Production and oracle calculations disagree on covered fields.",
};

const STATUSES = Object.keys(SUMMARIES);

// Construct an explicit wire projection: never spread comparison data or exception text into it.
// A worker result describes checked evidence; only the observer can establish current freshness.
export function createOracleHealthResult(comparison, metadata) {
  if (!validComparison(comparison) || !validMetadata(metadata)) {
    return emptyOracleHealth("unavailable", "invalid_worker_result");
  }
  return projectHealth(comparison, metadata);
}

export function emptyOracleHealth(status = "checking", errorCategory = null) {
  const safeStatus = status === "checking" ? "checking" : "unavailable";
  return { schema: ORACLE_HEALTH_SCHEMA_VERSION, status: safeStatus,
    checked_at: null, duration_ms: null, evidence_signature: null,
    event_count: 0, session_count: 0, operation_count: 0,
    coverage: { supported_events: 0, unsupported_events: 0, comparable: false, complete: false, issues: [], checks: [] },
    differences: [], summary: SUMMARIES[safeStatus],
    ...(errorCategory ? { error_category: ERRORS.includes(errorCategory) ? errorCategory : "invalid_worker_result" } : {}),
  };
}

export function staleOracleHealth(result) {
  return { ...result, status: "stale", summary: SUMMARIES.stale };
}

// Re-project cached state at the HTTP boundary. The observer already stores this schema, but an
// explicit allowlist here prevents a future cache/debug field from becoming a public response.
export function projectOracleHealthResult(value) {
  if (!validHealthResult(value)) return emptyOracleHealth("unavailable", "invalid_cached_health");
  return projectHealth(value, value);
}

// The single public field allowlist shared by worker results and the HTTP boundary.
function projectHealth(source, metadata) {
  const coverage = source.coverage;
  return {
    schema: ORACLE_HEALTH_SCHEMA_VERSION, status: source.status,
    checked_at: metadata.checked_at, duration_ms: metadata.duration_ms, evidence_signature: metadata.evidence_signature,
    event_count: source.event_count, session_count: source.session_count, operation_count: source.operation_count,
    coverage: { supported_events: coverage.supported_events, unsupported_events: coverage.unsupported_events,
      comparable: coverage.comparable, complete: coverage.complete,
      issues: coverage.issues.map(({ category, count }) => ({ category, count })), checks: [...coverage.checks] },
    differences: [...source.differences], summary: SUMMARIES[source.status],
    ...(source.error_category ? { error_category: source.error_category } : {}),
  };
}

export function isOracleEvidenceSignature(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function validMetadata(value) {
  return value && isOracleEvidenceSignature(value.evidence_signature) && count(value.duration_ms)
    && typeof value.checked_at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.checked_at)
    && Number.isFinite(Date.parse(value.checked_at)) && new Date(value.checked_at).toISOString() === value.checked_at;
}

function validHealthResult(value) {
  if (!value || value.schema !== ORACLE_HEALTH_SCHEMA_VERSION || !STATUSES.includes(value.status)) return false;
  if (!validCountsAndCoverage(value)) return false;
  if (value.checked_at !== null && !validMetadata(value)) return false;
  if (value.checked_at === null && (value.duration_ms !== null || value.evidence_signature !== null)) return false;
  if (["passed", "partial", "failed"].includes(value.status) && value.checked_at === null) return false;
  if (value.status === "checking" && value.checked_at !== null) return false;
  return value.summary === SUMMARIES[value.status];
}

function validComparison(value) {
  if (!value || !["passed", "partial", "failed", "unavailable"].includes(value.status)) return false;
  if (!validCountsAndCoverage(value)) return false;
  const coverage = value.coverage;
  if (value.status === "unavailable") return value.differences.length === 0;
  if (!coverage.comparable || value.event_count === 0 || coverage.checks.length !== CHECKS.length) return false;
  if (value.status === "failed") return value.differences.length > 0;
  if (value.differences.length) return false;
  const complete = coverage.unsupported_events === 0 && coverage.issues.length === 0;
  return value.status === "passed" ? coverage.complete && complete : !coverage.complete && !complete;
}

// Shape rules common to worker comparisons and cached health results.
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
