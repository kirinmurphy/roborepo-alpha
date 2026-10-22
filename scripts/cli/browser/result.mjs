// The provider contract for `roborepo browser`: what probe and run return, whatever drives the
// browser. Providers build results with these helpers and the CLI validates every result before
// printing it, so a provider cannot report a shape (or a status) the rules and docs do not describe.

import fs from "node:fs";

export const STATUS = Object.freeze({
  PASSED: "passed",
  FAILED: "failed",
  UNVERIFIED: "unverified",
  BLOCKED: "blocked",
});

export const CHECK_STATUS = Object.freeze({ PASSED: "passed", FAILED: "failed" });

export const CAPTURE_TYPES = Object.freeze(["screenshot", "video", "trace"]);

const STATUSES = new Set(Object.values(STATUS));
const CHECK_STATUSES = new Set(Object.values(CHECK_STATUS));

// `passed` is earned only by executed checks. A run with no checks observed something but asserted
// nothing, so it is `unverified` however clean it looked; one failed check fails the run.
export function statusFromChecks(checks) {
  if (checks.length === 0) return STATUS.UNVERIFIED;
  return checks.every((check) => check.status === CHECK_STATUS.PASSED) ? STATUS.PASSED : STATUS.FAILED;
}

export function unavailableProbe(limitations) {
  return { available: false, capabilities: Object.fromEntries(CAPTURE_TYPES.map((type) => [type, false])), limitations };
}

export function blockedResult(limitations, { artifacts = [], checks = [] } = {}) {
  return { status: STATUS.BLOCKED, checks, artifacts, limitations };
}

// Throws on any contract violation. Run results are also checked against the disk: an artifact
// path that does not exist is fabricated evidence, and is a provider bug rather than a limitation.
export function validateProbeResult(result) {
  const problems = [];
  if (typeof result?.available !== "boolean") problems.push("available must be a boolean");
  const capabilities = result?.capabilities;
  if (!capabilities || typeof capabilities !== "object") {
    problems.push("capabilities must be an object");
  } else {
    for (const type of CAPTURE_TYPES) {
      if (typeof capabilities[type] !== "boolean") problems.push(`capabilities.${type} must be a boolean`);
    }
  }
  if (!isStringArray(result?.limitations)) problems.push("limitations must be an array of strings");
  return report("probe", problems, result);
}

export function validateRunResult(result) {
  const problems = [];
  if (!STATUSES.has(result?.status)) problems.push(`status must be one of ${[...STATUSES].join(", ")}`);
  if (!Array.isArray(result?.checks)) {
    problems.push("checks must be an array");
  } else {
    result.checks.forEach((check, index) => {
      if (typeof check?.name !== "string" || !check.name) problems.push(`checks[${index}].name must be a string`);
      if (!CHECK_STATUSES.has(check?.status)) problems.push(`checks[${index}].status must be passed or failed`);
    });
    if (result.status === STATUS.PASSED && result.checks.length === 0) {
      problems.push("passed requires at least one executed check");
    }
    if (result.status === STATUS.PASSED && result.checks.some((check) => check.status !== CHECK_STATUS.PASSED)) {
      problems.push("passed cannot include a failed check");
    }
  }
  if (!Array.isArray(result?.artifacts)) {
    problems.push("artifacts must be an array");
  } else {
    result.artifacts.forEach((artifact, index) => {
      if (!CAPTURE_TYPES.includes(artifact?.type)) problems.push(`artifacts[${index}].type is not a capture type`);
      if (typeof artifact?.path !== "string" || !fs.existsSync(artifact.path)) {
        problems.push(`artifacts[${index}].path does not exist: ${artifact?.path}`);
      }
    });
  }
  if (!isStringArray(result?.limitations)) problems.push("limitations must be an array of strings");
  return report("run", problems, result);
}

function report(kind, problems, result) {
  if (problems.length) throw new Error(`browser ${kind} result violates the provider contract: ${problems.join("; ")}`);
  return result;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
