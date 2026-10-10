// Normalized cohort filter object shared by CLI and portal analysis.
// A cohort filter never touches fs — it is applied to an already-loaded array of capture events (the
// same array analyzeTelemetry() already receives), so both the CLI report and the portal's /api/data
// and /api/telemetry/analysis handlers can build one filter object and get identical results.
//
// Shape (all fields optional; omitted/empty means "no restriction on this dimension"):
// {
//   time: { range_ms, end },      // same semantics as telemetry.mjs's filterByWindow window
//   harnesses: string[],
//   models: string[],
//   repos: string[],              // legacy label match (event.repo.label) — preserved as-is
//   repository_ids: string[],     // canonical repository ids; composes with repos
//   packages: [{ id, state }],    // state: "active" — matched against config_snapshot's packages
//   skills: [{ id, state }],      // state: "active" — matched against config_snapshot's skills
//   operations: string[],         // operation.category values
//   phases: string[],             // phase.name values
//   outcomes: string[],           // outcome marker status values, matched by session_id
//   task_categories: string[],
//   snapshot_ids: string[],
// }

import { readSnapshot } from "./telemetry-schemas/persistence.mjs";
import { repositoryRefForEvent } from "./telemetry-repository.mjs";

export function emptyCohortFilter() {
  return {
    time: null,
    harnesses: [],
    models: [],
    repos: [],
    repository_ids: [],
    packages: [],
    skills: [],
    operations: [],
    phases: [],
    outcomes: [],
    task_categories: [],
    snapshot_ids: [],
  };
}

// Merge a partial filter (as received from a query string or POST body) over the empty defaults, so
// every caller works with a fully-shaped object even when the request only sets one field.
export function normalizeCohortFilter(partial) {
  const base = emptyCohortFilter();
  if (!partial || typeof partial !== "object") return base;
  return {
    time: partial.time && typeof partial.time === "object" ? { range_ms: numberOrNull(partial.time.range_ms), end: numberOrNull(partial.time.end) } : null,
    harnesses: stringArray(partial.harnesses),
    models: stringArray(partial.models),
    repos: stringArray(partial.repos),
    repository_ids: stringArray(partial.repository_ids),
    packages: packageStateArray(partial.packages),
    skills: packageStateArray(partial.skills),
    operations: stringArray(partial.operations),
    phases: stringArray(partial.phases),
    outcomes: stringArray(partial.outcomes),
    task_categories: stringArray(partial.task_categories),
    snapshot_ids: stringArray(partial.snapshot_ids),
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry.length > 0);
}

function packageStateArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string")
    .map((entry) => ({ id: entry.id, state: entry.state === "active" ? "active" : "active" }));
}

// Snapshot cache so repeated exposure checks against the same cohort don't re-read the same
// snapshot file per capture. Keyed by snapshot_id; cleared implicitly per-process (short-lived CLI
// invocations and per-request portal calls both make a fresh cache naturally acceptable here).
function snapshotLookup() {
  const cache = new Map();
  return (snapshotId) => {
    if (!snapshotId) return null;
    if (cache.has(snapshotId)) return cache.get(snapshotId);
    const snapshot = readSnapshot(snapshotId);
    cache.set(snapshotId, snapshot);
    return snapshot;
  };
}

// Applies a normalized cohort filter to an array of capture events (schema v2/v3). Sessions with no
// explicit outcome marker are excluded only when an `outcomes` filter is active (there is nothing to
// match against otherwise) — callers filtering by outcome must pass `markers` so session_id -> status
// can be resolved; omitting markers while filtering by outcome degrades to "no restriction" rather
// than silently dropping every capture, since outcomes are never inferred.
export function applyCohortFilter(captures, filter, { markers = [], repositoryHashIndex = null } = {}) {
  const f = filter || emptyCohortFilter();
  const lookupSnapshot = snapshotLookup();
  // An outcomes/task_categories filter with no marker data to check against degrades to "no
  // restriction" for that dimension (never inferring an outcome or task category, and never treating
  // "no evidence" as "excluded" either) — see the doc comment above applyCohortFilter.
  const outcomeBySession = f.outcomes.length && markers.length ? outcomeStatusBySession(markers) : null;
  const taskCategoryBySession = f.task_categories.length && markers.length ? taskCategoryStatusBySession(markers) : null;

  return captures.filter((event) => {
    if (f.harnesses.length && !f.harnesses.includes(event.harness)) return false;
    if (f.models.length && !f.models.includes(event.session?.model)) return false;
    if (f.repos.length && !f.repos.includes(event.repo?.label)) return false;
    // Canonical repository scope (composes with the legacy label filter). Resolves each event to a
    // canonical id at read time, preferring the record's own repository_id and falling back to
    // legacy-hash matching against the registry. Unresolved events never match a specific scope.
    if (f.repository_ids.length) {
      const ref = repositoryRefForEvent(event, repositoryHashIndex);
      if (!ref.repositoryId || !f.repository_ids.includes(ref.repositoryId)) return false;
    }
    if (f.operations.length && !f.operations.includes(event.operation?.category)) return false;
    if (f.phases.length && !f.phases.includes(event.phase?.name)) return false;
    if (f.snapshot_ids.length && !f.snapshot_ids.includes(event.config_snapshot_id)) return false;

    if (f.packages.length || f.skills.length) {
      const snapshot = lookupSnapshot(event.config_snapshot_id);
      if (!snapshot) return false;
      if (f.packages.length && !f.packages.every((p) => (snapshot.packages || []).includes(p.id))) return false;
      if (f.skills.length && !f.skills.every((s) => (snapshot.skills || []).includes(s.id))) return false;
    }

    if (outcomeBySession) {
      const status = outcomeBySession.get(event.session_id);
      if (!status || !f.outcomes.includes(status)) return false;
    }

    if (taskCategoryBySession) {
      const category = taskCategoryBySession.get(event.session_id);
      if (!category || !f.task_categories.includes(category)) return false;
    }

    return true;
  });
}

// Last explicit outcome marker per session (later marker wins if a session was corrected/re-marked).
function outcomeStatusBySession(markers) {
  const map = new Map();
  for (const marker of markers) {
    if (marker.type !== "outcome" || !marker.session_id) continue;
    const existing = map.get(marker.session_id);
    if (!existing || marker.ts > existing.ts) map.set(marker.session_id, { status: marker.status, ts: marker.ts });
  }
  return new Map([...map.entries()].map(([sessionId, entry]) => [sessionId, entry.status]));
}

// Task category per session, from each session's outcome marker (task category lives only on
// outcome markers). Last explicit marker wins, mirroring outcomeStatusBySession's
// tie-break rule.
function taskCategoryStatusBySession(markers) {
  const map = new Map();
  for (const marker of markers) {
    if (marker.type !== "outcome" || !marker.session_id || marker.task_category == null) continue;
    const existing = map.get(marker.session_id);
    if (!existing || marker.ts > existing.ts) map.set(marker.session_id, { category: marker.task_category, ts: marker.ts });
  }
  return new Map([...map.entries()].map(([sessionId, entry]) => [sessionId, entry.category]));
}

// task_categories filters against outcome markers, so it is applied at the session level rather than
// per-capture: a session "matches" when its outcome marker's task_category is in the filter list.
// Exported separately (in addition to being wired into applyCohortFilter above) because
// experimentStatus() needs to filter by an experiment's eligibility.task_categories without building
// a full cohort filter object for just that one dimension.
export function filterSessionsByTaskCategory(captures, taskCategories, markers) {
  if (!taskCategories || !taskCategories.length) return captures;
  const bySession = taskCategoryStatusBySession(markers);
  return captures.filter((event) => taskCategories.includes(bySession.get(event.session_id)));
}

// Human-readable one-line cohort summary for the portal's "readable cohort summary" requirement and
// the Analysis explorer's "what was compared" section. Never invents wording beyond the filter's own
// fields; omits every dimension left unrestricted.
export function describeCohortFilter(filter) {
  const f = filter || emptyCohortFilter();
  const parts = [];
  if (f.time?.range_ms) parts.push(`last ${Math.round(f.time.range_ms / 3_600_000)}h`);
  if (f.harnesses.length) parts.push(f.harnesses.join("/"));
  if (f.models.length) parts.push(f.models.join("/"));
  if (f.repos.length) parts.push(f.repos.join("/"));
  if (f.repository_ids.length) parts.push("repos: " + f.repository_ids.join("/"));
  if (f.packages.length) parts.push("packages: " + f.packages.map((p) => p.id).join(","));
  if (f.skills.length) parts.push("skills: " + f.skills.map((s) => s.id).join(","));
  if (f.operations.length) parts.push("ops: " + f.operations.join(","));
  if (f.phases.length) parts.push("phases: " + f.phases.join(","));
  if (f.outcomes.length) parts.push("outcomes: " + f.outcomes.join(","));
  if (f.task_categories.length) parts.push("tasks: " + f.task_categories.join(","));
  return parts.length ? parts.join(" · ") : "all data";
}

export function activeFilterCount(filter) {
  const f = filter || emptyCohortFilter();
  let count = 0;
  if (f.time?.range_ms) count += 1;
  count += f.harnesses.length > 0 ? 1 : 0;
  count += f.models.length > 0 ? 1 : 0;
  count += f.repos.length > 0 ? 1 : 0;
  count += f.repository_ids.length > 0 ? 1 : 0;
  count += f.packages.length > 0 ? 1 : 0;
  count += f.skills.length > 0 ? 1 : 0;
  count += f.operations.length > 0 ? 1 : 0;
  count += f.phases.length > 0 ? 1 : 0;
  count += f.outcomes.length > 0 ? 1 : 0;
  count += f.task_categories.length > 0 ? 1 : 0;
  count += f.snapshot_ids.length > 0 ? 1 : 0;
  return count;
}
