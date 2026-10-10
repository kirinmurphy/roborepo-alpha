import assert from "node:assert/strict";
import { createOracleHealthResult, emptyOracleHealth } from "../cli/telemetry-schemas/oracle-health-schema.mjs";
import { transitionOracleHealth } from "../cli/telemetry-oracle-observer.mjs";

const signature = `sha256:${"a".repeat(64)}`, changed = `sha256:${"b".repeat(64)}`;
const metadata = { evidence_signature: signature, checked_at: "2026-10-01T18:22:31.000Z", duration_ms: 347 };
const comparison = { status: "passed", event_count: 2, session_count: 1, operation_count: 1,
  coverage: { supported_events: 2, unsupported_events: 0, comparable: true, complete: true, issues: [],
    checks: ["sessions", "operations", "conditions", "boundaries", "gating", "regression", "loops"] }, differences: [] };
const passed = createOracleHealthResult(comparison, metadata);
assert.equal(passed.schema, 1);
assert.equal(passed.status, "passed");
assert.equal(passed.evidence_signature, signature);
assert.equal(passed.duration_ms, 347);
const initial = emptyOracleHealth("checking");
assert.equal(initial.checked_at, null);
assert.equal(initial.evidence_signature, null, "startup never restores a prior green result");
const transition = (previous, type, extra = {}) => transitionOracleHealth(previous, { type, signature, ...extra });
assert.deepEqual(transition(initial, "finish", { result: passed }), passed);
assert.equal(transition(passed, "observe").status, "passed");
assert.equal(transition(passed, "start").status, "passed", "a current accepted result remains visible on retry");
const stale = transition(passed, "observe", { signature: changed });
assert.equal(stale.status, "stale");
assert.equal(stale.checked_at, metadata.checked_at);
assert.equal(stale.evidence_signature, signature, "stale details still identify the checked snapshot");
assert.equal(transition(stale, "start", { signature: changed }).status, "stale");
assert.equal(transition(stale, "observe").status, "stale", "a signature reverting cannot resurrect green");
assert.equal(transition(initial, "finish", { result: passed, signature: changed }).status, "stale");
assert.equal(transition(initial, "finish", { result: passed, signature: null }).status, "unavailable");
assert.equal(transition(stale, "finish", { result: passed }).status, "passed");
assert.equal(transition(initial, "start").status, "checking");
for (const status of ["partial", "failed", "unavailable"]) {
  const source = structuredClone(comparison);
  source.status = status;
  if (status === "partial") {
    source.coverage.complete = false;
    source.coverage.issues = [{ category: "skipped_evidence", count: 1 }];
  }
  if (status === "failed") source.differences = ["conditions"];
  const result = createOracleHealthResult(source, metadata);
  assert.equal(transition(initial, "finish", { result }).status, status);
  assert.equal(transition(initial, "finish", { result, signature: changed }).status, "stale");
  if (status === "unavailable") assert.equal(transition(result, "start").status, "checking", "retry shows running comparison");
}
for (const error_category of ["worker_start_error", "worker_crash", "worker_timeout", "evidence_read_error", "signature_error"]) {
  const result = transition(passed, "error", { error_category });
  assert.equal(result.status, "unavailable");
  assert.equal(result.error_category, error_category);
}
const secret = "PRIVATE-PROMPT /private/path SECRET-COMMAND";
const privateResult = createOracleHealthResult({ ...comparison, raw: secret, summary: secret,
  coverage: { ...comparison.coverage, raw: secret } }, metadata);
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
  const result = createOracleHealthResult(source, metadata);
  assert.equal(result.status, "unavailable", "malformed worker output cannot claim agreement");
  assert.ok(!JSON.stringify(result).includes(secret));
}
for (const result of [null, {}, { ...passed, schema: 99 }, { ...passed, evidence_signature: secret }]) {
  assert.equal(transition(initial, "finish", { result }).status, "unavailable");
}
assert.equal(createOracleHealthResult(comparison, { ...metadata, checked_at: secret }).status, "unavailable");
assert.equal(passed.status, "passed", "transitions never mutate the prior result");
console.log("telemetry oracle health schema and transition checks passed");
