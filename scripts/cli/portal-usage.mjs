// Execution layer for the /api/usage route: read each harness's latest snapshot, assess it with the
// SAME domain functions the status line uses (no duplicated thresholds), and shape a JSON-safe,
// leak-free view. Kept separate from portal-routes-usage.mjs so the route stays a thin HTTP shim.
import fs from "node:fs";
import { readLatestSnapshot } from "../../globals/packages/usage-statusline/scripts/usage-snapshot-store.mjs";
import { assessUsage } from "../../globals/packages/usage-statusline/claude/context-row/lib/usage-domain.mjs";

// Usage snapshots come from the usage-statusline package's status-line integration, so a harness
// has usage to show exactly when that package patches its config. Read from the package manifest
// rather than listed here, so adding a harness to the package is the one edit that adds it to this
// route, and a harness the package does not reach (Gemini CLI today) is absent.
//
// Deliberately NOT telemetry-rate-limits: that capability describes parsing rate-limit headers out
// of transcripts (Codex only), which is a different subsystem from the status-line snapshot store
// this route reads. Claude writes usage snapshots without declaring it.
const USAGE_PACKAGE_MANIFEST = new URL("../../globals/packages/usage-statusline/package.config.json", import.meta.url);
const HARNESSES = [...new Set(
  JSON.parse(fs.readFileSync(USAGE_PACKAGE_MANIFEST, "utf8")).resources
    .filter((resource) => resource.type === "config-patch")
    .map((resource) => resource.harness),
)];

// A window's public shape: used + severity always; pacing fields only when elapsed was computable.
function windowView(assessed) {
  if (!assessed.available) return null;
  const view = { usedPercent: assessed.usedPercent, usedSeverity: assessed.usedSeverity };
  if (assessed.elapsedPercent === undefined) return view;
  view.elapsedPercent = assessed.elapsedPercent;
  view.balance = assessed.balance.state === "unavailable"
    ? { state: "unavailable" }
    : { state: assessed.balance.state, magnitude: assessed.balance.magnitude };
  view.debtSeverity = assessed.balance.debtSeverity || "normal";
  return view;
}

// Assemble one harness entry. Only normalized/assessed values escape — never raw payloads, home
// paths, auth data, or the snapshot's `source` diagnostics block.
function harnessView(harness, { now }) {
  const result = readLatestSnapshot(harness, { now });
  if (!result.available) return { available: false, reason: result.reason };
  const assessed = assessUsage(result.snapshot, { now });
  const usage = {};
  if (assessed.context.available) {
    usage.context = { usedPercent: assessed.context.usedPercent, severity: assessed.context.usedSeverity };
  }
  const weekly = windowView(assessed.windows.weekly);
  if (weekly) usage.weekly = weekly;
  const fiveHour = windowView(assessed.windows.fiveHour);
  if (fiveHour) usage.fiveHour = fiveHour;
  return { available: true, freshness: result.freshness, usage };
}

export function buildUsageResponse({ now = Date.now() } = {}) {
  const harnesses = Object.fromEntries(HARNESSES.map((h) => [h, harnessView(h, { now })]));
  return { schema: 1, generatedAt: new Date(now).toISOString(), harnesses };
}
