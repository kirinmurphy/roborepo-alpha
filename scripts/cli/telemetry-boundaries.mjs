import { evaluateCondition, CONDITIONS_POLICY } from "./telemetry-observations.mjs";

// Ordering evidence must come from one persisted sequence domain. Independent log
// offsets and ID sort order are useful for display, never for boundary placement.
export function splitObservationBoundary(observations, marker) {
  const result = { before: [], after: [], spanning: [], ambiguous: [] };
  const boundary = Date.parse(marker.effective_at ?? marker.ts);
  for (const observation of observations) {
    const first = Date.parse(observation.first_seen), last = Date.parse(observation.last_seen);
    if (![boundary, first, last].every(Number.isFinite)) result.ambiguous.push(observation);
    else if (first < boundary && last > boundary) result.spanning.push(observation);
    else if (last < boundary) result.before.push(observation);
    else if (first > boundary) result.after.push(observation);
    else {
      const domain = marker.sequence_domain;
      const sequence = marker.sequence;
      const rows = observation.rows ?? [];
      const comparable = domain && Number.isSafeInteger(sequence) && rows.length && rows.every((row) => row.sequence_domain === domain && Number.isSafeInteger(row.sequence));
      if (comparable && rows.every((row) => row.sequence < sequence)) result.before.push(observation);
      else if (comparable && rows.every((row) => row.sequence > sequence)) result.after.push(observation);
      else result.ambiguous.push(observation);
    }
  }
  return result;
}

export function compareObservationBoundary(observations, marker, affectedIds, { condition = null, snapshots = [], policy = CONDITIONS_POLICY } = {}) {
  const scopeKnown = marker.repository_id || marker.scope === "all";
  const inScope = scopeKnown ? observations.filter((item) => !marker.repository_id || item.repository_id === marker.repository_id) : [];
  const scoped = condition ? inScope.filter((item) => evaluateCondition(item, condition, snapshots).state === "present") : inScope;
  // Unknown condition data is excluded, never treated as absence; say how much was left out.
  const unknownCondition = condition ? inScope.filter((item) => evaluateCondition(item, condition, snapshots).state === "unknown").length : 0;
  const split = splitObservationBoundary(scoped, marker);
  const cohort = (items) => ({ observations: items.length, affected: items.filter((item) => affectedIds.has(item.id)).length,
    rate: items.length ? items.filter((item) => affectedIds.has(item.id)).length / items.length : null });
  const before = cohort(split.before), after = cohort(split.after);
  const enough = Math.min(before.observations, after.observations) >= policy.minimum_cohort;
  return { marker_id: marker.marker_id, observation_unit: "session", before, after,
    ambiguous_boundary: split.ambiguous.length, spanning_boundary: split.spanning.length, unknown_condition: unknownCondition,
    state: !scopeKnown ? "can't compare fairly" : !scoped.length ? "recorded" : (!before.observations || !after.observations) && (split.ambiguous.length || split.spanning.length) ? "can't compare fairly" : enough ? "comparison available" : "collecting",
    relative_delta: enough && before.rate > 0 && Math.min(before.affected, after.affected) >= policy.minimum_events ? (after.rate - before.rate) / before.rate : null,
    condition, policy, correlation_only: true };
}

export function ambientChanges(sessions, snapshots) {
  const index = new Map(snapshots.map((snapshot) => [snapshot.snapshot_id, snapshot]));
  const groups = new Map();
  for (const session of sessions) {
    if (!session.repository_id || !session.harness) continue;
    const key = JSON.stringify([session.repository_id, session.harness]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  const changes = [];
  for (const group of groups.values()) {
    group.sort((a, b) => String(a.first_seen).localeCompare(String(b.first_seen)) || a.id.localeCompare(b.id));
    let previous = null;
    for (let i = 0; i < group.length; i++) {
      const session = group[i];
      const ids = [...new Set(session.rows.map((row) => row.config_snapshot_id))];
      const snapshot = ids.length === 1 ? index.get(ids[0]) : null;
      const evidence = snapshot && snapshot.ambient?.harness === session.harness && snapshot.ambient?.evaluable ? snapshot.ambient : null;
      // Unknown evidence or same-time sessions break the transition chain.
      if (!evidence || !session.first_seen || group[i - 1]?.first_seen === session.first_seen || group[i + 1]?.first_seen === session.first_seen) { previous = null; continue; }
      if (previous && previous.hash !== evidence.hash) changes.push({ id: `ambient:${session.id}`, kind: "ambient-change", ts: session.first_seen,
        session_id: session.session_id, harness: session.harness, repository_id: session.repository_id,
        provenance: session.rows.find((row) => row.ts === session.first_seen && row.spool_provenance)?.spool_provenance ?? null,
        previous_hash: previous.hash, ambient_hash: evidence.hash, observed_boundary: true,
        label: "Configured ambient package surface first observed changed" });
      previous = evidence;
    }
  }
  // Equal timestamps fall back to persisted spool order (source, then sequence), newest first.
  return changes.sort((a, b) => String(b.ts).localeCompare(String(a.ts)) || String(a.provenance?.source ?? "").localeCompare(String(b.provenance?.source ?? "")) || (b.provenance?.sequence ?? 0) - (a.provenance?.sequence ?? 0) || a.id.localeCompare(b.id));
}
