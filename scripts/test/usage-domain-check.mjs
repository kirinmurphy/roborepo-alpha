#!/usr/bin/env node
// Pure-layer tests for usage-statusline: adapters, domain calculations, renderer fragments, the
// snapshot store, the portal API view, and the shared conformance fixtures. No harness or CLI
// process spawning — that lives in usage-statusline-check.mjs. Uses a temp ROBOREPO_STATE_ROOT for
// the snapshot-store cases so nothing touches real ~/.roborepo state.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-usage-domain-"));
process.env.ROBOREPO_STATE_ROOT = stateDir;

const pkg = path.join(repoRoot, "globals/packages/usage-statusline/scripts");
const { adaptClaudeStatusPayload, adaptCodexRateLimitSnapshot } = await import(`${pkg}/usage-adapters.mjs`);
const { assessBalance, assessUsage, rateLimitSeverity, usageSeverity, elapsedPercent } = await import(`${pkg}/usage-domain.mjs`);
const { renderStatusLine } = await import(`${pkg}/usage-render.mjs`);
const { writeLatestSnapshot, readLatestSnapshot } = await import(`${pkg}/usage-snapshot-store.mjs`);
const portalUsage = await import(`${repoRoot}/scripts/cli/portal-usage.mjs`);
const fixtures = JSON.parse(fs.readFileSync(path.join(repoRoot, "globals/packages/usage-statusline/fixtures/usage-cases.json"), "utf8"));

const ESC = String.fromCharCode(27);
const stripAnsi = (value) => value.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const now = Date.parse("2026-07-21T20:00:00.000Z");
// resetsAt that yields a given elapsed% for a window duration: elapsed = 100*(1 - remaining/dur).
const resetForElapsed = (elapsed, durationMinutes) =>
  new Date(now + (1 - elapsed / 100) * durationMinutes * 60000).toISOString();

// --- adapters ---------------------------------------------------------------
{
  const snap = adaptClaudeStatusPayload({
    context_window: { used_percentage: 42 },
    rate_limits: {
      five_hour: { used_percentage: 18, resets_at: resetForElapsed(50, 300) },
      seven_day: { used_percentage: 70 },
    },
  }, { now });
  assert.equal(snap.harness, "claude");
  assert.equal(snap.schema, 1);
  assert.equal(snap.context.usedPercent, 42);
  assert.equal(snap.windows.fiveHour.durationMinutes, 300, "named five-hour window gets documented duration");
  assert.equal(snap.windows.weekly.durationMinutes, 10080, "named weekly window gets documented duration");
  assert.equal(snap.windows.weekly.resetsAt, undefined, "absent reset stays absent");
  assert.ok(snap.source.available.includes("context.usedPercent"), "source lists available paths");
  assert.ok(!JSON.stringify(snap).includes("used_percentage"), "raw payload keys are not carried through");
}
{
  const source = { context_window: { used_percentage: 42 } };
  const clone = structuredClone(source);
  adaptClaudeStatusPayload(source, { now });
  assert.deepEqual(source, clone, "adapter does not mutate the source payload");
}
{
  const empty = adaptClaudeStatusPayload({}, { now });
  assert.equal(empty.context, undefined, "absent context stays absent, not null/0");
  assert.equal(empty.windows, undefined, "no windows key when all windows absent");
}
{
  // Codex windows in either order, selected by duration, not position.
  const snap = adaptCodexRateLimitSnapshot({
    windows: [
      { window_duration_mins: 10080, used_percent: 70, resets_at: resetForElapsed(60, 10080) },
      { window_duration_mins: 300, used_percent: 18 },
      { window_duration_mins: 43200, used_percent: 5 },
    ],
  }, { now, contextUsedPercent: 33 });
  assert.equal(snap.harness, "codex");
  assert.equal(snap.windows.weekly.usedPercent, 70, "weekly picked by 10080-min duration regardless of order");
  assert.equal(snap.windows.fiveHour.usedPercent, 18, "five-hour picked by 300-min duration");
  assert.equal(snap.context.usedPercent, 33);
  assert.ok(!("monthly" in snap.windows), "unknown 43200-min window is not mislabeled weekly");
}

// --- invalid / edge inputs --------------------------------------------------
{
  const snap = adaptClaudeStatusPayload({
    context_window: { used_percentage: "not-a-number" },
    rate_limits: { five_hour: { used_percentage: NaN }, seven_day: { used_percentage: Infinity } },
  }, { now });
  assert.equal(snap.context, undefined, "non-numeric context dropped");
  assert.equal(snap.windows, undefined, "NaN/Infinity used values dropped");
}
{
  const assessed = assessUsage(adaptClaudeStatusPayload({
    context_window: { used_percentage: 42.4 },
    rate_limits: { five_hour: { used_percentage: -5 }, seven_day: { used_percentage: 101 } },
  }, { now }), { now });
  assert.equal(assessed.context.usedPercent, 42, "decimals rounded for display");
  assert.equal(assessed.windows.fiveHour.usedPercent, 0, "negative clamped to 0");
  assert.equal(assessed.windows.weekly.usedPercent, 100, "over-100 clamped to 100");
}
{
  const bad = elapsedPercent({ resetsAt: Date.parse("nope"), durationMinutes: 300, now });
  assert.equal(bad, null, "invalid reset timestamp yields null elapsed (usage-only fallback)");
  assert.equal(elapsedPercent({ resetsAt: now, durationMinutes: 0, now }), null, "non-positive duration yields null");
}

// --- pacing + usage boundary fixtures (shared with Codex Rust) ---------------
for (const c of fixtures.pacing) {
  const balance = assessBalance({ usedPercent: c.usedPercent, elapsedPercent: c.elapsedPercent });
  assert.equal(balance.state, c.state, `${c.name}: state`);
  if (c.magnitude !== undefined) assert.equal(balance.magnitude, c.magnitude, `${c.name}: magnitude`);
  if (balance.state === "debt") assert.equal(balance.debtSeverity, c.debtSeverity, `${c.name}: debtSeverity`);
  assert.equal(rateLimitSeverity(c.usedPercent), c.usedSeverity, `${c.name}: rateLimitSeverity`);
  // Full weekly text via the renderer, using a reset time that reproduces the fixture's elapsed%.
  const snap = adaptClaudeStatusPayload({
    rate_limits: { seven_day: { used_percentage: c.usedPercent, resets_at: resetForElapsed(c.elapsedPercent, 10080) } },
  }, { now });
  const line = stripAnsi(renderStatusLine(assessUsage(snap, { now }), { color: false }));
  const weekly = line.split(" · ").find((s) => s.startsWith("Weekly:"));
  assert.equal(weekly, c.weeklyText, `${c.name}: weekly text`);
}
for (const c of fixtures.usageSeverity) {
  assert.equal(usageSeverity(c.usedPercent), c.usedSeverity, `usage severity at ${c.usedPercent}`);
}
for (const c of fixtures.rateLimitSeverity) {
  assert.equal(rateLimitSeverity(c.usedPercent), c.usedSeverity, `rate limit severity at ${c.usedPercent}`);
}

// --- renderer contract ------------------------------------------------------
{
  // used-only weekly (no reset) and unavailable segments.
  const snap = adaptClaudeStatusPayload({ rate_limits: { seven_day: { used_percentage: 85 } } }, { now });
  const line = renderStatusLine(assessUsage(snap, { now }), { color: false });
  assert.equal(line, "Context: — · 5h: — · Weekly: 85%", "used-only + em-dash fallbacks");
}
{
  // Independent styling: weekly used value and debt magnitude are colored separately.
  const snap = adaptClaudeStatusPayload({
    rate_limits: { seven_day: { used_percentage: 90, resets_at: resetForElapsed(70, 10080) } },
  }, { now });
  const colored = renderStatusLine(assessUsage(snap, { now }), { color: true });
  const red = `${ESC}[91m`;
  assert.ok(colored.includes(`${red}20% debt${ESC}[0m`), "debt magnitude is red");
  assert.ok(colored.includes(`${red}90%${ESC}[0m`), "used value is red");
  // The label text carries no color of its own — it appears verbatim, then the colored used fragment.
  assert.ok(colored.includes(`Weekly: ${red}`), "label is plain; color begins only at the used fragment");
  assert.equal(stripAnsi(colored), "Context: — · 5h: — · Weekly: 90% (20% debt)");
  assert.equal(colored.split("\n").length, 1, "output is a single line");
}
{
  // NO_COLOR parity: stripped colored output equals plain output.
  const snap = adaptClaudeStatusPayload({ context_window: { used_percentage: 90 } }, { now });
  const assessed = assessUsage(snap, { now });
  assert.equal(stripAnsi(renderStatusLine(assessed, { color: true })), renderStatusLine(assessed, { color: false }));
}

// --- snapshot store ---------------------------------------------------------
{
  const snap = adaptClaudeStatusPayload({
    context_window: { used_percentage: 42 },
    rate_limits: { seven_day: { used_percentage: 70, resets_at: resetForElapsed(60, 10080) } },
  }, { now });
  assert.equal(writeLatestSnapshot("claude", snap), true, "first write succeeds");
  const stored = JSON.parse(fs.readFileSync(path.join(stateDir, "usage", "latest", "claude.json"), "utf8"));
  assert.equal(typeof stored.collectedAt, "string", "collectedAt serialized to ISO");
  assert.match(stored.windows.weekly.resetsAt, /Z$/, "resetsAt serialized to ISO");
  assert.ok(!JSON.stringify(stored).includes("used_percentage"), "raw payload not stored");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(stateDir, "usage", "latest", "claude.json")).mode & 0o777, 0o600, "restrictive mode");
  }
  // Dedup: identical snapshot within the min interval is skipped.
  assert.equal(writeLatestSnapshot("claude", snap), false, "redundant high-frequency write is bounded");
  // Isolation: codex write does not collide with claude.
  assert.equal(writeLatestSnapshot("codex", adaptCodexRateLimitSnapshot({ windows: [] }, { now, contextUsedPercent: 10 })), true);
  assert.ok(fs.existsSync(path.join(stateDir, "usage", "latest", "codex.json")), "per-harness isolation");

  const fresh = readLatestSnapshot("claude", { now: now + 1000 });
  assert.equal(fresh.freshness.state, "fresh", "under 2 min is fresh");
  const stale = readLatestSnapshot("claude", { now: now + 3 * 60 * 1000 });
  assert.equal(stale.freshness.state, "stale", "over 2 min is stale but still readable");
  assert.equal(readLatestSnapshot("nonexistent").available, false, "missing snapshot is unavailable, not a throw");

  fs.writeFileSync(path.join(stateDir, "usage", "latest", "corrupt.json"), "{ broken");
  assert.equal(readLatestSnapshot("corrupt").available, false, "corrupt snapshot returns unavailable");
}

// --- portal API view --------------------------------------------------------
{
  const res = portalUsage.buildUsageResponse({ now: now + 1000 });
  assert.equal(res.schema, 1);
  assert.equal(res.harnesses.claude.available, true, "claude snapshot surfaces");
  assert.equal(res.harnesses.claude.usage.context.severity, "caution");
  assert.equal(res.harnesses.claude.usage.weekly.balance.state, "debt", "used 70 ahead of elapsed 60 is debt");
  assert.ok(!JSON.stringify(res).includes("source"), "diagnostics source block never escapes to API");
  assert.ok(!JSON.stringify(res).includes(os.homedir()), "no home paths leak");
}

fs.rmSync(stateDir, { recursive: true, force: true });
console.log("ok: usage domain, render, snapshot store, portal API, fixtures");
