import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const modules = ["observations", "findings", "cohorts", "regression", "run"];
const allowed = new Set(modules.map((name) => `./telemetry-oracle-${name}.mjs`));

// An allowlist also rejects indirect coupling through a new non-oracle utility.
function assertIndependentImports(source, name) {
  source = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.doesNotMatch(source, /\b(?:import\s*\(|require\s*\()/, `${name}: core imports must be static ESM`);
  for (const match of source.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)) {
    assert.ok(match[1].startsWith("node:") || allowed.has(match[1]), `${name}: forbidden oracle import ${match[1]}`);
  }
}

for (const source of [
  'import { normalizeObservations } from "./telemetry-observations.mjs";',
  'export { x } from "./telemetry-conditions.mjs";',
  'import "../../portal/tokens/conditions-format.js";',
  'import { x } from "./telemetry-oracle-compare.mjs";',
  'import { x } from "./shared-analysis.mjs";',
  'import { x } from /* explanation */ "./telemetry-metrics.mjs";',
  'const helper = await import("./telemetry-analyze.mjs");',
]) assert.throws(() => assertIndependentImports(source, "negative fixture"), /oracle import|static ESM/);

for (const name of modules) {
  const url = new URL(`../cli/telemetry-oracle-${name}.mjs`, import.meta.url);
  assertIndependentImports(fs.readFileSync(url, "utf8"), name);
}
for (const path of ["./telemetry-oracle-check.mjs", "../cli/telemetry-oracle-compare.mjs"]) {
  const comparator = fs.readFileSync(new URL(path, import.meta.url), "utf8");
  assert.doesNotMatch(comparator, /conditions-format|comparisonPresentation|changePresentation/,
    "Comparators check analytics directly; presentation has its own focused checks");
}

// Importing the runtime core must neither run fixtures nor print synthetic replay material.
const runUrl = new URL("../cli/telemetry-oracle-run.mjs", import.meta.url).href;
const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(runUrl)})`], { encoding: "utf8" });
assert.equal(imported.status, 0, imported.stderr);
assert.equal(imported.stdout, "");
assert.equal(imported.stderr, "");

const { runTelemetryOracle } = await import(runUrl);
const { conditionRows, changeRows } = await import("../cli/telemetry-oracle-cohorts.mjs");
const { sessionKey } = await import("../cli/telemetry-oracle-observations.mjs");
const row = { schema: 3, capture_id: "post", call_id: "call", harness: "claude", session_id: "shared",
  event: "PostToolUse", ts: "2026-09-15T12:00:00.000Z", session: { model: "model" },
  repo: { repository_id: "git:example/repo" }, tool: { name: "Read" },
  tokens: { input: 100, output: 10, total: 110 } };
const events = [row, { ...row }, { ...row, capture_id: "pre", event: "PreToolUse" },
  { ...row, harness: "codex", tokens: null }];
const original = JSON.stringify(events);
const result = runTelemetryOracle(events);
assert.equal(result.session_count, 2, "providers can reuse session ids");
assert.equal(result.operation_count, 2, "exact copies and mirrored calls collapse");
assert.equal(result.token_session_count, 1);
assert.equal(result.token_operation_count, 1);
assert.equal(JSON.stringify(events), original, "the oracle preserves its caller's evidence");
assert.deepEqual(runTelemetryOracle([...events].reverse()), result, "input order does not change covered results");
assert.equal(runTelemetryOracle([]).session_count, 0);

// The written policy is tested directly, with no production presentation helper on either side.
function policyCase({ count = 10, before = 5, after = 5, unknown = false } = {}) {
  const sessions = [], affected = new Set();
  for (const side of ["before", "after"]) for (let index = 0; index < count; index++) {
    const session = { harness: "claude", session_id: `${side}-${index}`, model: side,
      first_seen: side === "before" ? "2026-09-14T00:00:00.000Z" : "2026-09-16T00:00:00.000Z", rows: [] };
    session.last_seen = session.first_seen;
    sessions.push(session);
    if (index < (side === "before" ? before : after)) affected.add(sessionKey(session));
  }
  if (unknown) sessions.push({ harness: "claude", session_id: "unknown", model: null, rows: [] });
  const kinds = new Map([["spike", affected]]);
  const condition = conditionRows(sessions, [], kinds).find((item) => item.dimension === "model" && item.value === "after");
  const changes = changeRows(sessions, [], [{ schema: 2, marker_id: "boundary", type: "change", scope: "all",
    ts: "2026-09-15T00:00:00.000Z", watching_kinds: ["spike"] }], kinds);
  return { condition, change: changes[0].comparisons[0] };
}

for (const [options, conditionState, changeState] of [
  [{}, "neutral", "neutral"],
  [{ count: 20, before: 10, after: 11 }, "neutral", "neutral"],
  [{ before: 5, after: 7 }, "more", "more"],
  [{ before: 5, after: 3 }, "fewer", "fewer"],
  [{ count: 9 }, "thin", "collecting"],
  [{ before: 2, after: 5 }, "thin", "collecting"],
  [{ before: 0, after: 5 }, "thin", "collecting"],
]) {
  const { condition, change } = policyCase(options);
  assert.equal(condition.presentation_state, conditionState);
  assert.equal(change.presentation_state, changeState);
  if (conditionState === "thin") assert.equal(condition.relative_delta, null);
}
const unknown = policyCase({ unknown: true });
assert.equal(unknown.condition.unknown_condition, 1);
assert.equal(unknown.condition.without_condition, 10, "unknown is not absence");
assert.equal(unknown.change.ambiguous_boundary, 1);
console.log("telemetry oracle core checks passed");
