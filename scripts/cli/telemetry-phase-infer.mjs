// Pure, explainable phase inference (inferred phase tagging). Zero fs/config
// dependency so it stays cheap enough to import from the hot capture path, same discipline as
// telemetry-classify.mjs. Callers are responsible for building the `signals` object from whatever
// session-scoped activity state they track (telemetry-capture.mjs keeps this in a collector-dir cursor);
// this module only implements the decision rules over that already-summarized state.
//
// Store this version alongside every inferred phase so historical data stays interpretable if the
// rules change later (same discipline as telemetry-classify.mjs's CLASSIFIER_VERSION).
export const PHASE_CLASSIFIER_VERSION = 1;

export const PHASE_NAMES = ["discovery", "implementation", "debugging", "verification", "finalization", "unknown"];

// Confidence below this collapses to "unknown" in comparisons. Exported
// so analysis code can apply the identical threshold
// rather than each caller picking its own number.
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

// `signals` shape (all optional; callers pass what they've accumulated so far this session):
// - editCount: number of write/edit tool calls since the last phase-relevant reset
// - readCount: number of read/search tool calls since the last phase-relevant reset
// - lastTestOperation: { category, scope, exit_status } | null — most recent test/lint/typecheck/build op
// - testFailureStreak: number of consecutive failing test operations observed
// - editSinceLastFailure: boolean — an edit occurred after the most recent test failure
// - broadCheckRan: boolean — a full-scope test/lint/build ran after implementation activity
// - finalizationSignals: boolean — a git commit/status/push-shaped operation or explicit completion output was seen
export function inferPhase(signals = {}) {
  const {
    editCount = 0,
    readCount = 0,
    lastTestOperation = null,
    testFailureStreak = 0,
    editSinceLastFailure = false,
    broadCheckRan = false,
    finalizationSignals = false,
  } = signals;

  // Rules are checked most-specific-first: finalization and debugging are stronger, narrower signals
  // than the broad discovery/implementation defaults, so they must win when present.
  if (finalizationSignals) {
    return result("finalization", 0.8);
  }
  if (lastTestOperation?.category === "test" && lastTestOperation.exit_status === "fail" && testFailureStreak >= 1) {
    // A failure alone is debugging; a failure immediately followed by an edit (still no passing rerun
    // yet) is a stronger debugging signal than the failure by itself.
    return result("debugging", editSinceLastFailure ? 0.85 : 0.7);
  }
  if (broadCheckRan && editCount > 0 && testFailureStreak === 0) {
    return result("verification", 0.75);
  }
  if (editCount > 0) {
    return result("implementation", editCount >= 2 ? 0.75 : 0.6);
  }
  if (readCount > 0 && editCount === 0) {
    return result("discovery", 0.7);
  }
  return result("unknown", 0);
}

function result(name, confidence) {
  const collapsed = confidence < LOW_CONFIDENCE_THRESHOLD ? "unknown" : name;
  return {
    name: collapsed,
    source: "inferred",
    confidence,
    classifier_version: PHASE_CLASSIFIER_VERSION,
  };
}
