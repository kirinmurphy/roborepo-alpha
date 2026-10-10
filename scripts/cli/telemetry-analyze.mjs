// Shared pure entry point for the CLI report and portal: filter, normalize, analyze, add conditions.
import { createHash } from "node:crypto";
import { buildConditionsReport } from "./telemetry-conditions.mjs";
import { normalizeObservations, canonicalFlowRows } from "./telemetry-observations.mjs";
import { applyCohortFilter, normalizeCohortFilter } from "./telemetry-cohort.mjs";
import { analyzeRows } from "./telemetry-analysis/rows.mjs";

export { spikeCause } from "./telemetry-analysis/spikes.mjs";

// cohortFilter scopes every panel. markerId selects a markers entry for compareMetric (tokens.total
// by default); repositoryHashIndex resolves legacy repository evidence before either comparison.
export function analyzeTelemetry(events, options = {}) {
  const { cohortFilter = null, markers = [], repositoryHashIndex = null } = options;
  const normalizedFilter = cohortFilter ? normalizeCohortFilter(cohortFilter) : null;
  const scopedEvents = normalizedFilter ? applyCohortFilter(events, normalizedFilter, { markers, repositoryHashIndex }) : events;
  // One representative row per operation, so mirrored captures never double-count.
  const observations = normalizeObservations(scopedEvents, { repositoryHashIndex });
  const report = analyzeRows(canonicalFlowRows(observations), scopedEvents, events, normalizedFilter, options);
  report.conditions = buildConditionsReport(scopedEvents, report, options, observations);
  for (const [key, kind] of [["spikes", "spike"], ["loops", "loop"], ["read_warnings", "read-warning"]]) {
    for (const finding of report[key]) finding.condition_context = report.conditions.ledger.find((row) => row.kind === kind && row.session_id === finding.session_id && row.harness === finding.harness)?.context ?? null;
  }
  report.version += ":" + createHash("sha256").update(JSON.stringify(report.conditions)).digest("hex").slice(0, 16);
  return report;
}
