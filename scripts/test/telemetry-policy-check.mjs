#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  validateTelemetryPolicies, evaluatePolicy, evaluatePackagePolicies, POLICY_OPERATORS, POLICY_SEVERITIES,
} from "../cli/telemetry-policy.mjs";

// Package telemetry policies: advisory-only, never blocking. Pure module.

testValidPolicyPasses();
testUnknownMetricRejected();
testInvalidOperatorRejected();
testMissingValueRejected();
testNoPoliciesIsFine();
testPoliciesMustBeArray();
testEvaluatePolicySatisfied();
testEvaluatePolicyViolated();
testEvaluatePolicyInsufficientSamples();
testEvaluatePackagePolicies();
console.log("telemetry policy checks passed");

function testValidPolicyPasses() {
  const errors = validateTelemetryPolicies({
    id: "test-harness",
    telemetry: { policies: [{ metric: "test.full_suite_calls_per_debug_phase", operator: "<=", value: 1, minimum_samples: 3, severity: "warning" }] },
  });
  assert.deepEqual(errors, []);
}

function testUnknownMetricRejected() {
  const errors = validateTelemetryPolicies({
    id: "test-harness",
    telemetry: { policies: [{ metric: "bogus.metric", operator: "<=", value: 1 }] },
  });
  assert.ok(errors.some((e) => e.includes("not a known metric id")));
}

function testInvalidOperatorRejected() {
  const errors = validateTelemetryPolicies({
    id: "test-harness",
    telemetry: { policies: [{ metric: "test.full_suite_calls_per_debug_phase", operator: "~=", value: 1 }] },
  });
  assert.ok(errors.some((e) => e.includes("operator")));
}

function testMissingValueRejected() {
  const errors = validateTelemetryPolicies({
    id: "test-harness",
    telemetry: { policies: [{ metric: "test.full_suite_calls_per_debug_phase", operator: "<=" }] },
  });
  assert.ok(errors.some((e) => e.includes("value")));
}

function testNoPoliciesIsFine() {
  assert.deepEqual(validateTelemetryPolicies({ id: "x" }), []);
  assert.deepEqual(validateTelemetryPolicies({ id: "x", telemetry: {} }), []);
}

function testPoliciesMustBeArray() {
  const errors = validateTelemetryPolicies({ id: "x", telemetry: { policies: "not-an-array" } });
  assert.ok(errors.some((e) => e.includes("must be an array")));
}

function testEvaluatePolicySatisfied() {
  const policy = { metric: "test.full_suite_calls_per_debug_phase", operator: "<=", value: 1, minimum_samples: 3 };
  const result = evaluatePolicy(policy, 0.5, 10);
  assert.equal(result.status, "satisfied");
  assert.equal(result.violated, false);
}

function testEvaluatePolicyViolated() {
  const policy = { metric: "test.full_suite_calls_per_debug_phase", operator: "<=", value: 1, minimum_samples: 3 };
  const result = evaluatePolicy(policy, 3.8, 10);
  assert.equal(result.status, "violated");
  assert.equal(result.violated, true);
}

function testEvaluatePolicyInsufficientSamples() {
  const policy = { metric: "test.full_suite_calls_per_debug_phase", operator: "<=", value: 1, minimum_samples: 10 };
  const result = evaluatePolicy(policy, 5, 2);
  assert.equal(result.status, "insufficient-samples");
  assert.equal(result.violated, false);
}

function testEvaluatePackagePolicies() {
  const pkg = {
    id: "test-harness",
    telemetry: { policies: [{ metric: "test.full_suite_calls_per_debug_phase", operator: "<=", value: 1, minimum_samples: 3 }] },
  };
  const results = evaluatePackagePolicies(pkg, { "test.full_suite_calls_per_debug_phase": { value: 3.8, sampleSize: 10 } });
  assert.equal(results.length, 1);
  assert.equal(results[0].package_id, "test-harness");
  assert.equal(results[0].violated, true);

  assert.deepEqual(evaluatePackagePolicies({ id: "no-policies" }, {}), []);
}

function testOperatorAndSeveritySetsExported() {
  assert.ok(POLICY_OPERATORS.has("<="));
  assert.ok(POLICY_SEVERITIES.has("warning"));
}
testOperatorAndSeveritySetsExported();
