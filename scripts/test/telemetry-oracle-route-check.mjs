#!/usr/bin/env node
import assert from "node:assert/strict";
import { telemetryRoutes } from "../cli/portal-routes-telemetry.mjs";
import { dispatchRoutes } from "../cli/portal-router.mjs";
import { createOracleHealthResult } from "../cli/telemetry-schemas/oracle-health-schema.mjs";
import { fakeResponse } from "./lib/fake-response.mjs";

const secret = "PRIVATE PROMPT /private/path RAW JSONL";
const signature = `sha256:${"a".repeat(64)}`;
const cached = createOracleHealthResult({
  status: "passed", event_count: 2, session_count: 1, operation_count: 1,
  coverage: { supported_events: 2, unsupported_events: 0, comparable: true, complete: true,
    issues: [], checks: ["sessions", "operations", "conditions", "boundaries", "gating", "regression", "loops"] },
  differences: [],
}, { evidence_signature: signature, checked_at: "2026-10-01T18:22:31.000Z", duration_ms: 347 });

let reads = 0;
const response = dispatch("GET", {
  loadOracleHealth: () => {
    reads += 1;
    return { ...cached, raw_event: { prompt: secret }, command_output: secret,
      coverage: { ...cached.coverage, raw_rows: [secret] } };
  },
  analyzeTelemetry: () => { throw new Error("the cached route must not run analysis"); },
  readSpool: () => { throw new Error("the cached route must not read evidence"); },
});
assert.equal(response.statusCode, 200);
assert.equal(response.headers["Cache-Control"], "no-store");
assert.equal(response.headers["Content-Type"], "application/json");
assert.equal(reads, 1, "the route reads the cached state exactly once");
assert.deepEqual(JSON.parse(response.body), cached, "the route preserves the versioned public schema");
assert.ok(!response.body.includes(secret), "the endpoint drops fields outside the privacy-safe schema");

const malformed = dispatch("GET", { loadOracleHealth: () => ({ ...cached, schema: 99, summary: secret }) });
const fallback = JSON.parse(malformed.body);
assert.equal(fallback.schema, 1);
assert.equal(fallback.status, "unavailable");
assert.equal(fallback.error_category, "invalid_cached_health", "malformed cache state is not reported as a worker fault");
assert.ok(!malformed.body.includes(secret), "malformed cache state cannot escape through fallback text");

reads = 0;
const rejected = dispatch("POST", { loadOracleHealth: () => { reads += 1; return cached; } });
assert.equal(rejected.statusCode, 405);
assert.equal(reads, 0, "non-GET requests never touch cached observer state");
console.log("telemetry oracle cached route and privacy checks passed");

function dispatch(method, handlers) {
  const res = fakeResponse();
  const handled = dispatchRoutes([telemetryRoutes], { method }, res,
    "/api/telemetry/oracle-health", "", handlers);
  assert.equal(handled, true);
  return res;
}
