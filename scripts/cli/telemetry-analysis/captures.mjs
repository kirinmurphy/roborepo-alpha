import { hasHarnessProvider, getHarnessProvider } from "../../harnesses/registry.mjs";
// Provider session IDs are unique only within a harness. Rate-limit support is capability-driven.
export function hasTokens(event) {
  return event && event.tokens && typeof event.tokens.total === "number";
}

export function sessionKeyOf(event) {
  return JSON.stringify([event.harness ?? null, event.session_id || "unknown"]);
}

export function hasRateLimitsCapability(harness) {
  return hasHarnessProvider(harness) && getHarnessProvider(harness).manifest.capabilities.includes("telemetry-rate-limits");
}

export function minStr(a, b) { return a <= b ? a : b; }
export function maxStr(a, b) { return a >= b ? a : b; }
