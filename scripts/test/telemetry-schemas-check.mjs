#!/usr/bin/env node
import assert from "node:assert/strict";
import { testPersistenceRoundTrip } from "./telemetry-schemas/persistence-checks.mjs";
import { testPrivacyHashIsPinned, testPrivacyHashHasOneImplementation, testPrivacyHashModuleStaysDependencyFree } from "./telemetry-schemas/privacy-checks.mjs";
import { generateId, isValidId } from "../cli/telemetry-schemas/id.mjs";
import { generateMarkerId, validateMarker } from "../cli/telemetry-schemas/marker-schema.mjs";
import { computeSnapshotId, validateSnapshot, buildEffectiveSnapshot } from "../cli/telemetry-schemas/snapshot-schema.mjs";
import { generateExperimentId, validateExperiment } from "../cli/telemetry-schemas/experiment-schema.mjs";
import { testCaptureV3Compat } from "./telemetry-schemas/capture-checks.mjs";

testIdGenerator();
testMarkerValidation();
testSnapshotContentAddressing();
testExperimentValidation();
testCaptureV3Compat();
testPersistenceRoundTrip();
testPrivacyHashIsPinned();
testPrivacyHashHasOneImplementation();
testPrivacyHashModuleStaysDependencyFree();
console.log("telemetry schema checks passed");

function testIdGenerator() {
  const a = generateId("mark");
  const b = generateId("mark");
  assert.notEqual(a, b, "generated ids must be unique");
  assert.ok(isValidId(a, "mark"), "generated id must round-trip through isValidId");
  assert.ok(!isValidId(a, "cfg"), "id must not validate against the wrong prefix");
  assert.throws(() => generateId("Bad Prefix"), /invalid id prefix/);
}

function testMarkerValidation() {
  const base = {
    schema: 1,
    marker_id: generateMarkerId(),
    ts: new Date().toISOString(),
    type: "change",
    title: "Prevent full-suite debugging loops",
  };
  assert.deepEqual(validateMarker(base), base);

  assert.throws(() => validateMarker({ ...base, type: "bogus" }), /unknown marker type/);
  assert.throws(() => validateMarker({ ...base, title: "" }), /marker title is required/);
  assert.throws(() => validateMarker({ ...base, unknown_field: 1 }), /unknown marker field/);

  const outcome = { ...base, marker_id: generateMarkerId(), type: "outcome", status: "successful" };
  assert.deepEqual(validateMarker(outcome), outcome);
  assert.throws(() => validateMarker({ ...base, type: "outcome" }), /requires a valid status/);
  assert.throws(() => validateMarker({ ...base, status: "successful" }), /status is only valid on outcome markers/);

  const phase = { ...base, marker_id: generateMarkerId(), type: "phase", phase: "debugging" };
  assert.deepEqual(validateMarker(phase), phase);
  assert.throws(() => validateMarker({ ...base, type: "phase" }), /requires a non-empty phase/);

  // Phase 4: task_category/task_scale, outcome-marker-only.
  const outcomeWithTask = {
    ...outcome,
    marker_id: generateMarkerId(),
    task_category: "bug-fix",
    task_category_source: "explicit",
    task_scale: { files_touched: 3, directories_touched: 1, insertions: 40, deletions: 12, cross_cutting: false, surface: "code" },
  };
  assert.deepEqual(validateMarker(outcomeWithTask), outcomeWithTask);
  assert.throws(() => validateMarker({ ...base, task_category: "bug-fix", task_category_source: "explicit" }), /only valid on outcome markers/);
  assert.throws(() => validateMarker({ ...outcome, marker_id: generateMarkerId(), task_category: "bogus", task_category_source: "explicit" }), /unknown marker task_category/);
  assert.throws(() => validateMarker({ ...outcome, marker_id: generateMarkerId(), task_category: "bug-fix" }), /requires a valid task_category_source/);
  assert.throws(
    () => validateMarker({ ...outcome, marker_id: generateMarkerId(), task_category: "bug-fix", task_category_source: "explicit", task_scale: { files_touched: -1 } }),
    /non-negative integer/,
  );
}

function testSnapshotContentAddressing() {
  const configSnapshot = {
    packages: [{ id: "test-harness", enabled: true }, { id: "unused-pkg", enabled: false }],
    tools: [{ id: "test-harness", installed: true }],
    globals: { settings: { hooks: { PreToolUse: 2, PostToolUse: 2 } } },
  };
  const snapshotA = buildEffectiveSnapshot(configSnapshot, { harness: "claude", model: "sonnet" });
  const snapshotB = buildEffectiveSnapshot(configSnapshot, { harness: "codex", model: "gpt" });
  assert.notEqual(snapshotA.snapshot_id, snapshotB.snapshot_id, "v2 provider coverage must be part of snapshot identity");
  assert.equal(computeSnapshotId({ ...snapshotA, schema: 1 }), computeSnapshotId({ ...snapshotB, schema: 1 }), "v1 identity remains stable");
  assert.equal(snapshotA.snapshot_id, buildEffectiveSnapshot(configSnapshot, { harness: "claude", model: "other" }).snapshot_id, "model alone does not change configuration identity");
  assert.ok(snapshotB.unavailable.includes("codex_config_toml_parsed"), "codex snapshots must flag the parsed-config.toml gap");
  assert.ok(!snapshotA.unavailable.includes("codex_config_toml_parsed"), "claude snapshots must not carry the codex-only gap");

  const changedSnapshot = buildEffectiveSnapshot(
    { ...configSnapshot, packages: [{ id: "test-harness", enabled: false }] },
    { harness: "claude" },
  );
  assert.notEqual(snapshotA.snapshot_id, changedSnapshot.snapshot_id, "different enabled-package sets must produce different snapshot ids");

  assert.equal(computeSnapshotId(snapshotA), snapshotA.snapshot_id, "computeSnapshotId must be stable/idempotent on an already-built snapshot");
  assert.throws(() => validateSnapshot({ ...snapshotA, schema: 99 }), /unsupported snapshot schema version/);
}

function testExperimentValidation() {
  const base = {
    schema: 1,
    experiment_id: generateExperimentId(),
    title: "Test-harness guidance v2",
    start_marker_id: generateMarkerId(),
    end_marker_id: null,
    primary_metric: "test.full_suite_calls_per_debug_phase",
    expected_direction: "decrease",
    guardrails: ["outcome.completion_rate"],
    eligibility: { task_categories: ["bug-fix"], minimum_sessions_per_cohort: 10 },
    comparison: "previous-equivalent-window",
  };
  assert.deepEqual(validateExperiment(base), base);
  assert.throws(() => validateExperiment({ ...base, comparison: "vibes" }), /unknown experiment comparison mode/);
  assert.throws(
    () => validateExperiment({ ...base, eligibility: { ...base.eligibility, minimum_sessions_per_cohort: 0 } }),
    /minimum_sessions_per_cohort must be a positive integer/,
  );
}
