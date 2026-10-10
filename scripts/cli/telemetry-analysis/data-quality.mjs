import { hasTokens, hasRateLimitsCapability } from "./captures.mjs";
export function dataQualityWarnings(events) {
  const warnings = [];
  const byHarness = new Map();
  for (const event of events) {
    const harness = event.harness || "unknown";
    const cur = byHarness.get(harness) || { events: 0, tokenRecords: 0, nonzeroTokenRecords: 0, unsupported: 0, rateLimited: 0 };
    cur.events += 1;
    if (hasTokens(event)) {
      cur.tokenRecords += 1;
      if ((event.tokens?.total || 0) > 0) cur.nonzeroTokenRecords += 1;
    }
    if (event.details?.unsupported_usage_seen) cur.unsupported += 1;
    if (hasRateLimitsCapability(harness) && event.details?.codex_rate_limits) cur.rateLimited += 1;
    byHarness.set(harness, cur);
  }
  for (const [harness, cur] of byHarness) {
    if (cur.events > 0 && cur.nonzeroTokenRecords === 0) {
      warnings.push({
        type: "missing_token_data",
        harness,
        events: cur.events,
        token_records: cur.tokenRecords,
        hint: "events exist but no nonzero token records were parsed",
      });
    }
    if (cur.unsupported > 0) {
      warnings.push({
        type: "unsupported_usage_schema",
        harness,
        events: cur.unsupported,
        hint: "transcript usage records were present but not in a supported schema",
      });
    }
    if (hasRateLimitsCapability(harness) && cur.nonzeroTokenRecords > 0 && cur.rateLimited === 0) {
      warnings.push({
        type: "rate_limit_unavailable",
        harness,
        events: cur.nonzeroTokenRecords,
        hint: "Codex token data present but no provider rate-limit records were captured",
      });
    }
  }
  return warnings;
}
