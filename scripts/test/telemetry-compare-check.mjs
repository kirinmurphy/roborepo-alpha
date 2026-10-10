#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  splitCohortsByMarker, equalizeCohorts, compareAcrossMarker, buildFinding, describeMarkerComparison,
  CONFIDENCE_LABELS,
} from "../cli/telemetry-compare.mjs";

// Marker-relative
// comparisons, confidence/data-quality gates, and the actionable finding contract. This REPLACES
// telemetry-analyze.mjs's midpoint-only regression() as the PREFERRED comparison path when a change
// marker is selected (regression() itself is untouched — see telemetry-analyze-check additions).

testSplitCohortsExcludesSpanningSessions();
testEqualizeCohortsBySessionCount();
testCompareAcrossMarkerInsufficientEvidence();
testCompareAcrossMarkerStrongSignal();
testCompareAcrossMarkerDominantSessionFlag();
testUnknownMetricThrows();
testBuildFindingShape();
testDescribeMarkerComparisonCorrelationLanguage();
console.log("telemetry compare checks passed");

function marker(overrides) {
  return {
    marker_id: "mark_test",
    ts: "2026-01-10T00:00:00.000Z",
    type: "change",
    title: "Test-harness guidance v2",
    packages: ["test-harness"],
    skills: ["test-harness"],
    ...overrides,
  };
}

function event({ sessionId, minutesFromMarker, tokensTotal = 10 }) {
  const ts = new Date(Date.parse("2026-01-10T00:00:00.000Z") + minutesFromMarker * 60_000).toISOString();
  return { session_id: sessionId, ts, harness: "claude", tokens: { total: tokensTotal }, event: "PostToolUse", tool: { name: "Bash" } };
}

function testSplitCohortsExcludesSpanningSessions() {
  const captures = [
    event({ sessionId: "before-1", minutesFromMarker: -10 }),
    event({ sessionId: "after-1", minutesFromMarker: 10 }),
    // spans-1 starts before the marker and ends after it.
    event({ sessionId: "spans-1", minutesFromMarker: -5 }),
    event({ sessionId: "spans-1", minutesFromMarker: 5 }),
  ];
  const { before, after, excluded } = splitCohortsByMarker(captures, marker());
  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].session_id, "spans-1");
}

function testEqualizeCohortsBySessionCount() {
  const before = [
    ...Array.from({ length: 3 }, (_, i) => event({ sessionId: `b${i}`, minutesFromMarker: -100 + i })),
  ];
  const after = [
    ...Array.from({ length: 5 }, (_, i) => event({ sessionId: `a${i}`, minutesFromMarker: 10 + i })),
  ];
  const { before: eqBefore, after: eqAfter, window_value } = equalizeCohorts(before, after);
  assert.equal(window_value, 3);
  assert.equal(new Set(eqBefore.map((e) => e.session_id)).size, 3);
  assert.equal(new Set(eqAfter.map((e) => e.session_id)).size, 3);
}

function manySessions(prefix, count, minutesBase, valuesPerSession) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(...valuesPerSession(`${prefix}${i}`, minutesBase + i));
  }
  return out;
}

function testCompareAcrossMarkerInsufficientEvidence() {
  const captures = [
    ...manySessions("before", 2, -100, (id, m) => [event({ sessionId: id, minutesFromMarker: m })]),
    ...manySessions("after", 2, 10, (id, m) => [event({ sessionId: id, minutesFromMarker: m })]),
  ];
  const result = compareAcrossMarker(captures, marker(), "tokens.total");
  assert.equal(result.confidence, "insufficient evidence", "only 2 sessions per cohort is below the default minimum of 10");
}

function testCompareAcrossMarkerStrongSignal() {
  // 25 sessions before (heavier), 25 after (lighter) — enough for "strong signal".
  const before = manySessions("before", 25, -1000, (id, m) => [event({ sessionId: id, minutesFromMarker: m, tokensTotal: 1000 })]);
  const after = manySessions("after", 25, 10, (id, m) => [event({ sessionId: id, minutesFromMarker: m, tokensTotal: 100 })]);
  const result = compareAcrossMarker([...before, ...after], marker(), "tokens.total", { minimumSessionsPerCohort: 10 });
  assert.equal(result.confidence, "strong signal");
  assert.equal(result.before.value, 1000);
  assert.equal(result.after.value, 100);
  assert.equal(result.effect_size, -900);
}

function testCompareAcrossMarkerDominantSessionFlag() {
  // One huge "before" session (20 captures) dwarfs several small ones. Placed most recently among
  // the before-cohort sessions so equalizeCohorts' trailing-session trim keeps it in the window.
  const smallBefore = manySessions("smallb", 12, -300, (id, m) => [event({ sessionId: id, minutesFromMarker: m })]);
  const dominant = Array.from({ length: 20 }, (_, i) => event({ sessionId: "dominant", minutesFromMarker: -50 + i, tokensTotal: 500 }));
  const after = manySessions("after", 12, 10, (id, m) => [event({ sessionId: id, minutesFromMarker: m })]);
  const result = compareAcrossMarker([...smallBefore, ...dominant, ...after], marker(), "tokens.total", { minimumSessionsPerCohort: 10 });
  assert.ok(result.data_quality_issues.some((issue) => issue.includes("dominates")));
  assert.equal(result.confidence, "data-quality warning");
}

function testUnknownMetricThrows() {
  assert.throws(() => compareAcrossMarker([], marker(), "bogus.metric"), /unknown metric/);
  assert.throws(() => compareAcrossMarker([], null, "tokens.total"), /requires a marker/);
}

function testBuildFindingShape() {
  const before = manySessions("before", 25, -1000, (id, m) => [event({ sessionId: id, minutesFromMarker: m, tokensTotal: 1000 })]);
  const after = manySessions("after", 25, 10, (id, m) => [event({ sessionId: id, minutesFromMarker: m, tokensTotal: 100 })]);
  const comparison = compareAcrossMarker([...before, ...after], marker(), "tokens.total");
  const finding = buildFinding({ observation: "test observation", comparison, interpretation: "test interpretation", nextAction: "test action" });
  assert.equal(finding.observation, "test observation");
  assert.ok(finding.evidence);
  assert.ok(finding.cohort);
  assert.ok(finding.sample_size);
  assert.ok(CONFIDENCE_LABELS.includes(finding.confidence));
  assert.deepEqual(finding.data_quality_issues, comparison.data_quality_issues);
  assert.equal(finding.interpretation.labeled_as, "inference");
  assert.equal(finding.next_action, "test action");
  assert.equal(finding.correlation_only, true);
  assert.ok(finding.analysis_filter_state);
}

function testDescribeMarkerComparisonCorrelationLanguage() {
  const before = manySessions("before", 25, -1000, (id, m) => [event({ sessionId: id, minutesFromMarker: m, tokensTotal: 1000 })]);
  const after = manySessions("after", 25, 10, (id, m) => [event({ sessionId: id, minutesFromMarker: m, tokensTotal: 100 })]);
  const comparison = compareAcrossMarker([...before, ...after], marker(), "tokens.total");
  const finding = describeMarkerComparison(comparison, marker());
  assert.doesNotMatch(finding.interpretation.text, /\bcaused\b/i, "interpretation must never claim causation");
  assert.match(finding.interpretation.text, /correlation/i);
}
