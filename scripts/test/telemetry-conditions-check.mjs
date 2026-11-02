import assert from "node:assert/strict";
import { analyzeTelemetry } from "../cli/telemetry-analyze.mjs";
const token = { input: 100, output: 10, total: 110 };
const event = (id, extra = {}) => ({ schema: 3, capture_id: `cap-${id}`, call_id: `call-${id}`, harness: "claude", session_id: `session-${id}`, session: { model: "m" }, event: "PostToolUse", ts: `2026-09-01T00:00:${String(id).padStart(2, "0")}Z`, tokens: token, delta_tokens: 100000, tool: { name: "Read", file_ext: ".md" }, last_result: { chars: 30000, tool: "Read" }, ...extra });
const events = [event(1), event(2, { tokens: null }), event(3, { config_snapshot_id: "cfg" })];
const report = analyzeTelemetry(events, {});
assert.deepEqual(report.conditions, analyzeTelemetry([...events].reverse(), {}).conditions);
const duplicates = analyzeTelemetry([...events, { ...events[0], capture_id: "mirror" }], {});
assert.equal(duplicates.conditions.data_quality.sessions, 3);
assert.deepEqual(duplicates.conditions.comparisons, report.conditions.comparisons);
const snapshot = { schema: 2, snapshot_id: "cfg", packages: ["p"], skills: [], evaluability: { packages: true, skills: true } };
const joined = analyzeTelemetry(events, { snapshots: [snapshot] });
assert.notEqual(joined.version, report.version);
assert.equal(joined.conditions.comparisons.find((row) => row.dimension === "packages").unknown_condition, 2);
const unavailable = analyzeTelemetry(events, { cohortFilter: { models: ["m"] } });
assert.equal(unavailable.conditions.comparisons.find((row) => row.dimension === "model").comparison_available, false);
// One pipeline: the same session id under two harnesses stays two sessions, and loops never cross harnesses.
const collide = (harness, id) => event(id, { harness, session_id: "shared", call_id: `${harness}-${id}`, capture_id: `${harness}-${id}`, tool: { name: "Read" } });
const collision = analyzeTelemetry([collide("claude", 1), collide("codex", 2)]);
assert.equal(collision.sessions.length, 2);
assert.deepEqual(collision.sessions.map((session) => session.harness).sort(), ["claude", "codex"]);
const split = Array.from({ length: 8 }, (_, index) => collide(index % 2 ? "codex" : "claude", index + 10));
assert.equal(analyzeTelemetry(split).loops.length, 0, "alternating harnesses must not fabricate a loop");
// Null-token sessions stay visible in the canonical session count even though token tables skip them.
const tokenless = analyzeTelemetry([event(1), event(2, { tokens: null })]);
assert.equal(tokenless.conditions.data_quality.sessions, 2);
console.log("telemetry conditions: single pipeline, harness-keyed sessions, duplicate flows, filtered baselines, snapshot refresh, real report coverage passed");
