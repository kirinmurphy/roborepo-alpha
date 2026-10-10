import { createWasteLedger } from "../telemetry-waste.mjs";
import { isFullSuite } from "../telemetry-metrics.mjs";
import { describeCohortFilter, activeFilterCount } from "../telemetry-cohort.mjs";
import { compareAcrossMarker, describeMarkerComparison } from "../telemetry-compare.mjs";
import { deriveInsights } from "../telemetry-insights.mjs";
import { hasTokens, sessionKeyOf } from "./captures.mjs";
import { indexScopedEvents, indexCaptures, rankedTop, usageWindows } from "./capture-index.mjs";
import { rollupSessions, computeCumulativeConcern } from "./sessions.mjs";
import { deltaSpikeThreshold, spikeRow, rollupCauses, compareSpikeVsNormal, spikeAnatomy } from "./spikes.mjs";
import { toolCost, groupCost, packageCost } from "./costs.mjs";
import { regression } from "./regression.mjs";
import { detectLoops } from "./loops.mjs";
import { dataQualityWarnings } from "./data-quality.mjs";
import { readWarnings } from "./read-warnings.mjs";
import { testingEfficiencySummary } from "./testing.mjs";
// Assemble the report from focused production calculations; raw evidence stays with the caller.
export function analyzeRows(rows, scopedEvents, events, normalizedFilter, { markers = [], markerId = null, compareMetric = "tokens.total" }) {
  const scopedIndex = indexScopedEvents(rows);
  const captures = scopedIndex.captures;
  const captureIndex = indexCaptures(captures);
  const sessions = rollupSessions(captures);
  const spikeThreshold = deltaSpikeThreshold(captures);
  const spikeCaptures = captures.filter((event) => (event.delta_tokens || 0) >= spikeThreshold && spikeThreshold > 0);
  // Findings nominate turns; summarize only after loops and reads have contributed.
  const wasteLedger = createWasteLedger();
  for (const event of spikeCaptures) wasteLedger.add(event, "spikes", (event.delta_tokens || 0) - spikeThreshold);
  for (const event of captures) {
    if (isFullSuite(event) && event.intervening?.edit_since_last_test === false) wasteLedger.add(event, "testing", event.delta_tokens || 0);
  }
  const sessionsById = new Map(sessions.map((s) => [sessionKeyOf(s), s]));
  const spikeCountBySess = new Map();
  for (const event of spikeCaptures) {
    const id = sessionKeyOf(event);
    spikeCountBySess.set(id, (spikeCountBySess.get(id) || 0) + 1);
  }
  const bestSpikeBySess = new Map();
  for (const event of spikeCaptures) {
    const id = sessionKeyOf(event);
    if (!bestSpikeBySess.has(id) || (event.delta_tokens || 0) > (bestSpikeBySess.get(id)?.delta_tokens ?? 0)) {
      bestSpikeBySess.set(id, event);
    }
  }
  const report = {
    version: `${scopedEvents.length}:${scopedEvents[scopedEvents.length - 1]?.ts ?? "0"}`,
    event_count: scopedEvents.length,
    capture_count: captures.length,
    sessions,
    spike_threshold: spikeThreshold,
    spikes: [...bestSpikeBySess.values()]
      .map((event) => ({ ...spikeRow(event, sessionsById), spike_count: spikeCountBySess.get(sessionKeyOf(event)) || 1 }))
      .sort((a, b) => b.delta_tokens - a.delta_tokens),
    harnesses: scopedIndex.harnesses,
    cumulative_concern: computeCumulativeConcern(sessions),
    top_repos: rankedTop(captureIndex.topRepos),
    top_tools: rankedTop(captureIndex.topTools),
    top_mcp: rankedTop(captureIndex.topMcp),
    top_events: rankedTop(captureIndex.topEvents),
    comparison: compareSpikeVsNormal(captures, spikeThreshold),
    spike_causes: rollupCauses(spikeCaptures),
    usage_windows: usageWindows(captures, captureIndex.latestTs),
    codex_provider_rate_limits: captureIndex.latestCodexRateLimits,
    timeline: captureIndex.timeline,
    tool_cost: toolCost(captures),
    group_cost: groupCost(captures),
    spike_anatomy: spikeAnatomy(captures, spikeCaptures),
    package_cost: packageCost(captures),
    regression: { ...regression(captures), exploratory: true, label: "midpoint (exploratory — not tied to any specific change)" },
    loops: detectLoops(captures, sessionsById, wasteLedger),
    data_quality_warnings: dataQualityWarnings(scopedEvents),
    read_warnings: readWarnings(rows, sessionsById, wasteLedger),
    testing_efficiency: testingEfficiencySummary(captures),
    waste: null,
    cohort: normalizedFilter
      ? { filter: normalizedFilter, summary: describeCohortFilter(normalizedFilter), active_filter_count: activeFilterCount(normalizedFilter) }
      : null,
  };
  report.waste = wasteLedger.summarize(captureIndex.latestTs);
  // The marker owns its cohort boundary, so use the full pre-filter event set.
  const marker = markerId ? markers.find((m) => m.marker_id === markerId) : null;
  if (marker) {
    const comparison = compareAcrossMarker(events.filter(hasTokens), marker, compareMetric, { markers });
    report.marker_comparison = describeMarkerComparison(comparison, marker);
  } else {
    report.marker_comparison = null;
  }
  report.insights = deriveInsights(report);
  return report;
}
