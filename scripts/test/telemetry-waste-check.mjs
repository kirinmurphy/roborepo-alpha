// Identifiable-waste ledger: every turn is counted once, under the source that nominates the most
// tokens, so category totals add up exactly to the headline total (no overlapping upper bound).
import assert from "node:assert/strict";
import { createWasteLedger } from "../cli/telemetry-waste.mjs";
import { analyzeTelemetry } from "../cli/telemetry-analyze.mjs";

// Ledger: the largest nomination wins; ties go to the earlier-listed category; zero/negative ignored.
{
  const ledger = createWasteLedger();
  const turn = { ts: "2026-06-10T00:00:00.000Z" };
  ledger.add(turn, "spikes", 600);
  ledger.add(turn, "loops", 1000);
  ledger.add(turn, "testing", 1000);
  const tie = { ts: "2026-06-10T00:00:01.000Z" };
  ledger.add(tie, "testing", 50);
  ledger.add(tie, "reads", 50);
  ledger.add({ ts: "2026-06-10T00:00:02.000Z" }, "reads", 0);
  ledger.add({ ts: "2026-06-10T00:00:03.000Z" }, "reads", -5);
  const { all } = ledger.summarize("2026-06-10T00:00:03.000Z");
  assert.deepEqual(all.categories, { loops: 1000, reads: 50, spikes: 0, testing: 0 });
  assert.equal(all.total, 1050);
}

// Week window: trailing 7 days ending at the latest timestamp, inclusive of the cutoff.
{
  const ledger = createWasteLedger();
  ledger.add({ ts: "2026-06-01T00:00:00.000Z" }, "spikes", 100);
  ledger.add({ ts: "2026-06-08T00:00:00.000Z" }, "spikes", 40);
  ledger.add({ ts: "2026-06-15T00:00:00.000Z" }, "loops", 10);
  const { all, week } = ledger.summarize("2026-06-15T00:00:00.000Z");
  assert.equal(all.total, 150);
  assert.equal(week.total, 50);
  assert.deepEqual(week.categories, { loops: 10, reads: 0, spikes: 40, testing: 0 });
}

// End to end: a runaway loop whose repeat turns are also spikes is counted once, as a loop.
{
  const base = Date.parse("2026-06-10T00:00:00.000Z");
  let n = 0;
  const event = (session, tool, delta, extra = {}) => ({
    schema: 3, harness: "claude", event: "PostToolUse", session_id: session, ts: new Date(base + (n++) * 60000).toISOString(),
    repo: { label: "demo" }, tool: { name: tool, is_mcp: false }, delta_tokens: delta,
    tokens: { input: delta, output: 0, cache_creation: 0, cache_read: 0, total: delta }, ...extra,
  });
  const events = [];
  for (let i = 0; i < 400; i++) events.push(event(`quiet-${i}`, "Edit", 1000));
  const loopDeltas = Array.from({ length: 10 }, () => 300_000);
  for (const delta of loopDeltas) events.push(event("runaway", "Grep", delta));
  const report = analyzeTelemetry(events, {});
  const repeats = loopDeltas.slice(1).reduce((sum, value) => sum + value, 0);
  assert.ok(report.loops.length === 1 && report.loops[0].wasted_tokens === repeats, "loop detected");
  assert.ok(report.spike_threshold > 0 && report.spike_threshold < 300_000, "loop turns are spikes too");
  const { all } = report.waste;
  assert.equal(all.categories.loops, repeats);
  // The only spike turn outside the loop's repeats is the first call; its excess counts as a spike.
  assert.equal(all.categories.spikes, 300_000 - report.spike_threshold);
  assert.equal(all.total, Object.values(all.categories).reduce((sum, value) => sum + value, 0));
  const totalTokens = report.timeline.reduce((sum, point) => sum + point.delta, 0);
  assert.ok(all.total <= totalTokens, "waste never exceeds total usage");
}
// Over-testing is only full-suite reruns with no edit since the previous test run.
{
  const base = Date.parse("2026-06-10T00:00:00.000Z");
  let n = 0;
  const event = (session, delta, extra = {}) => ({
    schema: 3, harness: "claude", event: "PostToolUse", session_id: session, ts: new Date(base + (n++) * 60000).toISOString(),
    repo: { label: "demo" }, tool: { name: "Bash", is_mcp: false }, delta_tokens: delta,
    tokens: { input: delta, output: 0, cache_creation: 0, cache_read: 0, total: delta }, ...extra,
  });
  const test = (scope, edited) => ({ operation: { category: "test", scope }, intervening: { edit_since_last_test: edited } });
  const events = [];
  for (let i = 0; i < 400; i++) events.push(event(`quiet-${i}`, 1000));
  events.push(event("tests", 2000, test("full", false)));   // redundant rerun: counts
  events.push(event("tests", 2000, test("full", true)));    // edit happened first: not waste
  events.push(event("tests", 2000, test("targeted", false))); // targeted run: not waste
  const { all } = analyzeTelemetry(events, {}).waste;
  assert.equal(all.categories.testing, 2000);
}
console.log("ok: telemetry waste ledger");
