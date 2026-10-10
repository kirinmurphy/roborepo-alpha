// Marker-relative comparisons, confidence/data-quality gates, and the actionable finding contract.
// Pure module: takes captures + markers already loaded by the caller (telemetry.mjs's
// CLI report or the portal's /api/telemetry/analysis handler) and returns structured evidence.
//
// This replaces telemetry-analyze.mjs's midpoint-only regression() as the PREFERRED comparison path
// when a change marker is selected. regression() itself is untouched and still runs unconditionally
// as the labeled exploratory fallback when no marker is selected.

import { normalizeObservations, canonicalFlowRows } from "./telemetry-observations.mjs";
import { splitObservationBoundary } from "./telemetry-boundaries.mjs";
import { getMetric, isKnownMetric, computeMetric } from "./telemetry-metrics.mjs";
import { applyCohortFilter, normalizeCohortFilter } from "./telemetry-cohort.mjs";

export const CONFIDENCE_LABELS = ["strong signal", "emerging pattern", "insufficient evidence", "data-quality warning"];

// Minimum sessions per cohort before a comparison is even attempted (eligibility.minimum_
// sessions_per_cohort defaults to 10 for experiments; marker-relative comparisons without an
// experiment attached use this same conservative floor unless the caller overrides it).
const DEFAULT_MIN_SESSIONS_PER_COHORT = 10;
// Below this many sessions, a comparison is technically computable but downgraded to "emerging
// pattern" rather than "strong signal" even with a large effect size.
const STRONG_SIGNAL_MIN_SESSIONS = 20;
// A single session should not be able to swing a whole cohort's average — if one session accounts for
// more than this share of a cohort's sessions, flag "one session dominates".
const DOMINANT_SESSION_SHARE = 0.4;

function sessionIdsOf(captures) {
  return new Set(captures.map((event) => event.session_id).filter(Boolean));
}

function dominantSession(captures) {
  const counts = new Map();
  for (const event of captures) {
    const id = event.session_id || "unknown";
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const total = captures.length || 1;
  let worst = null;
  for (const [id, count] of counts) {
    if (!worst || count > worst.count) worst = { id, count };
  }
  return worst && worst.count / total > DOMINANT_SESSION_SHARE ? worst : null;
}

// Resolve the eligible "before" and "after" session windows around a change marker's timestamp.
// Sessions that span the marker (start before it, end after) are excluded from both cohorts unless
// the caller explicitly opts into within-session comparison (not implemented here — plan explicitly
// scopes that out: "unless the analysis explicitly supports within-session phase comparison").
export function splitCohortsByMarker(captures, marker) {
  if (marker.schema >= 2) {
    const observations = normalizeObservations(captures).sessions.filter((item) => marker.scope === "all" || (marker.repository_id && item.repository_id === marker.repository_id));
    const split = splitObservationBoundary(observations, marker);
    return { before: canonicalFlowRows(normalizeObservations(split.before.flatMap((item) => item.rows))), after: canonicalFlowRows(normalizeObservations(split.after.flatMap((item) => item.rows))),
      excluded: [...split.spanning.map((item) => ({ session_id: item.session_id, reason: "session spans the marker timestamp" })),
        ...split.ambiguous.map((item) => ({ session_id: item.session_id, reason: "ambiguous_boundary" }))] };
  }
  // Legacy markers share the canonical boundary rule: effective_at ?? ts, with sessions touching
  // the boundary excluded rather than assigned to a side.
  const sessions = new Map();
  for (const event of captures) {
    const id = event.session_id || "unknown";
    const ms = Date.parse(event.ts);
    if (!Number.isFinite(ms)) continue;
    if (!sessions.has(id)) sessions.set(id, { session_id: id, first: ms, last: ms, events: [] });
    const s = sessions.get(id);
    s.first = Math.min(s.first, ms);
    s.last = Math.max(s.last, ms);
    s.events.push(event);
  }
  const observations = [...sessions.values()].map((session) => ({ session_id: session.session_id, events: session.events,
    first_seen: new Date(session.first).toISOString(), last_seen: new Date(session.last).toISOString(), rows: [] }));
  const split = splitObservationBoundary(observations, marker);
  return { before: split.before.flatMap((item) => item.events), after: split.after.flatMap((item) => item.events),
    excluded: [...split.spanning.map((item) => ({ session_id: item.session_id, reason: "session spans the marker timestamp" })),
      ...split.ambiguous.map((item) => ({ session_id: item.session_id, reason: "ambiguous_boundary" }))] };
}

// Restrict the larger of two cohorts to an equal-duration or equal-session-count window matching the
// smaller cohort, so a comparison never silently favors whichever side happens to have more data.
// mode: "equal-session-count" (default) trims by session recency; "equal-duration" trims by wall time.
export function equalizeCohorts(before, after, { mode = "equal-session-count" } = {}) {
  const beforeSessions = sessionIdsOf(before);
  const afterSessions = sessionIdsOf(after);
  if (mode === "equal-duration") {
    const beforeSpan = timeSpan(before);
    const afterSpan = timeSpan(after);
    const span = Math.min(beforeSpan ?? Infinity, afterSpan ?? Infinity);
    if (!Number.isFinite(span)) return { before, after, window_mode: mode, window_value: null };
    return {
      before: trimToTrailingSpan(before, span),
      after: trimToLeadingSpan(after, span),
      window_mode: mode,
      window_value: span,
    };
  }
  const count = Math.min(beforeSessions.size, afterSessions.size);
  if (count === 0) return { before, after, window_mode: mode, window_value: 0 };
  return {
    before: trimToSessionCount(before, count, "trailing"),
    after: trimToSessionCount(after, count, "leading"),
    window_mode: mode,
    window_value: count,
  };
}

function timeSpan(captures) {
  const times = captures.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  return times.length ? Math.max(...times) - Math.min(...times) : null;
}

function trimToTrailingSpan(captures, spanMs) {
  const times = captures.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  if (!times.length) return captures;
  const end = Math.max(...times);
  return captures.filter((e) => Date.parse(e.ts) >= end - spanMs);
}

function trimToLeadingSpan(captures, spanMs) {
  const times = captures.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  if (!times.length) return captures;
  const start = Math.min(...times);
  return captures.filter((e) => Date.parse(e.ts) <= start + spanMs);
}

function trimToSessionCount(captures, count, edge) {
  const sessionOrder = [];
  const seen = new Set();
  const sorted = [...captures].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const event of sorted) {
    const id = event.session_id || "unknown";
    if (!seen.has(id)) { seen.add(id); sessionOrder.push(id); }
  }
  const keep = new Set(edge === "trailing" ? sessionOrder.slice(-count) : sessionOrder.slice(0, count));
  return captures.filter((event) => keep.has(event.session_id || "unknown"));
}

// Core marker-relative comparison. Returns a structured result even when data is insufficient — the
// caller decides whether to surface it, and insufficient data never produces a false
// conclusion; this function never throws for thin data, only for a genuinely unknown
// metric id or missing marker.
export function compareAcrossMarker(allCaptures, marker, metricId, {
  markers = [],
  minimumSessionsPerCohort = DEFAULT_MIN_SESSIONS_PER_COHORT,
  equalize = "equal-session-count",
  cohortFilter = null,
} = {}) {
  if (!marker) throw new Error("compareAcrossMarker requires a marker");
  if (!isKnownMetric(metricId)) throw new Error(`unknown metric: ${metricId}`);

  const scoped = cohortFilter ? applyCohortFilter(allCaptures, normalizeCohortFilter(cohortFilter), { markers }) : allCaptures;
  const { before, after, excluded } = splitCohortsByMarker(scoped, marker);
  const { before: eqBefore, after: eqAfter, window_mode, window_value } = equalizeCohorts(before, after, { mode: equalize });

  const beforeSessions = sessionIdsOf(eqBefore).size;
  const afterSessions = sessionIdsOf(eqAfter).size;
  const metric = getMetric(metricId);

  const beforeValue = computeMetric(metricId, eqBefore, { markers });
  const afterValue = computeMetric(metricId, eqAfter, { markers });

  const dataQualityIssues = [];
  // An unknown scope matches no sessions; report that as an unfair comparison, not as thin data.
  const scopeUnknown = marker.schema >= 2 && !marker.repository_id && marker.scope !== "all";
  if (scopeUnknown) dataQualityIssues.push("marker scope is unknown, so no sessions can be compared fairly");
  else {
    if (beforeSessions < minimumSessionsPerCohort) dataQualityIssues.push(`before cohort has ${beforeSessions} sessions, below the minimum of ${minimumSessionsPerCohort}`);
    if (afterSessions < minimumSessionsPerCohort) dataQualityIssues.push(`after cohort has ${afterSessions} sessions, below the minimum of ${minimumSessionsPerCohort}`);
  }
  const dominantBefore = dominantSession(eqBefore);
  const dominantAfter = dominantSession(eqAfter);
  if (dominantBefore) dataQualityIssues.push(`one session dominates the before cohort (${dominantBefore.id.slice(0, 8)})`);
  if (dominantAfter) dataQualityIssues.push(`one session dominates the after cohort (${dominantAfter.id.slice(0, 8)})`);
  if (!scopeUnknown && (beforeValue == null || afterValue == null)) dataQualityIssues.push("metric could not be computed for one or both cohorts");
  if (excluded.length) dataQualityIssues.push(`${excluded.length} session(s) excluded (spanned the marker timestamp)`);

  const effectSize = beforeValue != null && afterValue != null ? afterValue - beforeValue : null;
  const relativeChange = beforeValue ? effectSize / beforeValue : null;

  const confidence = confidenceLabel({
    beforeSessions,
    afterSessions,
    minimumSessionsPerCohort,
    dataQualityIssues,
    beforeValue,
    afterValue,
    scopeUnknown,
  });

  return {
    metric: metricId,
    metric_label: metric.label,
    unit: metric.unit,
    direction_good: metric.direction_good,
    marker: { marker_id: marker.marker_id, ts: marker.ts, title: marker.title },
    window_mode,
    window_value,
    before: { sessions: beforeSessions, value: beforeValue },
    after: { sessions: afterSessions, value: afterValue },
    effect_size: effectSize,
    relative_change: relativeChange,
    excluded_sessions: excluded,
    data_quality_issues: dataQualityIssues,
    confidence,
  };
}

function confidenceLabel({ beforeSessions, afterSessions, minimumSessionsPerCohort, dataQualityIssues, beforeValue, afterValue, scopeUnknown }) {
  if (scopeUnknown) return "can't compare fairly";
  if (beforeValue == null || afterValue == null) return "insufficient evidence";
  if (beforeSessions < minimumSessionsPerCohort || afterSessions < minimumSessionsPerCohort) return "insufficient evidence";
  const hasSeriousDataQualityIssue = dataQualityIssues.some((issue) => issue.includes("dominates") || issue.includes("excluded"));
  if (hasSeriousDataQualityIssue) return "data-quality warning";
  if (beforeSessions >= STRONG_SIGNAL_MIN_SESSIONS && afterSessions >= STRONG_SIGNAL_MIN_SESSIONS) return "strong signal";
  return "emerging pattern";
}

// Wraps a raw comparison (compareAcrossMarker's output, or a simple cohort-A-vs-cohort-B comparison)
// into the four-layer actionable finding contract. Every field
// a comparative finding exposes is present, even when null. `interpretation` and
// `nextAction` are plain strings supplied by the caller (deterministic templates, not free LLM text)
// — this function's job is only to assemble the contract shape consistently, never to originate
// causal language itself.
export function buildFinding({ observation, comparison, interpretation, nextAction, correlationOnly = true }) {
  return {
    observation,
    evidence: {
      before: comparison.before,
      after: comparison.after,
      effect_size: comparison.effect_size,
      relative_change: comparison.relative_change,
      window_mode: comparison.window_mode,
      window_value: comparison.window_value,
      excluded_sessions: comparison.excluded_sessions,
    },
    cohort: {
      metric: comparison.metric,
      marker: comparison.marker ?? null,
    },
    sample_size: { before: comparison.before.sessions, after: comparison.after.sessions },
    confidence: comparison.confidence,
    data_quality_issues: comparison.data_quality_issues,
    interpretation: interpretation ? { text: interpretation, labeled_as: "inference" } : null,
    next_action: nextAction ?? null,
    correlation_only: correlationOnly,
    // Ready-to-apply Analysis filter state: reproduces this exact comparison from the portal explorer.
    analysis_filter_state: {
      metric: comparison.metric,
      marker_id: comparison.marker?.marker_id ?? null,
    },
  };
}

// Deterministic template for the marker-relative finding's headline + interpretation + next action,
// following the shape ("Observation: ... Evidence: ... Interpretation: ...
// Next action: ..."). Never claims causation — always "correlates with" / "may" wording, and only
// when a marker names packages/skills does the interpretation mention them (still correlation-only).
export function describeMarkerComparison(comparison, marker) {
  const metricLabel = comparison.metric_label;
  const beforeVal = formatMetricValue(comparison.before.value, comparison.unit);
  const afterVal = formatMetricValue(comparison.after.value, comparison.unit);
  const observation = comparison.before.value == null || comparison.after.value == null
    ? `${metricLabel} could not be computed for both cohorts around "${marker.title}".`
    : `${metricLabel} changed from ${beforeVal} to ${afterVal} after "${marker.title}".`;

  const exposureSubjects = [...(marker.packages || []), ...(marker.skills || [])];
  const interpretation = exposureSubjects.length
    ? `Sessions after this marker were exposed to ${exposureSubjects.join(", ")}; this is a correlation, not a proven cause.`
    : null;

  const worseningDirection = comparison.direction_good === "lower" ? comparison.effect_size > 0
    : comparison.direction_good === "higher" ? comparison.effect_size < 0
    : null;
  const nextAction = comparison.confidence === "insufficient evidence"
    ? `Collect more comparable sessions before drawing a conclusion (need at least the configured minimum per cohort).`
    : comparison.confidence !== "strong signal"
      ? `Early signal only: keep collecting comparable sessions before acting on ${metricLabel.toLowerCase()} moving ${worseningDirection ? "the wrong way" : "this way"}.`
    : worseningDirection
      ? `Investigate why ${metricLabel.toLowerCase()} moved the wrong way and consider a follow-up change or experiment.`
      : `Continue monitoring ${metricLabel.toLowerCase()} across the next eligible sessions.`;

  return buildFinding({ observation, comparison, interpretation, nextAction });
}

function formatMetricValue(value, unit) {
  if (value == null) return "unknown";
  if (unit === "percent") return `${value}%`;
  if (unit === "ms") return `${Math.round(value)}ms`;
  return String(Math.round(value * 100) / 100);
}
