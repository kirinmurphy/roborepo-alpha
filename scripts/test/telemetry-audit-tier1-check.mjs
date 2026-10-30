import assert from "node:assert/strict";
import { buildConditionsReport } from "../cli/telemetry-conditions.mjs";
import { assertSupersedable } from "../cli/telemetry-markers.mjs";
import { compareAcrossMarker } from "../cli/telemetry-compare.mjs";

const token = { input: 100, output: 10, total: 110 };
const event = (id) => ({ schema: 3, capture_id: `cap-${id}`, call_id: `call-${id}`, harness: "claude", session_id: `s${id}`, session: { model: "m" },
  event: "PostToolUse", ts: `2026-09-01T00:00:0${id}Z`, tokens: token, tool: { name: "Read" } });
const events = [event(1), event(2)];
const marker = (id, extra = {}) => ({ schema: 2, marker_id: id, type: "change", ts: "2026-09-01T00:00:00Z", effective_at: "2026-09-01T00:00:00Z",
  scope: "all", repository_id: null, watching_kinds: [], ...extra });

// Finding 13: findings whose session cannot be resolved are counted, not silently dropped.
const ghost = { harness: "claude", session_id: "ghost", ts: "2026-09-01T00:00:09Z" };
const lost = buildConditionsReport(events, { spikes: [ghost], loops: [ghost], read_warnings: [] });
assert.equal(lost.data_quality.findings_lost_to_fallback, 2);

// Finding 4: equal-timestamp markers order by persisted (append) order, newest first, not by id.
const later = buildConditionsReport(events, { spikes: [], loops: [], read_warnings: [] }, { markers: [marker("mark_aaa"), marker("mark_zzz")] });
assert.deepEqual(later.ledger.filter((row) => row.kind === "manual-change").map((row) => row.id), ["mark_zzz", "mark_aaa"]);

// Finding 6: a supersede must name an existing, unsuperseded change marker.
const existing = [marker("mark_a"), { ...marker("mark_o"), type: "outcome" }, marker("mark_b", { supersedes: "mark_a" })];
assert.throws(() => assertSupersedable("mark_missing", existing), /unknown marker/);
assert.throws(() => assertSupersedable("mark_o", existing), /only change markers/);
assert.throws(() => assertSupersedable("mark_a", existing), /already superseded/);
assert.doesNotThrow(() => assertSupersedable("mark_b", existing));

// Finding 5: an unknown-scope marker is an unfair comparison, not a data-volume shortfall.
const unfair = compareAcrossMarker(events, marker("mark_u", { scope: "unknown" }), "tokens.total");
assert.equal(unfair.confidence, "can't compare fairly");
assert.ok(unfair.data_quality_issues.every((issue) => !/below the minimum/.test(issue)));
console.log("telemetry audit tier 1: ledger order, supersede validation, fairness wording and dropped-finding counter passed");

// Finding 8: a marker splits an at-boundary session on effective_at, excluding the session that
// touches the boundary.
import { splitCohortsByMarker } from "../cli/telemetry-compare.mjs";
const boundary = "2026-09-01T12:00:00.000Z";
const at = (id, ts) => ({ ...event(1), session_id: id, capture_id: `c-${id}-${ts}`, call_id: `k-${id}-${ts}`, ts });
const boundaryEvents = [at("early", "2026-09-01T11:00:00.000Z"), at("exact", boundary), at("late", "2026-09-01T13:00:00.000Z")];
const shape = (split) => ({ before: split.before.map((row) => row.session_id), after: split.after.map((row) => row.session_id), excluded: split.excluded.map((row) => row.session_id) });
const boundarySplit = shape(splitCohortsByMarker(boundaryEvents, { schema: 2, ts: boundary, effective_at: boundary, scope: "all", type: "change" }));
assert.deepEqual(boundarySplit.excluded, ["exact"]);
assert.deepEqual(boundarySplit.before, ["early"]);
// Markers honor effective_at, not the creation timestamp.
const backdated = shape(splitCohortsByMarker(boundaryEvents, { schema: 2, ts: "2026-09-02T00:00:00.000Z", effective_at: boundary, scope: "all", type: "change" }));
assert.deepEqual(backdated, boundarySplit);
console.log("telemetry audit tier 1: boundary splits honor effective_at");

// Finding 15: change comparisons report sessions left out for unknown condition data.
import { compareObservationBoundary } from "../cli/telemetry-boundaries.mjs";
import { changePresentation } from "../../portal/tokens/conditions-format.js";
import { normalizeObservations } from "../cli/telemetry-observations.mjs";
const conditionEvents = [1, 2].map((id) => ({ ...event(id), config_snapshot_id: null }));
const compared = compareObservationBoundary(normalizeObservations(conditionEvents).sessions, marker("mark_c"), new Set(),
  { condition: { dimension: "packages", value: "p", label: "configured" }, snapshots: new Map() });
assert.equal(compared.unknown_condition, 2);
assert.match(changePresentation({ event_kind: "spike", ...compared }).detail, /2 unknown condition/);
console.log("telemetry audit tier 1: change comparisons disclose unknown-condition sessions");
