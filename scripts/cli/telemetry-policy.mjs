// Package telemetry policies. A package's
// package.config.json may declare an optional `telemetry.policies` array describing an expected
// metric threshold. Policies are advisory-only: this module validates the declared shape and
// evaluates a policy against a computed metric value, but nothing here blocks a command or tool call.
//
// Validation follows the repo's existing hand-rolled schema style (package-catalog.mjs's
// validatePackageCatalog: accumulate errors, throw once) rather than introducing a schema library.

import { isKnownMetric } from "./telemetry-metrics.mjs";

export const POLICY_OPERATORS = new Set(["<=", "<", ">=", ">", "=="]);
export const POLICY_SEVERITIES = new Set(["warning", "info"]);

// Validates the `telemetry.policies` array on a single package definition. Returns an array of error
// strings (empty when valid) rather than throwing, so a catalog-wide validation pass (many packages)
// can accumulate every package's errors before reporting, matching validatePackageCatalog's style.
export function validateTelemetryPolicies(pkg) {
  const errors = [];
  const policies = pkg?.telemetry?.policies;
  if (policies == null) return errors;
  if (!Array.isArray(policies)) {
    errors.push(`${pkg.id}: telemetry.policies must be an array`);
    return errors;
  }
  policies.forEach((policy, index) => {
    const label = `${pkg.id}: telemetry.policies[${index}]`;
    if (!policy || typeof policy !== "object") { errors.push(`${label} must be an object`); return; }
    if (typeof policy.metric !== "string" || !policy.metric) errors.push(`${label}.metric is required`);
    else if (!isKnownMetric(policy.metric)) errors.push(`${label}.metric is not a known metric id: ${policy.metric}`);
    if (!POLICY_OPERATORS.has(policy.operator)) errors.push(`${label}.operator must be one of ${[...POLICY_OPERATORS].join(", ")}`);
    if (typeof policy.value !== "number") errors.push(`${label}.value must be a number`);
    if (policy.minimum_samples != null && (!Number.isInteger(policy.minimum_samples) || policy.minimum_samples < 1)) {
      errors.push(`${label}.minimum_samples must be a positive integer`);
    }
    if (policy.severity != null && !POLICY_SEVERITIES.has(policy.severity)) {
      errors.push(`${label}.severity must be one of ${[...POLICY_SEVERITIES].join(", ")}`);
    }
  });
  return errors;
}

function compare(value, operator, threshold) {
  switch (operator) {
    case "<=": return value <= threshold;
    case "<": return value < threshold;
    case ">=": return value >= threshold;
    case ">": return value > threshold;
    case "==": return value === threshold;
    default: return null;
  }
}

// Evaluates one policy against an already-computed metric value + the sample size (session count)
// backing it. Policies are attached to package EXPOSURE,
// not assumed global — the caller is responsible for scoping `metricValue`/`sampleSize`
// to sessions exposed to this package before calling evaluatePolicy; this function does not itself
// know how to select that cohort (that's telemetry-cohort.mjs's job).
export function evaluatePolicy(policy, metricValue, sampleSize) {
  const minimumSamples = policy.minimum_samples ?? 1;
  if (sampleSize < minimumSamples) {
    return {
      policy,
      status: "insufficient-samples",
      sample_size: sampleSize,
      metric_value: metricValue,
      violated: false,
    };
  }
  if (metricValue == null) {
    return { policy, status: "unknown", sample_size: sampleSize, metric_value: null, violated: false };
  }
  const satisfied = compare(metricValue, policy.operator, policy.value);
  return {
    policy,
    status: satisfied ? "satisfied" : "violated",
    sample_size: sampleSize,
    metric_value: metricValue,
    violated: satisfied === false,
  };
}

// Evaluates every declared policy for a package against a map of metric_id -> { value, sampleSize }.
// Findings state whether the value VIOLATES an explicit policy or merely differs statistically (the
// latter is telemetry-compare.mjs's job, not this module's).
export function evaluatePackagePolicies(pkg, metricSamples) {
  const policies = pkg?.telemetry?.policies;
  if (!Array.isArray(policies) || !policies.length) return [];
  return policies.map((policy) => {
    const sample = metricSamples[policy.metric] ?? { value: null, sampleSize: 0 };
    return { package_id: pkg.id, ...evaluatePolicy(policy, sample.value, sample.sampleSize) };
  });
}
