import fs from "node:fs";
import { marker, regressionTieCase, seededCase } from "./fixtures/telemetry-oracle-cases.mjs";
import { analyzeTelemetry } from "../cli/telemetry-analyze.mjs";
import { conditionDemoEvidence } from "../cli/telemetry-conditions-demo.mjs";
import { runTelemetryOracle } from "../cli/telemetry-oracle-run.mjs";
import { acceptedRows, stableJson } from "../cli/telemetry-oracle-observations.mjs";
import { comparisonEntries } from "../cli/telemetry-oracle-compare.mjs";

// The comparator knows both implementations; independent calculation stays in the oracle core.
// Display-band states belong to that core's policy checks, not the production UI formatters.
function equal(label, actual, expected) {
  if (stableJson(actual) !== stableJson(expected)) throw new Error(`${label} disagreed\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
}

function verify(events, options = {}) {
  const expected = runTelemetryOracle(events, options), report = analyzeTelemetry(events, options);
  for (const { field, actual, expected: value } of comparisonEntries(report, expected)) equal(field, actual, value);
  return expected;
}

function stillFails(testCase) {
  try { verify(testCase.events, testCase); return false; } catch { return true; }
}

function shrink(testCase) {
  const reduced = { ...testCase, events: [...testCase.events] };
  let changed = true;
  while (changed && reduced.events.length > 1) {
    changed = false;
    for (let index = 0; index < reduced.events.length; index++) {
      const candidate = { ...reduced, events: reduced.events.filter((_, item) => item !== index) };
      if (stillFails(candidate)) { reduced.events = candidate.events; changed = true; break; }
    }
  }
  return reduced;
}

function runCase(name, testCase) {
  try {
    const result = verify(testCase.events, testCase);
    return { name, events: testCase.events.length, condition_rows: result.conditions.length,
      marker_comparisons: result.changes.reduce((count, change) => count + change.comparisons.length, 0),
      regression_groups: result.regression.groups.length };
  }
  catch (error) {
    const minimal = shrink(testCase);
    console.error(`telemetry oracle failure: ${name}`);
    console.error(`seed: ${testCase.seed ?? "fixed"}`);
    console.error(`snapshots: ${JSON.stringify(minimal.snapshots)}`);
    console.error(`markers: ${JSON.stringify(minimal.markers)}`);
    console.error("events (JSONL):");
    for (const event of minimal.events) console.error(JSON.stringify(event));
    throw error;
  }
}

function requireCoverage(ok, message) {
  if (!ok) throw new Error(`oracle fixture lost required coverage: ${message}`);
}

function appendJobSummary(body) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, `## Telemetry analytics oracle\n\n${body}\n`, "utf8");
}

function main() {
  const records = fs.readFileSync(new URL("../../portal/tokens/mock-spool.jsonl", import.meta.url), "utf8").trim().split("\n").map(JSON.parse);
  const demo = conditionDemoEvidence(records);
  const demoCase = { ...demo, markers: [marker("demo-boundary", "2026-06-12T00:00:00.000Z")] };
  const demoStates = new Set(runTelemetryOracle(demoCase.events, demoCase).conditions.map((row) => row.presentation_state));
  requireCoverage(["thin", "fewer", "more"].every((state) => demoStates.has(state)), "demo thin/fewer/more condition outcomes");
  const summaries = [runCase("bundled demo", demoCase)];

  const tiedRegression = regressionTieCase();
  summaries.push(runCase("regression pin: equal timestamps stay together", tiedRegression));
  const tiedResult = runTelemetryOracle(tiedRegression.events, tiedRegression).regression;
  requireCoverage(tiedResult.split_ts === "2026-09-16T04:00:00.000Z"
    && tiedResult.groups.reduce((count, row) => count + row.before_calls, 0) === 3,
  "equal-timestamp midpoint uses the nearest distinct boundary");
  const noTemporalOrder = regressionTieCase({ allSameTime: true });
  summaries.push(runCase("regression pin: all timestamps equal is unavailable", noTemporalOrder));
  requireCoverage(runTelemetryOracle(noTemporalOrder.events, noTemporalOrder).regression.split_ts == null,
    "all-equal timestamps make regression unavailable");

  const seeds = [0x00c0ffee, 0x12345678, 0x5eed5eed, 0x9e3779b9, 0xdecafbad, 0xf00dcafe];
  for (const seed of seeds) {
    const testCase = { ...seededCase(seed), seed }, expected = runTelemetryOracle(testCase.events, testCase);
    const harnessesById = new Map();
    for (const event of testCase.events) {
      if (!harnessesById.has(event.session_id)) harnessesById.set(event.session_id, new Set());
      harnessesById.get(event.session_id).add(event.harness);
    }
    requireCoverage([...harnessesById.values()].some((harnesses) => harnesses.size > 1), `seed ${seed} shared ids across harnesses`);
    requireCoverage(testCase.events.some((event) => event.tokens == null) && testCase.events.some((event) => event.session?.model == null), `seed ${seed} null tokens/models`);
    requireCoverage(expected.operation_count < acceptedRows(testCase.events).length, `seed ${seed} mirrored operation deduplication`);
    requireCoverage(expected.session_count > expected.token_session_count, `seed ${seed} tokenless session subset`);
    requireCoverage(expected.affected_session_counts.loop === 1, `seed ${seed} one within-harness loop without cross-harness fabrication`);
    requireCoverage(expected.conditions.some((row) => row.unknown_condition > 0), `seed ${seed} unknown condition cohort`);
    requireCoverage(expected.conditions.some((row) => row.presentation_state === "neutral") && expected.conditions.some((row) => row.presentation_state === "thin"), `seed ${seed} 20% band and evidence-floor gating`);
    requireCoverage(expected.changes.some((change) => change.comparisons.some((row) => row.spanning_boundary > 0 && row.ambiguous_boundary > 0)), `seed ${seed} spanning and touching boundary exclusions`);
    requireCoverage(expected.regression.groups.length > 0, `seed ${seed} per-call regression`);
    summaries.push(runCase(`seed ${seed}`, testCase));
  }

  const total = (field) => summaries.reduce((sum, row) => sum + row[field], 0);
  const totals = { cases: summaries.length, events: total("events"), conditions: total("condition_rows"),
    markers: total("marker_comparisons"), regressions: total("regression_groups") };
  console.log("telemetry oracle: PASS");
  console.log(`  cases: ${totals.cases} (1 bundled demo, 2 fixed regressions, ${seeds.length} seeded spools)`);
  console.log(`  evidence: ${totals.events} raw events · ${totals.conditions} condition rows · ${totals.markers} marker comparisons · ${totals.regressions} regression groups`);
  console.log(`  seeds: ${seeds.join(", ")}`);
  console.log("  exact checks: harness-scoped sessions, token coverage, operation deduplication, condition cohorts, boundary exclusions, evidence gating, per-call regression, loop isolation");
  console.log("  failure evidence: seed, production/oracle disagreement, snapshots, markers, and minimized replayable JSONL");
  appendJobSummary(`✅ Passed\n\n${totals.cases} cases · ${totals.events} raw events · ${totals.conditions} condition rows · ${totals.markers} marker comparisons · ${totals.regressions} regression groups`);
}

try {
  main();
} catch (error) {
  appendJobSummary("❌ Failed\n\nSee the detailed log for the seed, disagreement, fixture metadata, and minimized replayable JSONL.");
  throw error;
}
