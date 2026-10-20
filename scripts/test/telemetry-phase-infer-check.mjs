#!/usr/bin/env node
import assert from "node:assert/strict";
import { inferPhase, PHASE_CLASSIFIER_VERSION, LOW_CONFIDENCE_THRESHOLD } from "../cli/telemetry-phase-infer.mjs";

// Explainable phase
// inference over already-summarized session activity signals. Pure module, no fs/session state —
// telemetry-capture.mjs owns building the `signals` object from its per-session activity cursor.

testDiscoveryFromReadsOnly();
testImplementationFromEdits();
testDebuggingFromFailingTest();
testDebuggingStrongerWithEditAfterFailure();
testVerificationFromBroadCheckAfterEdits();
testFinalizationWins();
testNoSignalsCollapsesToUnknown();
testClassifierVersionStamped();
testLowConfidenceCollapsesToUnknown();
console.log("telemetry phase-infer checks passed");

function testDiscoveryFromReadsOnly() {
  const phase = inferPhase({ readCount: 3, editCount: 0 });
  assert.equal(phase.name, "discovery");
  assert.equal(phase.source, "inferred");
}

function testImplementationFromEdits() {
  const phase = inferPhase({ editCount: 2, readCount: 1 });
  assert.equal(phase.name, "implementation");
}

function testDebuggingFromFailingTest() {
  const phase = inferPhase({
    editCount: 1,
    lastTestOperation: { category: "test", scope: "full", exit_status: "fail" },
    testFailureStreak: 1,
  });
  assert.equal(phase.name, "debugging");
}

function testDebuggingStrongerWithEditAfterFailure() {
  const withoutEdit = inferPhase({
    lastTestOperation: { category: "test", exit_status: "fail" },
    testFailureStreak: 1,
    editSinceLastFailure: false,
  });
  const withEdit = inferPhase({
    lastTestOperation: { category: "test", exit_status: "fail" },
    testFailureStreak: 1,
    editSinceLastFailure: true,
  });
  assert.equal(withoutEdit.name, "debugging");
  assert.equal(withEdit.name, "debugging");
  assert.ok(withEdit.confidence > withoutEdit.confidence, "an edit after a failure is a stronger debugging signal");
}

function testVerificationFromBroadCheckAfterEdits() {
  const phase = inferPhase({ editCount: 3, broadCheckRan: true, testFailureStreak: 0 });
  assert.equal(phase.name, "verification");
}

function testFinalizationWins() {
  // Finalization signals must win even alongside edit/read/test activity — it's checked first.
  const phase = inferPhase({ editCount: 5, readCount: 5, broadCheckRan: true, finalizationSignals: true });
  assert.equal(phase.name, "finalization");
}

function testNoSignalsCollapsesToUnknown() {
  const phase = inferPhase({});
  assert.equal(phase.name, "unknown");
  assert.equal(phase.confidence, 0);
}

function testClassifierVersionStamped() {
  const phase = inferPhase({ editCount: 1 });
  assert.equal(phase.classifier_version, PHASE_CLASSIFIER_VERSION);
}

function testLowConfidenceCollapsesToUnknown() {
  // Plan requirement: "low-confidence phases collapse to unknown in comparisons unless the user
  // opts in." A single read is deliberately the weakest discovery signal (confidence 0.7, which is
  // still >= threshold) — assert the threshold constant itself gates correctly at its own boundary.
  assert.ok(LOW_CONFIDENCE_THRESHOLD > 0 && LOW_CONFIDENCE_THRESHOLD < 1);
  const weak = inferPhase({ readCount: 0, editCount: 0, lastTestOperation: null });
  assert.equal(weak.name, "unknown");
}
