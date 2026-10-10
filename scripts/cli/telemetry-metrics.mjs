// Declarative metrics registry. One place that names every
// metric usable by an alert, an experiment's primary_metric/guardrails, the CLI report, and the
// portal's Analysis explorer, so none of those four surfaces can independently invent a formula,
// unit, or directionality. Pure module: every formula takes an already-filtered array of capture
// events (the cohort) and returns a plain number or null (null = not computable for this cohort,
// never a guessed zero).
//
// A metric's `compute(captures)` operates over CAPTURE records (schema v2/v3 spool events), the
// same array shape telemetry-analyze.mjs's analyzeTelemetry() already receives. Marker/experiment
// records are not passed to metric formulas directly — cohort selection (telemetry-cohort.mjs) is
// what turns "captures relative to a marker" into the array a metric formula consumes.

import { mcpServerOf } from "../harnesses/transcript-parse.mjs";

export const METRIC_UNITS = new Set(["count", "ratio", "percent", "tokens", "ms", "tokens_per_task"]);
export const METRIC_DIRECTIONS_GOOD = new Set(["lower", "higher", "neutral"]);

// --- shared helpers ------------------------------------------------------------------------------

function hasTokens(event) {
  return event && event.tokens && typeof event.tokens.total === "number";
}

export function isTestOperation(event) {
  return event?.operation?.category === "test";
}

export function isFullSuite(event) {
  return isTestOperation(event) && event.operation.scope === "full";
}

function isTargetedOrAffected(event) {
  return isTestOperation(event) && (event.operation.scope === "targeted" || event.operation.scope === "affected");
}

function sessionIds(captures) {
  return new Set(captures.map((event) => event.session_id).filter(Boolean));
}

// Sessions grouped by id, ordered chronologically within each session — the shape most
// per-session metric formulas need (phase run-lengths, "per debugging phase" ratios, etc).
function bySession(captures) {
  const map = new Map();
  for (const event of captures) {
    const id = event.session_id || "unknown";
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(event);
  }
  for (const events of map.values()) events.sort((a, b) => a.ts.localeCompare(b.ts));
  return map;
}

// Counts contiguous runs where phase.name === "debugging" (inferred or explicit-overridden — this
// registry reads whatever phase.name capture-time already resolved). Each run is one
// "debugging phase" for the purposes of "full-suite runs per debugging phase".
function debuggingPhaseRuns(events) {
  const runs = [];
  let current = null;
  for (const event of events) {
    const inDebugging = event.phase?.name === "debugging";
    if (inDebugging) {
      if (!current) { current = []; runs.push(current); }
      current.push(event);
    } else {
      current = null;
    }
  }
  return runs;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Trimmed mean: drop the top/bottom `trimFraction` of sorted values before averaging. Robust to a
// single dominant session inflating a token/duration metric; heavy-tailed token and duration
// distributions make a plain arithmetic mean misleading.
export function trimmedMean(values, trimFraction = 0.1) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * trimFraction);
  const kept = sorted.slice(cut, sorted.length - cut || sorted.length);
  return kept.length ? mean(kept) : mean(sorted);
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

// --- registry --------------------------------------------------------------------------------

// Each entry: { id, label, unit, direction_good ("lower"|"higher"|"neutral" — which direction of
// the raw value counts as an improvement), summary ("mean"|"median"|"trimmed_mean"|"rate"),
// minimum_sample (below this many contributing sessions/calls the value is still returned but
// callers should treat it as low-confidence — enforced by telemetry-compare.mjs, not here),
// compute(captures) -> number|null.
const REGISTRY = new Map();

function register(metric) {
  REGISTRY.set(metric.id, metric);
}

// --- Tokens ---------------------------------------------------------------------------------

register({
  id: "tokens.total",
  label: "Total tokens",
  unit: "tokens",
  direction_good: "lower",
  summary: "trimmed_mean",
  minimum_sample: 5,
  compute(captures) {
    const totals = [...bySession(captures).values()].map((events) => Math.max(...events.map((e) => e.tokens?.total || 0)));
    return totals.length ? trimmedMean(totals) : null;
  },
});

register({
  id: "tokens.delta_per_call",
  label: "Delta tokens per call",
  unit: "tokens",
  direction_good: "lower",
  summary: "trimmed_mean",
  minimum_sample: 10,
  compute(captures) {
    const deltas = captures.filter(hasTokens).map((e) => e.delta_tokens || 0);
    return deltas.length ? trimmedMean(deltas) : null;
  },
});

register({
  id: "tokens.tool_result_context",
  label: "Tool-result context estimate",
  unit: "tokens",
  direction_good: "lower",
  summary: "trimmed_mean",
  minimum_sample: 10,
  compute(captures) {
    const sized = captures.filter((e) => e.last_result && typeof e.last_result.chars === "number");
    if (!sized.length) return null;
    return trimmedMean(sized.map((e) => Math.round(e.last_result.chars / 4)));
  },
});

// --- Time -------------------------------------------------------------------------------------

register({
  id: "time.session_duration_ms",
  label: "Session duration",
  unit: "ms",
  direction_good: "neutral",
  summary: "median",
  minimum_sample: 5,
  compute(captures) {
    const spans = [...bySession(captures).values()]
      .map((events) => Date.parse(events[events.length - 1].ts) - Date.parse(events[0].ts))
      .filter((ms) => Number.isFinite(ms) && ms >= 0);
    return spans.length ? median(spans) : null;
  },
});

register({
  id: "time.captured_tool_duration_ms",
  label: "Captured tool duration",
  unit: "ms",
  direction_good: "lower",
  summary: "trimmed_mean",
  minimum_sample: 10,
  compute(captures) {
    const durations = captures.map((e) => e.duration_ms).filter((ms) => typeof ms === "number" && ms >= 0);
    return durations.length ? trimmedMean(durations) : null;
  },
});

register({
  id: "time.operation_duration_ms",
  label: "Semantic operation duration",
  unit: "ms",
  direction_good: "lower",
  summary: "trimmed_mean",
  minimum_sample: 10,
  compute(captures) {
    const durations = captures.filter((e) => e.operation).map((e) => e.duration_ms).filter((ms) => typeof ms === "number" && ms >= 0);
    return durations.length ? trimmedMean(durations) : null;
  },
});

// --- Calls ------------------------------------------------------------------------------------

register({
  id: "calls.total_tools",
  label: "Total tool calls",
  unit: "count",
  direction_good: "neutral",
  summary: "median",
  minimum_sample: 5,
  compute(captures) {
    const perSession = [...bySession(captures).values()].map((events) => events.filter((e) => e.event === "PostToolUse").length);
    return perSession.length ? median(perSession) : null;
  },
});

register({
  id: "calls.mcp_calls",
  label: "MCP calls",
  unit: "count",
  direction_good: "neutral",
  summary: "median",
  minimum_sample: 5,
  compute(captures) {
    const perSession = [...bySession(captures).values()].map((events) => events.filter((e) => e.event === "PostToolUse" && e.tool?.is_mcp).length);
    return perSession.length ? median(perSession) : null;
  },
});

register({
  id: "calls.per_phase",
  label: "Calls per phase segment",
  unit: "count",
  direction_good: "neutral",
  summary: "mean",
  minimum_sample: 5,
  compute(captures) {
    const segments = [];
    for (const events of bySession(captures).values()) {
      let current = null;
      for (const event of events) {
        const name = event.phase?.name ?? null;
        if (!current || current.name !== name) { current = { name, count: 0 }; segments.push(current); }
        if (event.event === "PostToolUse") current.count += 1;
      }
    }
    const counts = segments.filter((s) => s.name != null).map((s) => s.count);
    return counts.length ? mean(counts) : null;
  },
});

// --- Testing ------------------------------------------------------------------------------------

register({
  id: "test.full_suite_calls_per_session",
  label: "Full-suite runs per session",
  unit: "count",
  direction_good: "lower",
  summary: "mean",
  minimum_sample: 5,
  compute(captures) {
    const perSession = [...bySession(captures).values()].map((events) => events.filter(isFullSuite).length);
    return perSession.length ? mean(perSession) : null;
  },
});

// Full-suite runs per TESTING-ACTIVE session — the denominator that matters for "am I running the
// whole suite too often": sessions with no testing at all shouldn't dilute the rate. Null when no
// session ran any tests (honest empty state, never a guessed zero).
register({
  id: "test.full_suite_calls_per_testing_session",
  label: "Full-suite runs per session with any testing",
  unit: "count",
  direction_good: "lower",
  summary: "mean",
  minimum_sample: 1,
  compute(captures) {
    const perSession = [...bySession(captures).values()]
      .filter((events) => events.some(isTestOperation))
      .map((events) => events.filter(isFullSuite).length);
    return perSession.length ? mean(perSession) : null;
  },
});

register({
  id: "test.full_suite_calls_per_debug_phase",
  label: "Full-suite runs per debugging phase",
  unit: "count",
  direction_good: "lower",
  summary: "mean",
  minimum_sample: 5,
  compute(captures) {
    const ratios = [];
    for (const events of bySession(captures).values()) {
      const runs = debuggingPhaseRuns(events);
      if (!runs.length) continue;
      const fullSuiteCalls = runs.reduce((sum, run) => sum + run.filter(isFullSuite).length, 0);
      ratios.push(fullSuiteCalls / runs.length);
    }
    return ratios.length ? mean(ratios) : null;
  },
});

register({
  id: "test.full_suite_without_intervening_edit",
  label: "Full-suite reruns without an intervening edit",
  unit: "count",
  direction_good: "lower",
  summary: "mean",
  minimum_sample: 5,
  compute(captures) {
    const perSession = [...bySession(captures).values()].map((events) =>
      events.filter((e) => isFullSuite(e) && e.intervening && e.intervening.edit_since_last_test === false).length);
    return perSession.length ? mean(perSession) : null;
  },
});

register({
  id: "test.full_suite_unchanged_failure_signature",
  label: "Full-suite reruns with unchanged failure signature",
  unit: "count",
  direction_good: "lower",
  summary: "mean",
  minimum_sample: 5,
  compute(captures) {
    const perSession = [...bySession(captures).values()].map((events) =>
      events.filter((e) => isFullSuite(e) && e.intervening && e.intervening.failure_signature_changed === false && e.operation?.exit_status === "fail").length);
    return perSession.length ? mean(perSession) : null;
  },
});

register({
  id: "test.targeted_to_full_ratio",
  label: "Targeted-to-full test ratio",
  unit: "ratio",
  direction_good: "higher",
  summary: "rate",
  minimum_sample: 10,
  compute(captures) {
    const targeted = captures.filter(isTargetedOrAffected).length;
    const full = captures.filter(isFullSuite).length;
    if (targeted + full === 0) return null;
    return full === 0 ? targeted : targeted / full;
  },
});

register({
  id: "test.share_of_tool_time",
  label: "Testing share of captured tool time",
  unit: "percent",
  direction_good: "neutral",
  summary: "rate",
  minimum_sample: 20,
  compute(captures) {
    const timed = captures.filter((e) => typeof e.duration_ms === "number" && e.duration_ms >= 0);
    if (!timed.length) return null;
    const totalMs = timed.reduce((sum, e) => sum + e.duration_ms, 0);
    if (totalMs === 0) return null;
    const testMs = timed.filter(isTestOperation).reduce((sum, e) => sum + e.duration_ms, 0);
    return Math.round((testMs / totalMs) * 1000) / 10;
  },
});

register({
  id: "test.time_failure_to_targeted_repro_ms",
  label: "Time from full-suite failure to targeted reproduction",
  unit: "ms",
  direction_good: "lower",
  summary: "median",
  minimum_sample: 3,
  compute(captures) {
    const gaps = [];
    for (const events of bySession(captures).values()) {
      let failedAt = null;
      for (const event of events) {
        if (isFullSuite(event) && event.operation?.exit_status === "fail") {
          failedAt = Date.parse(event.ts);
        } else if (failedAt != null && isTargetedOrAffected(event)) {
          const gap = Date.parse(event.ts) - failedAt;
          if (gap >= 0) gaps.push(gap);
          failedAt = null;
        }
      }
    }
    return gaps.length ? median(gaps) : null;
  },
});

register({
  id: "test.time_first_failure_to_verification_ms",
  label: "Time from first failure to successful verification",
  unit: "ms",
  direction_good: "lower",
  summary: "median",
  minimum_sample: 3,
  compute(captures) {
    const gaps = [];
    for (const events of bySession(captures).values()) {
      const firstFailure = events.find((e) => isTestOperation(e) && e.operation.exit_status === "fail");
      if (!firstFailure) continue;
      const verified = events.find((e) => Date.parse(e.ts) > Date.parse(firstFailure.ts) && isTestOperation(e) && e.operation.exit_status === "pass" && (e.phase?.name === "verification" || e.phase?.name === "finalization"));
      if (verified) gaps.push(Date.parse(verified.ts) - Date.parse(firstFailure.ts));
    }
    return gaps.length ? median(gaps) : null;
  },
});

register({
  id: "test.finalization_full_suite_count",
  label: "Finalization full-suite count",
  unit: "count",
  direction_good: "neutral",
  summary: "mean",
  minimum_sample: 5,
  compute(captures) {
    const perSession = [...bySession(captures).values()].map((events) =>
      events.filter((e) => isFullSuite(e) && e.phase?.name === "finalization").length);
    return perSession.length ? mean(perSession) : null;
  },
});

register({
  id: "test.tokens_during_testing",
  label: "Estimated tokens accumulated during testing activity",
  unit: "tokens",
  direction_good: "lower",
  summary: "trimmed_mean",
  minimum_sample: 5,
  compute(captures) {
    const perSession = [...bySession(captures).values()]
      .map((events) => events.filter(isTestOperation).reduce((sum, e) => sum + (e.delta_tokens || 0), 0))
      .filter((v) => v > 0);
    return perSession.length ? trimmedMean(perSession) : null;
  },
});

// Testing's share of all captured token traffic — the comparable, unit-free framing for "how much
// of my budget goes to tests". Report-global ratio (not per-session mean): a share only means
// something against the whole, same denominator the waste cards and group shares use.
register({
  id: "test.token_share",
  label: "Testing share of all captured tokens",
  unit: "percent",
  direction_good: "lower",
  summary: "rate",
  minimum_sample: 20,
  compute(captures) {
    const total = captures.reduce((sum, e) => sum + (e.delta_tokens || 0), 0);
    if (total <= 0) return null;
    const test = captures.filter(isTestOperation).reduce((sum, e) => sum + (e.delta_tokens || 0), 0);
    return Math.round((test / total) * 1000) / 10;
  },
});

// --- Outcome ------------------------------------------------------------------------------------
// Outcome metrics need the marker timeline (explicit outcome markers), not just captures, so they
// take an optional second argument of markers scoped to the same cohort's sessions. Cohort assembly
// (telemetry-cohort.mjs) is responsible for handing markers alongside captures when an outcome
// metric is requested; compute() degrades to null when markers are omitted, never guesses from Stop.

register({
  id: "outcome.completion_rate",
  label: "Completion rate",
  unit: "percent",
  direction_good: "higher",
  summary: "rate",
  minimum_sample: 5,
  compute(captures, { markers = [] } = {}) {
    const sessions = sessionIds(captures);
    const outcomes = markers.filter((m) => m.type === "outcome" && sessions.has(m.session_id));
    if (!outcomes.length) return null;
    const successful = outcomes.filter((m) => m.status === "successful").length;
    return Math.round((successful / outcomes.length) * 1000) / 10;
  },
});

register({
  id: "outcome.verification_pass_rate",
  label: "Verification pass rate",
  unit: "percent",
  direction_good: "higher",
  summary: "rate",
  minimum_sample: 5,
  compute(captures) {
    const perSessionVerification = [...bySession(captures).values()]
      .map((events) => events.filter((e) => isTestOperation(e) && (e.phase?.name === "verification" || e.phase?.name === "finalization")))
      .filter((events) => events.length > 0);
    if (!perSessionVerification.length) return null;
    const passed = perSessionVerification.filter((events) => events[events.length - 1].operation.exit_status === "pass").length;
    return Math.round((passed / perSessionVerification.length) * 1000) / 10;
  },
});

register({
  id: "outcome.tokens_per_completed_task",
  label: "Tokens per completed task",
  unit: "tokens_per_task",
  direction_good: "lower",
  summary: "trimmed_mean",
  minimum_sample: 5,
  compute(captures, { markers = [] } = {}) {
    const successfulSessions = new Set(markers.filter((m) => m.type === "outcome" && m.status === "successful").map((m) => m.session_id).filter(Boolean));
    if (!successfulSessions.size) return null;
    const totals = [...bySession(captures).values()]
      .filter((events) => successfulSessions.has(events[0].session_id))
      .map((events) => Math.max(...events.map((e) => e.tokens?.total || 0)));
    return totals.length ? trimmedMean(totals) : null;
  },
});

// --- Reliability --------------------------------------------------------------------------------

register({
  id: "reliability.capture_coverage",
  label: "Capture coverage (schema v3 share)",
  unit: "percent",
  direction_good: "higher",
  summary: "rate",
  minimum_sample: 20,
  compute(captures) {
    if (!captures.length) return null;
    const v3 = captures.filter((e) => e.schema === 3).length;
    return Math.round((v3 / captures.length) * 1000) / 10;
  },
});

register({
  id: "reliability.paired_call_rate",
  label: "Paired-call (duration known) rate",
  unit: "percent",
  direction_good: "higher",
  summary: "rate",
  minimum_sample: 20,
  compute(captures) {
    const toolCalls = captures.filter((e) => e.event === "PostToolUse" && e.tool?.name);
    if (!toolCalls.length) return null;
    const paired = toolCalls.filter((e) => typeof e.duration_ms === "number").length;
    return Math.round((paired / toolCalls.length) * 1000) / 10;
  },
});

register({
  id: "reliability.known_model_rate",
  label: "Known-model rate",
  unit: "percent",
  direction_good: "higher",
  summary: "rate",
  minimum_sample: 20,
  compute(captures) {
    if (!captures.length) return null;
    const known = captures.filter((e) => typeof e.session?.model === "string" && e.session.model).length;
    return Math.round((known / captures.length) * 1000) / 10;
  },
});

register({
  id: "reliability.known_snapshot_rate",
  label: "Known-configuration-snapshot rate",
  unit: "percent",
  direction_good: "higher",
  summary: "rate",
  minimum_sample: 20,
  compute(captures) {
    if (!captures.length) return null;
    const known = captures.filter((e) => typeof e.config_snapshot_id === "string" && e.config_snapshot_id).length;
    return Math.round((known / captures.length) * 1000) / 10;
  },
});

// --- Public API ------------------------------------------------------------------------------

export function listMetrics() {
  return [...REGISTRY.values()].map(({ compute, ...rest }) => rest);
}

export function getMetric(id) {
  return REGISTRY.get(id) ?? null;
}

export function isKnownMetric(id) {
  return REGISTRY.has(id);
}

// Compute a metric by id over a cohort of captures. `extra` carries auxiliary inputs (currently
// only `markers`) that a small number of outcome metrics need beyond the capture array. Returns
// null both when the metric id is unknown and when the metric legitimately has nothing to compute
// — callers that need to tell those two cases apart should check isKnownMetric() first.
export function computeMetric(metricId, captures, extra = {}) {
  const metric = REGISTRY.get(metricId);
  if (!metric) return null;
  return metric.compute(captures, extra);
}

export { mcpServerOf };
