import { sessionKey, isRecord } from "./telemetry-oracle-observations.mjs";

// Written evidence policy, intentionally independent of production analytics and presentation.
export const POLICY = Object.freeze({ minimum_cohort: 10, minimum_events: 3, display_band: 0.2 });

export function conditionRows(sessions, snapshots, affectedByKind) {
  const conditions = [];
  for (const [dimension, field] of [["model", "model"], ["repo", "repository_id"], ["harness", "harness"]]) {
    for (const value of [...new Set(sessions.map((session) => session[field]).filter(Boolean))].sort()) conditions.push({ dimension, value });
  }
  for (const dimension of ["packages", "skills"]) {
    for (const value of [...new Set(snapshots.flatMap((snapshot) => snapshot[dimension] ?? []))].sort()) conditions.push({ dimension, value });
  }
  const snapshotIndex = new Map(snapshots.map((snapshot) => [snapshot.snapshot_id, snapshot]));
  const rows = [];
  for (const [eventKind, affectedKeys] of affectedByKind) for (const condition of conditions) {
    const cohorts = { present: [], absent: [], unknown: [] };
    for (const session of sessions) cohorts[evaluateCondition(session, condition, snapshotIndex)].push(session);
    const present = cohorts.present.length, absent = cohorts.absent.length, unknown = cohorts.unknown.length;
    const withAffected = cohorts.present.filter((session) => affectedKeys.has(sessionKey(session))).length;
    const withoutAffected = cohorts.absent.filter((session) => affectedKeys.has(sessionKey(session))).length;
    const withRate = present ? withAffected / present : null, withoutRate = absent ? withoutAffected / absent : null;
    const comparisonAvailable = present > 0 && absent > 0;
    const percentAvailable = comparisonAvailable && withoutRate > 0 && Math.min(present, absent) >= POLICY.minimum_cohort
      && Math.min(withAffected, withoutAffected) >= POLICY.minimum_events;
    const relativeDelta = percentAvailable ? (withRate - withoutRate) / withoutRate : null;
    rows.push({ ...condition, event_kind: eventKind, with_condition: present, without_condition: absent,
      unknown_condition: unknown, known_condition: present + absent, total_observations: sessions.length,
      coverage: sessions.length ? (present + absent) / sessions.length : 0,
      with_affected: withAffected, without_affected: withoutAffected, with_rate: withRate, without_rate: withoutRate,
      relative_delta: relativeDelta, comparison_available: comparisonAvailable, percent_available: percentAvailable,
      presentation_state: !comparisonAvailable ? "unavailable" : !percentAvailable ? "thin"
        : Math.abs(relativeDelta) < POLICY.display_band ? "neutral" : relativeDelta < 0 ? "fewer" : "more" });
  }
  return rows.sort(rowSort);
}

function splitBoundary(sessions, marker) {
  const result = { before: [], after: [], spanning: [], ambiguous: [] };
  const boundary = Date.parse(marker.effective_at ?? marker.ts);
  for (const session of sessions) {
    const first = Date.parse(session.first_seen), last = Date.parse(session.last_seen);
    if (![boundary, first, last].every(Number.isFinite)) result.ambiguous.push(session);
    else if (first < boundary && last > boundary) result.spanning.push(session);
    else if (last < boundary) result.before.push(session);
    else if (first > boundary) result.after.push(session);
    else {
      const comparable = marker.sequence_domain && Number.isSafeInteger(marker.sequence) && session.rows.length
        && session.rows.every((row) => row.sequence_domain === marker.sequence_domain && Number.isSafeInteger(row.sequence));
      if (comparable && session.rows.every((row) => row.sequence < marker.sequence)) result.before.push(session);
      else if (comparable && session.rows.every((row) => row.sequence > marker.sequence)) result.after.push(session);
      else result.ambiguous.push(session);
    }
  }
  return result;
}

export function changeRows(sessions, snapshots, markers, affectedByKind) {
  const superseded = new Set(markers.map((marker) => marker.supersedes).filter(Boolean));
  return markers.filter((marker) => marker.type === "change" && !superseded.has(marker.marker_id)).map((marker) => {
    const scopeKnown = marker.schema >= 2 && (marker.repository_id || marker.scope === "all");
    const scoped = scopeKnown ? sessions.filter((session) => !marker.repository_id || session.repository_id === marker.repository_id) : [];
    return { marker_id: marker.marker_id, comparisons: (marker.watching_kinds ?? []).map((eventKind) => {
      const split = splitBoundary(scoped, marker), affected = affectedByKind.get(eventKind) ?? new Set();
      const cohort = (items) => ({ observations: items.length, affected: items.filter((session) => affected.has(sessionKey(session))).length,
        rate: items.length ? items.filter((session) => affected.has(sessionKey(session))).length / items.length : null });
      const before = cohort(split.before), after = cohort(split.after);
      const enough = Math.min(before.observations, after.observations) >= POLICY.minimum_cohort;
      const state = !scopeKnown ? "can't compare fairly" : !scoped.length ? "recorded"
        : (!before.observations || !after.observations) && (split.ambiguous.length || split.spanning.length) ? "can't compare fairly"
          : enough ? "comparison available" : "collecting";
      const relativeDelta = enough && before.rate > 0 && Math.min(before.affected, after.affected) >= POLICY.minimum_events
        ? (after.rate - before.rate) / before.rate : null;
      const presentationState = state !== "comparison available" ? "collecting" : relativeDelta == null ? "collecting"
        : Math.abs(relativeDelta) < POLICY.display_band ? "neutral" : relativeDelta < 0 ? "fewer" : "more";
      return { event_kind: eventKind, before, after, ambiguous_boundary: split.ambiguous.length,
        spanning_boundary: split.spanning.length, unknown_condition: 0, state, relative_delta: relativeDelta, presentation_state: presentationState };
    }).sort((a, b) => a.event_kind.localeCompare(b.event_kind)) };
  }).sort((a, b) => a.marker_id.localeCompare(b.marker_id));
}

export function rowSort(a, b) {
  return a.event_kind.localeCompare(b.event_kind) || a.dimension.localeCompare(b.dimension) || a.value.localeCompare(b.value);
}

export function snapshotSupport(snapshot) {
  if (!isRecord(snapshot) || typeof snapshot.snapshot_id !== "string"
    || ["packages", "skills"].some((key) => !Array.isArray(snapshot[key]) || snapshot[key].some((item) => typeof item !== "string"))
    || (snapshot.unavailable != null && !Array.isArray(snapshot.unavailable))) {
    return { issues: ["malformed_snapshot"], comparable: false };
  }
  if (![1, 2].includes(snapshot.schema)) return { issues: ["unsupported_snapshot_schema"], comparable: false };
  const unknown = ["packages", "skills"].some((key) => snapshot.unavailable?.includes(key)
    || (snapshot.schema === 2 && snapshot.evaluability?.[key] !== true));
  return { issues: unknown ? ["unknown_snapshot_condition"] : [], comparable: true };
}

export function markerSupport(marker) {
  if (!isRecord(marker) || typeof marker.marker_id !== "string" || typeof (marker.effective_at ?? marker.ts) !== "string"
    || !Number.isFinite(Date.parse(marker.effective_at ?? marker.ts))
    || (marker.repository_id != null && typeof marker.repository_id !== "string")
    || (marker.supersedes != null && typeof marker.supersedes !== "string")
    || (marker.watching_kinds != null && !Array.isArray(marker.watching_kinds))) {
    return { issues: ["malformed_marker"], comparable: false };
  }
  if (![1, 2].includes(marker.schema)) return { issues: ["unsupported_marker_schema"], comparable: false };
  if (!["change", "phase", "outcome", "experiment-start", "experiment-end", "note"].includes(marker.type)) {
    return { issues: ["unsupported_marker_type"], comparable: false };
  }
  if (marker.type !== "change") return { issues: [], comparable: true };
  if (marker.schema === 2 && !Array.isArray(marker.watching_kinds)) return { issues: ["missing_marker_kinds"], comparable: true };
  if ((marker.watching_kinds ?? []).some((kind) => !["spike", "loop", "read-warning"].includes(kind))) {
    return { issues: ["unsupported_marker_kind"], comparable: false };
  }
  return { issues: marker.schema < 2 || (!marker.repository_id && marker.scope !== "all") ? ["unknown_marker_scope"] : [], comparable: true };
}

export function sessionSupport(sessions) {
  const issues = [];
  for (const session of sessions) {
    if (!session.model || !session.repository_id) issues.push("unknown_session_condition");
    if (new Set(session.rows.map((row) => row.config_snapshot_id)).size > 1) issues.push("changing_session_snapshot");
  }
  return { issues, comparable: true };
}

function evaluateCondition(session, condition, snapshotIndex) {
  const field = { model: "model", repo: "repository_id", harness: "harness" }[condition.dimension];
  if (field) return session[field] == null ? "unknown" : session[field] === condition.value ? "present" : "absent";
  const states = session.rows.map((row) => {
    const snapshot = snapshotIndex.get(row.config_snapshot_id);
    if (!snapshot || ![1, 2].includes(snapshot.schema) || !["packages", "skills"].includes(condition.dimension)
      || (snapshot.schema === 2 && snapshot.evaluability?.[condition.dimension] !== true)
      || snapshot.unavailable?.includes(condition.dimension) || !Array.isArray(snapshot[condition.dimension])) return null;
    return snapshot[condition.dimension].includes(condition.value);
  });
  return states.length && states.every((state) => state != null && state === states[0]) ? states[0] ? "present" : "absent" : "unknown";
}
