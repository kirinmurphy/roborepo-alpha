import assert from "node:assert/strict";
import { aggregateCondition, evaluateCondition, normalizeObservations, normalizeTokenUsage } from "../cli/telemetry-observations.mjs";
import { splitObservationBoundary } from "../cli/telemetry-boundaries.mjs";
import { documentationScenario } from "./fixtures/telemetry-conditions-documentation.mjs";

let scenarios = 0;
const permutations = (items) => items.length < 2 ? [items] : items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]));
const states = [
  { model: "selected", affected: false, expected: [1, 0, 0, 0, 0] },
  { model: "selected", affected: true, expected: [1, 0, 0, 1, 0] },
  { model: "other", affected: false, expected: [0, 1, 0, 0, 0] },
  { model: "other", affected: true, expected: [0, 1, 0, 0, 1] },
  { model: null, affected: false, expected: [0, 0, 1, 0, 0] },
  { model: null, affected: true, expected: [0, 0, 1, 0, 0] },
];
// Exhaustive bounded truth table: 6^3 condition/event states, every ordering, with
// and without duplicated observations. Expected contributions are specified above.
for (const a of states) for (const b of states) for (const c of states) {
  const selected = [a, b, c];
  const totals = selected.reduce((sum, state) => sum.map((value, i) => value + state.expected[i]), [0, 0, 0, 0, 0]);
  const [present, absent, unknown, withAffected, withoutAffected] = totals;
  const rows = selected.map((state, index) => ({ id: String(index), observation_unit: "session", model: state.model }));
  const affected = new Set(selected.flatMap((state, index) => state.affected ? [String(index)] : []));
  for (const ordered of permutations(rows)) for (const duplicates of [false, true]) {
    const result = aggregateCondition(duplicates ? [...ordered, ...ordered] : ordered, { dimension: "model", value: "selected" }, affected);
    assert.deepEqual([result.with_condition, result.without_condition, result.unknown_condition, result.with_affected, result.without_affected], totals);
    assert.equal(result.total_observations, 3);
    assert.equal(result.coverage, (3 - unknown) / 3);
    assert.equal(result.with_rate, present ? withAffected / present : null);
    assert.equal(result.without_rate, absent ? withoutAffected / absent : null);
    assert.equal(result.comparison_available, present > 0 && absent > 0);
    assert.equal(result.relative_delta, null, "small cohorts must never display a percent deviation");
    scenarios++;
  }
}

const goldenRates = [
  // with N, without N, with affected, without affected, expected relative delta
  [12, 12, 3, 9, -2 / 3], [12, 12, 9, 3, 2], [12, 12, 3, 3, 0],
  [9, 12, 3, 3, null], [10, 10, 3, 3, 0], [12, 12, 2, 3, null],
  [12, 12, 3, 2, null], [12, 12, 3, 0, null], [0, 12, 0, 3, null], [12, 0, 3, 0, null],
];
for (const [withN, withoutN, withAffected, withoutAffected, expected] of goldenRates) {
  const rows = Array.from({ length: withN + withoutN }, (_, index) => ({ id: String(index), observation_unit: "session", model: index < withN ? "selected" : "other" }));
  const affected = new Set(rows.filter((_, i) => i < withAffected || (i >= withN && i < withN + withoutAffected)).map((row) => row.id));
  assert.equal(aggregateCondition(rows, { dimension: "model", value: "selected" }, affected).relative_delta, expected);
  scenarios++;
}

for (const dimension of ["packages", "skills"]) {
  for (const [payload, expected] of [
    [{ [dimension]: ["target"] }, "present"], [{ [dimension]: [] }, "absent"],
    [{}, "unknown"], [{ [dimension]: ["target"], unavailable: [dimension] }, "unknown"],
  ]) {
    const snapshot = { schema: 2, snapshot_id: "snapshot", evaluability: { [dimension]: true }, ...payload };
    const observation = { rows: [{ config_snapshot_id: "snapshot" }] };
    assert.equal(evaluateCondition(observation, { dimension, value: "target" }, [snapshot]).state, expected);
    assert.equal(evaluateCondition(observation, { dimension, value: "target" }, []).state, "unknown");
    assert.equal(evaluateCondition(observation, { dimension, value: "target" }, [{ ...snapshot, evaluability: { [dimension]: false } }]).state, "unknown");
    scenarios++;
  }
}

const usage = { input: 100, output: 20, cache_creation: 10, cache_read: 30, total: 160 };
for (const field of Object.keys(usage)) for (const value of [-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "10", null]) {
  assert.equal(normalizeTokenUsage({ ...usage, [field]: value }), null, `${field}=${value}`);
  scenarios++;
}
const capture = (id, tokens) => ({ schema: 3, harness: "claude", session_id: id, capture_id: id, call_id: id, ts: "2026-09-01T00:00:00Z", session: { model: "model" }, tokens });
for (const a of [usage, null, { ...usage, input: -1 }]) for (const b of [usage, null, { ...usage, input: -1 }]) for (const c of [usage, null, { ...usage, input: -1 }]) {
  const payloads = [a, b, c];
  const valid = payloads.filter((payload) => payload === usage).length;
  for (const ordered of permutations(payloads.map((payload, index) => capture(String(index), payload)))) {
    const sessions = normalizeObservations(ordered).sessions;
    assert.equal(sessions.length, 3);
    const withTokens = sessions.filter((session) => session.tokens);
    assert.equal(withTokens.length, valid);
    assert.ok(withTokens.every((session) => session.tokens.total === 160));
    scenarios++;
  }
}
const flowRows = [capture("same", usage), { ...capture("same", usage), capture_id: "mirror" }, capture("other", null), { ...capture("same", usage), harness: "codex" }];
for (const ordered of permutations(flowRows)) {
  const result = normalizeObservations(ordered);
  assert.equal(result.flows.length, 3); assert.equal(result.sessions.length, 3);
  assert.equal(result.sessions.filter((row) => row.tokens).length, 2);
  scenarios++;
}

const boundary = "2026-09-02T00:00:00Z";
const times = ["2026-09-01T00:00:00Z", boundary, "2026-09-03T00:00:00Z"];
for (const [first, last, expected] of [[0, 0, "before"], [0, 1, "ambiguous"], [0, 2, "spanning"], [1, 1, "ambiguous"], [1, 2, "ambiguous"], [2, 2, "after"]]) {
  const result = splitObservationBoundary([{ id: "session", first_seen: times[first], last_seen: times[last], rows: [] }], { ts: boundary });
  assert.deepEqual(Object.fromEntries(Object.entries(result).map(([key, rows]) => [key, rows.length])), { before: Number(expected === "before"), after: Number(expected === "after"), spanning: Number(expected === "spanning"), ambiguous: Number(expected === "ambiguous") });
  scenarios++;
}
for (const [domain, sequence, expected] of [["shared", 4, "before"], ["shared", 5, "ambiguous"], ["shared", 6, "after"], ["other", 4, "ambiguous"]]) {
  const result = splitObservationBoundary([{ first_seen: boundary, last_seen: boundary, rows: [{ sequence_domain: domain, sequence }] }], { ts: boundary, sequence_domain: "shared", sequence: 5 });
  assert.equal(result[expected].length, 1); scenarios++;
}

const { report } = documentationScenario();
const comparison = report.conditions.comparisons.find((row) => row.dimension === "packages" && row.event_kind === "read-warning");
assert.deepEqual([comparison.with_condition, comparison.without_condition, comparison.unknown_condition, comparison.with_affected, comparison.without_affected], [12, 12, 2, 3, 9]);
assert.equal(comparison.with_rate, 0.25); assert.equal(comparison.without_rate, 0.75);
assert.equal(comparison.relative_delta, -2 / 3); scenarios++;
console.log(`telemetry conditions matrix: ${scenarios} deterministic scenarios passed (bounded exhaustive combinations, all small-input orderings, fixed golden outputs)`);
