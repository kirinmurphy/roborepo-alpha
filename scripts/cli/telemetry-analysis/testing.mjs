import { computeMetric } from "../telemetry-metrics.mjs";
// Testing efficiency uses the same metric registry as the CLI and portal.
export function testingEfficiencySummary(captures) {
  const metricIds = [
    "test.full_suite_calls_per_session",
    "test.full_suite_calls_per_testing_session",
    "test.full_suite_calls_per_debug_phase",
    "test.full_suite_without_intervening_edit",
    "test.full_suite_unchanged_failure_signature",
    "test.targeted_to_full_ratio",
    "test.share_of_tool_time",
    "test.token_share",
    "test.time_failure_to_targeted_repro_ms",
    "test.time_first_failure_to_verification_ms",
    "test.finalization_full_suite_count",
    "test.tokens_during_testing",
  ];
  const summary = {};
  for (const id of metricIds) summary[id] = computeMetric(id, captures);
  return summary;
}
