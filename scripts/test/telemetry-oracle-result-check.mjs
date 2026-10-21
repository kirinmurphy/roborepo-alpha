import assert from "node:assert/strict";
import { createOracleResult, emptyOracleResult, ORACLE_STATUSES } from "../cli/telemetry-schemas/oracle-result-schema.mjs";

const metadata = { checked_at: "2026-10-01T18:22:31.000Z", duration_ms: 347 };
const comparison = { status: "passed", event_count: 2, session_count: 1, operation_count: 1,
  coverage: { supported_events: 2, unsupported_events: 0, comparable: true, complete: true, issues: [],
    checks: ["sessions", "operations", "conditions", "boundaries", "gating", "regression", "loops"] }, differences: [] };
const RESULT_KEYS = ["schema", "status", "checked_at", "duration_ms", "event_count", "session_count", "operation_count",
  "coverage", "differences", "summary"];

assert.deepEqual(ORACLE_STATUSES, ["passed", "partial", "unavailable", "failed"], "only the four result statuses exist");
const passed = createOracleResult(comparison, metadata);
assert.deepEqual(Object.keys(passed), RESULT_KEYS, "the result carries only allowlisted fields");
assert.equal(passed.schema, 1);
assert.equal(passed.status, "passed");
assert.equal(passed.checked_at, metadata.checked_at);
assert.equal(passed.duration_ms, 347);

for (const status of ["partial", "failed", "unavailable"]) {
  const source = structuredClone(comparison);
  source.status = status;
  if (status === "partial") {
    source.coverage.complete = false;
    source.coverage.issues = [{ category: "skipped_evidence", count: 1 }];
  }
  if (status === "failed") source.differences = ["conditions"];
  const result = createOracleResult(source, metadata);
  assert.equal(result.status, status);
  assert.equal("error_category" in result, false, `${status} carries no error category of its own`);
}

const readError = createOracleResult(emptyOracleResult("evidence_read_error"), metadata);
assert.equal(readError.status, "unavailable");
assert.equal(readError.error_category, "evidence_read_error");
assert.deepEqual(Object.keys(readError), [...RESULT_KEYS, "error_category"]);
assert.equal(emptyOracleResult("worker_crash").error_category, "comparison_error", "removed categories are unrecognized");
assert.equal(createOracleResult({ ...comparison, status: "unavailable", coverage: { ...comparison.coverage, comparable: false, checks: [] },
  error_category: "invalid_worker_result" }, metadata).error_category, "comparison_error", "unknown categories project to comparison_error");
for (const status of ["passed", "partial", "failed"]) {
  const source = structuredClone(comparison);
  source.status = status;
  source.error_category = "comparison_error";
  assert.equal(createOracleResult(source, metadata).status, "unavailable", `error_category is only valid on unavailable, not ${status}`);
}
for (const status of ["checking", "stale"]) {
  assert.equal(createOracleResult({ ...comparison, status }, metadata).status, "unavailable", `${status} is not a result status`);
}

const secret = "PRIVATE-PROMPT /private/path SECRET-COMMAND";
const privateResult = createOracleResult({ ...comparison, raw: secret, summary: secret, evidence_signature: secret,
  coverage: { ...comparison.coverage, raw: secret } }, { ...metadata, evidence_signature: secret });
assert.equal(privateResult.status, "passed");
assert.deepEqual(Object.keys(privateResult), RESULT_KEYS, "unexpected fields are dropped");
assert.ok(!JSON.stringify(privateResult).includes(secret));
for (const mutate of [
  (value) => { value.coverage.issues = [{ category: secret, count: 1 }]; },
  (value) => { value.differences = [secret]; },
  (value) => { value.error_category = secret; },
  (value) => { value.event_count = -1; },
  (value) => { value.operation_count = 3; },
  (value) => { value.coverage.supported_events = 1; },
  (value) => { value.coverage.complete = false; },
  (value) => { value.coverage.comparable = false; },
  (value) => { value.coverage.checks = []; },
]) {
  const source = structuredClone(comparison);
  mutate(source);
  const result = createOracleResult(source, metadata);
  assert.equal(result.status, "unavailable", "malformed comparison output cannot claim agreement");
  assert.equal(result.error_category, "comparison_error");
  assert.ok(!JSON.stringify(result).includes(secret));
}
for (const value of [null, {}, { ...comparison, schema: 99, status: "unknown" }]) {
  assert.equal(createOracleResult(value, metadata).status, "unavailable");
}
const badMetadata = createOracleResult(comparison, { ...metadata, checked_at: secret });
assert.equal(badMetadata.status, "unavailable");
assert.equal(badMetadata.checked_at, null);
assert.ok(!JSON.stringify(badMetadata).includes(secret));
console.log("telemetry oracle result schema checks passed");
