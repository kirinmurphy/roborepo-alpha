#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  listMetrics, getMetric, isKnownMetric, computeMetric, trimmedMean, percentile,
} from "../cli/telemetry-metrics.mjs";

// The declarative metrics registry shared by the CLI report, the portal, alerts, and experiments,
// so UI components never define formulas independently. Pure module — every
// compute(captures) formula operates over already-filtered capture arrays, no fs/config imports.

testRegistryHasRequiredGroups();
testEveryMetricHasRequiredFields();
testUnknownMetricReturnsNull();
testTrimmedMeanDropsOutliers();
testPercentileBasic();
testFullSuiteCallsPerDebugPhase();
testFullSuiteWithoutInterveningEdit();
testTargetedToFullRatio();
testTestShareOfToolTime();
testTokensTotalUsesSessionMax();
testOutcomeCompletionRateNeedsMarkers();
testReliabilityCaptureCoverage();
console.log("telemetry metrics registry checks passed");

function testRegistryHasRequiredGroups() {
  const ids = listMetrics().map((m) => m.id);
  const groups = ["tokens.", "time.", "calls.", "test.", "outcome.", "reliability."];
  for (const group of groups) {
    assert.ok(ids.some((id) => id.startsWith(group)), `expected at least one metric in group ${group}`);
  }
}

function testEveryMetricHasRequiredFields() {
  for (const metric of listMetrics()) {
    assert.equal(typeof metric.id, "string");
    assert.equal(typeof metric.label, "string");
    assert.ok(["count", "ratio", "percent", "tokens", "ms", "tokens_per_task"].includes(metric.unit), `${metric.id} has unexpected unit ${metric.unit}`);
    assert.ok(["lower", "higher", "neutral"].includes(metric.direction_good), `${metric.id} has unexpected direction_good`);
    assert.equal(typeof metric.minimum_sample, "number");
  }
}

function testUnknownMetricReturnsNull() {
  assert.equal(isKnownMetric("bogus.metric"), false);
  assert.equal(computeMetric("bogus.metric", []), null);
  assert.equal(getMetric("bogus.metric"), null);
}

function testTrimmedMeanDropsOutliers() {
  const withOutlier = trimmedMean([1, 2, 3, 1000], 0.25);
  assert.ok(withOutlier < 10, "trimmed mean should drop the outlier");
}

function testPercentileBasic() {
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
}

function capture({ sessionId, ts, category, scope, exitStatus, phase, editSinceLastTest = false, failureSigChanged = false, deltaTokens = 0, durationMs = null }) {
  return {
    session_id: sessionId,
    ts,
    event: "PostToolUse",
    harness: "claude",
    tool: { name: "Bash" },
    delta_tokens: deltaTokens,
    duration_ms: durationMs,
    tokens: { total: 100 },
    operation: category ? { category, scope, exit_status: exitStatus } : null,
    phase: phase ? { name: phase } : null,
    intervening: { edit_since_last_test: editSinceLastTest, failure_signature_changed: failureSigChanged },
  };
}

// Full-suite debugging loop scenario: four full-suite calls during
// debugging, three without an intervening edit or changed failure signature, one targeted repro,
// one final successful full-suite run in finalization.
function debugLoopSession(sessionId) {
  return [
    capture({ sessionId, ts: "2026-01-01T00:00:00Z", category: "test", scope: "full", exitStatus: "fail", phase: "debugging", editSinceLastTest: true, failureSigChanged: true }),
    capture({ sessionId, ts: "2026-01-01T00:01:00Z", category: "test", scope: "full", exitStatus: "fail", phase: "debugging", editSinceLastTest: false, failureSigChanged: false }),
    capture({ sessionId, ts: "2026-01-01T00:02:00Z", category: "test", scope: "full", exitStatus: "fail", phase: "debugging", editSinceLastTest: false, failureSigChanged: false }),
    capture({ sessionId, ts: "2026-01-01T00:03:00Z", category: "test", scope: "targeted", exitStatus: "fail", phase: "debugging", editSinceLastTest: true }),
    capture({ sessionId, ts: "2026-01-01T00:04:00Z", category: "test", scope: "full", exitStatus: "fail", phase: "debugging", editSinceLastTest: false, failureSigChanged: false }),
    capture({ sessionId, ts: "2026-01-01T00:05:00Z", category: "test", scope: "full", exitStatus: "pass", phase: "finalization", editSinceLastTest: true }),
  ];
}

function testFullSuiteCallsPerDebugPhase() {
  const captures = debugLoopSession("s1");
  const value = computeMetric("test.full_suite_calls_per_debug_phase", captures);
  // One debugging-phase run (all consecutive debugging captures), containing 4 full-suite calls
  // (the finalization pass is outside the debugging run).
  assert.equal(value, 4);
}

function testFullSuiteWithoutInterveningEdit() {
  const captures = debugLoopSession("s1");
  const value = computeMetric("test.full_suite_without_intervening_edit", captures);
  assert.equal(value, 3, "three full-suite reruns had no intervening edit");
}

function testTargetedToFullRatio() {
  const captures = debugLoopSession("s1");
  const value = computeMetric("test.targeted_to_full_ratio", captures);
  assert.equal(value, 1 / 5, "1 targeted call vs 5 full-suite calls");
}

function testTestShareOfToolTime() {
  const captures = [
    capture({ sessionId: "s1", ts: "2026-01-01T00:00:00Z", category: "test", scope: "full", exitStatus: "pass", durationMs: 500 }),
    { session_id: "s1", ts: "2026-01-01T00:01:00Z", event: "PostToolUse", harness: "claude", tool: { name: "Read" }, duration_ms: 500, operation: null },
  ];
  const value = computeMetric("test.share_of_tool_time", captures);
  assert.equal(value, 50);
}

function testTokensTotalUsesSessionMax() {
  const captures = [
    { session_id: "s1", ts: "2026-01-01T00:00:00Z", tokens: { total: 100 } },
    { session_id: "s1", ts: "2026-01-01T00:01:00Z", tokens: { total: 300 } },
  ];
  const value = computeMetric("tokens.total", captures);
  assert.equal(value, 300);
}

function testOutcomeCompletionRateNeedsMarkers() {
  const captures = [{ session_id: "s1", ts: "2026-01-01T00:00:00Z", tokens: { total: 1 } }];
  const withoutMarkers = computeMetric("outcome.completion_rate", captures);
  assert.equal(withoutMarkers, null, "no markers means completion rate is not computable, not a guessed zero");
  const withMarkers = computeMetric("outcome.completion_rate", captures, {
    markers: [{ type: "outcome", session_id: "s1", status: "successful" }],
  });
  assert.equal(withMarkers, 100);
}

function testReliabilityCaptureCoverage() {
  const captures = [
    { session_id: "s1", ts: "2026-01-01T00:00:00Z", schema: 3, tokens: { total: 1 } },
    { session_id: "s1", ts: "2026-01-01T00:01:00Z", schema: 2, tokens: { total: 1 } },
  ];
  const value = computeMetric("reliability.capture_coverage", captures);
  assert.equal(value, 50);
}
