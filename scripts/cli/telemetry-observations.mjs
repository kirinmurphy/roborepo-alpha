// Pure observation boundary. Persisted v2/v3 tokens are cumulative session counters;
// a tool hook's delta_tokens is never an attributable input/output usage record.
import { createHash } from "node:crypto";
import { repositoryRefForEvent } from "./telemetry-repository.mjs";

export function stableTelemetryJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableTelemetryJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableTelemetryJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value) => createHash("sha256").update(stableTelemetryJson(value)).digest("hex");
const known = (value) => typeof value === "string" && value && value !== "unknown" ? value : null;
const unique = (values) => [...new Set(values)].sort();
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const sum = (values) => {
  if (!values.every(count)) return null;
  const result = values.reduce((a, b) => a + b, 0);
  return count(result) ? result : null;
};

// Only the persisted capture shape is accepted. Provider-native payloads are converted
// by transcript-parse before persistence, so accepting them here would conceal schema drift.
export function normalizeTokenUsage(tokens) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const { input, output, cache_creation = 0, cache_read = 0, total } = tokens;
  if (![input, output, cache_creation, cache_read, total].every(count)) return null;
  const inputTotal = sum([input, cache_creation, cache_read]);
  const components = sum([input, output, cache_creation, cache_read]);
  if (inputTotal === null || components === null) return null;
  // Provider totals can override the sum (e.g. reasoning usage). Preserve both facts.
  return { input: inputTotal, output, total, component_total: components, total_override: total !== components };
}

export function observationIdentity(event) {
  const harness = known(event.harness);
  const session = known(event.session_id);
  const call = known(event.call_id);
  if (event.schema === 3 && harness && session && call && !call.startsWith("derived_")) {
    return { id: JSON.stringify(["flow", harness, session, call]), quality: "exact" };
  }
  // Derived IDs cannot prove independence or safely merge mirrors from different captures.
  const fallback = known(event.capture_id) || digest(event);
  return { id: JSON.stringify(["capture", harness, session, fallback]), quality: event.capture_id ? "capture_fallback" : "content_fallback" };
}

function consensus(rows, extract) {
  const values = rows.map(extract);
  return values.length && values.every((value) => value != null && value === values[0]) ? values[0] : null;
}

function canonicalRows(events) {
  const ordered = [...events].sort((a, b) => String(b.spool_provenance?.source ?? "").localeCompare(String(a.spool_provenance?.source ?? "")) || (b.spool_provenance?.sequence ?? 0) - (a.spool_provenance?.sequence ?? 0));
  return [...new Map(ordered.map((event) => [stableTelemetryJson(event), event])).entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([, event]) => event);
}

function observation(id, rows, unit, quality) {
  const model = consensus(rows, (row) => known(row.session?.model));
  const times = unique(rows.map((row) => Number.isFinite(Date.parse(row.ts)) ? new Date(row.ts).toISOString() : null).filter(Boolean));
  // A session counter is sampled once, at the last observed timestamp. Conflicting mirrors
  // at that boundary make usage unavailable, rather than selecting a convenient maximum.
  const latest = times.at(-1);
  const lastRows = rows.filter((row) => latest && Number.isFinite(Date.parse(row.ts)) && new Date(row.ts).toISOString() === latest);
  const usages = lastRows.map((row) => normalizeTokenUsage(row.tokens));
  const usage = unit === "session" && rows.every((row) => [2, 3].includes(row.schema)) && usages.length && usages.every((value) => value && stableTelemetryJson(value) === stableTelemetryJson(usages[0])) ? usages[0] : null;
  return {
    id, observation_unit: unit, identity_quality: quality,
    harness: consensus(rows, (row) => known(row.harness)),
    session_id: consensus(rows, (row) => known(row.session_id)),
    repository_id: consensus(rows, (row) => repositoryRefForEvent(row).repositoryId),
    model, model_attribution: model ? "approximate" : "unknown",
    first_seen: times[0] ?? null, last_seen: latest ?? null,
    tokens: usage, token_semantics: unit === "session" ? "session_cumulative" : "unavailable",
    rows,
  };
}

export function normalizeObservations(events) {
  const flows = new Map();
  const sessions = new Map();
  for (const event of canonicalRows(events.filter((row) => row && (row.schema == null || row.schema === 2 || row.schema === 3) && (row.session_id || row.capture_id || row.tokens || row.tool)))) {
    const identity = observationIdentity(event);
    if (!flows.has(identity.id)) flows.set(identity.id, { rows: [], quality: identity.quality });
    flows.get(identity.id).rows.push(event);
    const sessionKey = known(event.harness) && known(event.session_id)
      ? JSON.stringify(["session", event.harness, event.session_id]) : JSON.stringify(["session_fallback", identity.id]);
    if (!sessions.has(sessionKey)) sessions.set(sessionKey, []);
    sessions.get(sessionKey).push(event);
  }
  return {
    flows: [...flows].sort(([a], [b]) => a.localeCompare(b)).map(([id, group]) => observation(id, group.rows, "flow", group.quality)),
    sessions: [...sessions].filter(([id]) => !id.startsWith('["session_fallback"')).sort(([a], [b]) => a.localeCompare(b)).map(([id, rows]) => observation(id, rows, "session", "exact")),
    unidentified_sessions: [...sessions.keys()].filter((id) => id.startsWith('["session_fallback"')).length,
    fallback_flows: [...flows.values()].filter((group) => group.quality !== "exact").length,
  };
}

export function evaluateCondition(observation, condition, snapshots = []) {
  const { dimension, value } = condition;
  const scalar = { model: "model", harness: "harness", repo: "repository_id" }[dimension];
  let present = null;
  if (scalar) present = observation[scalar] == null ? null : observation[scalar] === value;
  else {
    const snapshotIndex = snapshots instanceof Map ? snapshots : new Map(snapshots.map((snapshot) => [snapshot.snapshot_id, snapshot]));
    // v1 packages/skills are captured globally. v1 rules/commands/hooks are incomplete
    // placeholders, and a snapshot's harness is not proof of provider coverage.
    const states = observation.rows.map((row) => {
      const snapshot = snapshotIndex.get(row.config_snapshot_id);
      if (!snapshot || ![1, 2].includes(snapshot.schema) || !["packages", "skills"].includes(dimension)
        || (snapshot.schema === 2 && snapshot.evaluability?.[dimension] !== true) || snapshot.unavailable?.includes(dimension) || !Array.isArray(snapshot[dimension])) return null;
      return snapshot[dimension].includes(value);
    });
    if (states.length && states.every((state) => state != null && state === states[0])) present = states[0];
  }
  return { evaluable: present != null, present: present === true, state: present == null ? "unknown" : present ? "present" : "absent" };
}

export const CONDITIONS_POLICY = Object.freeze({ minimum_cohort: 10, minimum_events: 3, display_band: 0.2 });

export function aggregateCondition(observations, condition, affectedIds, { snapshots = [], policy = CONDITIONS_POLICY, eventKind = null } = {}) {
  if (new Set(observations.map((item) => item.observation_unit)).size > 1) throw new Error("condition cohorts must use one observation unit");
  const cohorts = { present: [], absent: [], unknown: [] };
  for (const item of new Map(observations.map((item) => [item.id, item])).values()) cohorts[evaluateCondition(item, condition, snapshots).state].push(item);
  const withCount = cohorts.present.length, withoutCount = cohorts.absent.length, unknownCount = cohorts.unknown.length;
  const withAffected = cohorts.present.filter((item) => affectedIds.has(item.id)).length;
  const withoutAffected = cohorts.absent.filter((item) => affectedIds.has(item.id)).length;
  const withRate = withCount ? withAffected / withCount : null;
  const withoutRate = withoutCount ? withoutAffected / withoutCount : null;
  const available = withCount > 0 && withoutCount > 0;
  const percentAvailable = available && withoutRate > 0 && Math.min(withCount, withoutCount) >= policy.minimum_cohort && Math.min(withAffected, withoutAffected) >= policy.minimum_events;
  return { ...condition, event_kind: eventKind, observation_unit: observations[0]?.observation_unit ?? "session",
    with_condition: withCount, without_condition: withoutCount, unknown_condition: unknownCount,
    known_condition: withCount + withoutCount, total_observations: withCount + withoutCount + unknownCount,
    coverage: withCount + withoutCount + unknownCount ? (withCount + withoutCount) / (withCount + withoutCount + unknownCount) : 0,
    with_affected: withAffected, without_affected: withoutAffected, with_rate: withRate, without_rate: withoutRate,
    relative_delta: percentAvailable ? (withRate - withoutRate) / withoutRate : null,
    comparison_available: available, percent_available: percentAvailable, policy,
  };
}

// Shared deterministic representative for legacy finding detectors and operation metrics.
export function canonicalFlowRows(normalized) {
  return normalized.flows.map((flow) => [...flow.rows].sort((a, b) =>
    Number(b.event === "PostToolUse") - Number(a.event === "PostToolUse")
    || String(b.ts).localeCompare(String(a.ts))
    || String(a.spool_provenance?.source ?? "").localeCompare(String(b.spool_provenance?.source ?? ""))
    || (b.spool_provenance?.sequence ?? 0) - (a.spool_provenance?.sequence ?? 0)
    || stableTelemetryJson(a).localeCompare(stableTelemetryJson(b)))[0]);
}
