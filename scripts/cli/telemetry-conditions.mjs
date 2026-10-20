import { compareObservationBoundary, ambientChanges } from "./telemetry-boundaries.mjs";
import { normalizeObservations, evaluateCondition, aggregateCondition, CONDITIONS_POLICY } from "./telemetry-observations.mjs";

// All initial finding rates use sessions. Read warnings and loops can span flows;
// report-wide testing warnings have no supported session denominator and stay outside.
export const FINDING_UNITS = Object.freeze({ spike: "session", loop: "session", "read-warning": "session" });

export function buildConditionsReport(events, report, options = {}, normalized = normalizeObservations(events)) {
  const snapshots = options.snapshots ?? [];
  const snapshotIndex = new Map(snapshots.map((snapshot) => [snapshot.snapshot_id, snapshot]));
  const sessionIndex = new Map(normalized.sessions.map((session) => [JSON.stringify([session.harness, session.session_id]), session]));
  const contextIndex = new Map();
  const conditions = [];
  for (const [dimension, field] of [["model", "model"], ["repo", "repository_id"], ["harness", "harness"]]) {
    for (const value of [...new Set(normalized.sessions.map((item) => item[field]).filter(Boolean))].sort()) conditions.push({ dimension, value });
  }
  for (const dimension of ["packages", "skills"]) {
    for (const value of [...new Set(snapshots.flatMap((snapshot) => snapshot[dimension] ?? []))].sort()) conditions.push({ dimension, value, label: dimension === "skills" ? "available" : "configured" });
  }
  const findings = [["spike", report.spikes], ["loop", report.loops], ["read-warning", report.read_warnings]];
  const ledger = [];
  const comparisons = [];
  const affectedByKind = new Map();
  let findingsLostToFallback = 0;
  for (const [kind, rows] of findings) {
    const affected = new Set();
    for (const row of rows ?? []) {
      const observation = sessionIndex.get(JSON.stringify([row.harness, row.session_id]));
      if (!observation) { findingsLostToFallback++; continue; }
      affected.add(observation.id);
      const context = contextIndex.get(observation.id) ?? { model: observation.model, model_attribution: observation.model_attribution,
        repository_id: observation.repository_id, harness: observation.harness,
        conditions: conditions.map((condition) => ({ ...condition, ...evaluateCondition(observation, condition, snapshotIndex) })) };
      contextIndex.set(observation.id, context);
      const provenance = observation.rows.filter((item) => item.ts === row.ts && item.spool_provenance).map((item) => item.spool_provenance)
        .sort((a, b) => a.source.localeCompare(b.source) || a.sequence - b.sequence)[0] ?? null;
      ledger.push({ provenance, id: JSON.stringify([kind, observation.id, row.ts, row.kind ?? row.type ?? null]), kind,
        ts: row.ts, session_id: row.session_id, harness: row.harness, context, observation_unit: "session",
        repository_label: row.repo ?? null, detail: row.hint ?? null, delta_tokens: row.delta_tokens ?? null,
        spike_count: row.spike_count ?? null, tool: row.tool ?? null, max_repeat: row.max_repeat ?? null,
        wasted_tokens: row.wasted_tokens ?? null, warning_type: row.type ?? null, read_count: row.read_count ?? null,
        result_chars: row.result_chars ?? null, approx_tokens: row.approx_tokens ?? null });
    }
    affectedByKind.set(kind, affected);
    for (const condition of conditions) comparisons.push(aggregateCondition(normalized.sessions, condition, affected, { snapshots: snapshotIndex, eventKind: kind }));
  }
  const markers = options.markers ?? [];
  const superseded = new Set(markers.map((marker) => marker.supersedes).filter(Boolean));
  const activeMarkers = markers.filter((marker) => marker.type === "change" && !superseded.has(marker.marker_id));
  const changes = activeMarkers.map((marker) => ({ marker,
    comparisons: (marker.watching_kinds ?? []).map((kind) => ({ event_kind: kind,
      ...(affectedByKind.has(kind) ? compareObservationBoundary(normalized.sessions, marker, affectedByKind.get(kind), { condition: options.condition ?? null, snapshots })
        : { state: "can't compare fairly", reason: "Finding has no supported session evidence" }) })) }));
  const ambient = ambientChanges(normalized.sessions, snapshots);
  const markerOrder = new Map(markers.map((marker, index) => [marker.marker_id, index]));
  for (const row of ambient) ledger.push({ ...row, context: { model: null, model_attribution: "unknown", repository_id: row.repository_id, harness: row.harness, conditions: [] } });
  for (const marker of activeMarkers) ledger.push({ id: marker.marker_id, kind: "manual-change", ts: marker.effective_at ?? marker.ts, marker, persisted_order: markerOrder.get(marker.marker_id),
    session_id: marker.session_id, harness: null, context: { model: null, model_attribution: "unknown", repository_id: marker.repository_id, harness: null, conditions: [] } });
  ledger.sort((a, b) => String(b.ts).localeCompare(String(a.ts)) || String(a.provenance?.source ?? "").localeCompare(String(b.provenance?.source ?? "")) || (b.provenance?.sequence ?? 0) - (a.provenance?.sequence ?? 0) || (b.persisted_order ?? 0) - (a.persisted_order ?? 0) || a.id.localeCompare(b.id));
  return { schema: 1, policy: CONDITIONS_POLICY, finding_units: FINDING_UNITS,
    comparisons, changes, ambient_changes: ambient, ledger,
    data_quality: { fallback_flows: normalized.fallback_flows, unidentified_sessions: normalized.unidentified_sessions, findings_lost_to_fallback: findingsLostToFallback, sessions: normalized.sessions.length,
      flows: normalized.flows.length,
      condition_coverage: Object.fromEntries(["model", "repo", "harness", "packages", "skills"].map((dimension) => {
        const requested = conditions.filter((condition) => condition.dimension === dimension);
        const checks = requested.length ? requested : [{ dimension, value: "__coverage_probe__" }];
        const known = normalized.sessions.filter((item) => checks.every((condition) => evaluateCondition(item, condition, snapshotIndex).evaluable)).length;
        return [dimension, { eligible: normalized.sessions.length, known, unknown: normalized.sessions.length - known }];
      })), unknown_model_sessions: normalized.sessions.filter((item) => !item.model).length },
    correlation_only: true, non_additive: true };
}
