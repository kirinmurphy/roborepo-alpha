#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateId, isValidId } from "../cli/telemetry-schemas/id.mjs";
import { generateMarkerId, validateMarker } from "../cli/telemetry-schemas/marker-schema.mjs";
import { computeSnapshotId, validateSnapshot, buildEffectiveSnapshot } from "../cli/telemetry-schemas/snapshot-schema.mjs";
import { generateExperimentId, validateExperiment } from "../cli/telemetry-schemas/experiment-schema.mjs";
import { validateCaptureV3 } from "../cli/telemetry-schemas/capture-schema-v3.mjs";
import { privacyHash, PRIVACY_HASH_WIDTH } from "../cli/telemetry-schemas/hash.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

  // task_category/task_scale, outcome-marker-only.
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

function testCaptureV3Compat() {
  const v2Record = { schema: 2, ts: new Date().toISOString(), harness: "claude", event: "PostToolUse" };
  assert.deepEqual(validateCaptureV3(v2Record), v2Record, "a plain v2 record must pass through unchanged");

  const v3Record = {
    ...v2Record,
    schema: 3,
    capture_id: generateId("cap"),
    call_id: "toolu_abc123",
    operation: { category: "test", scope: "targeted", exit_status: "pass" },
    phase: { name: "debugging", source: "inferred", confidence: 0.8, classifier_version: 1 },
    intervening: {
      edit_since_last_test: true,
      changed_file_count: 2,
      changed_file_categories: ["code", "doc"],
      diff_fingerprint: "abc123",
      diff_fingerprint_changed: true,
      targeted_test_ran_since_last_full: false,
      failure_signature_changed: true,
    },
  };
  assert.deepEqual(validateCaptureV3(v3Record), v3Record);
  assert.throws(
    () => validateCaptureV3({ ...v3Record, operation: { ...v3Record.operation, category: "nonsense" } }),
    /unknown operation category/,
  );
  assert.throws(() => validateCaptureV3({ ...v2Record, schema: 4 }), /unsupported capture schema version/);
  assert.throws(
    () => validateCaptureV3({ ...v3Record, intervening: { ...v3Record.intervening, changed_file_count: "two" } }),
    /changed_file_count must be an integer/,
  );
  assert.throws(
    () => validateCaptureV3({ ...v3Record, intervening: { ...v3Record.intervening, unknown_field: 1 } }),
    /unknown capture intervening field/,
  );
}

// Persistence functions import state-paths.mjs, whose STATE_ROOT is a top-level const resolved from
// ROBOREPO_STATE_DIR at import time (see paths.mjs). Sandboxing that requires setting the env var
// on a freshly spawned node process, not inside this already-running one — same pattern as
// package-lifecycle-check.mjs's spawnSync(cli, ..., { env }).
function testPersistenceRoundTrip() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-telemetry-schemas-"));
  try {
    const script = path.join(repoRoot, "scripts/test/telemetry-schemas-persistence-child.mjs");
    const env = { ...process.env, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo") };
    const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
    assert.equal(result.status, 0, `persistence child process failed:\n${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- privacy hash --------------------------------------------------------------------------

// Hashed values are joined across files and across time: capture writes a file_path_hash today, and
// a consumer months later hashes a path it knows and looks for a match. Change the algorithm or the
// width and nothing throws — the joins just return zero rows, which reads exactly like "the session
// touched nothing". These expected values are literals on purpose; deriving them would re-implement
// the thing under test and pass no matter what it became.
function testPrivacyHashIsPinned() {
  assert.equal(PRIVACY_HASH_WIDTH, 24, "changing the truncation width invalidates every stored hash");
  assert.equal(privacyHash(""), "e3b0c44298fc1c149afbf4c8", "the empty string's hash is a fixed value");
  assert.equal(privacyHash("roborepo"), "7bf53fdcbcb90ea72b356e58");
  assert.equal(privacyHash("npm run test:plans"), "69ff1328de27345a75595590");

  for (const value of ["", "a", "/tmp/x.md", 0, null, undefined]) {
    assert.equal(privacyHash(value).length, PRIVACY_HASH_WIDTH, `every hash is ${PRIVACY_HASH_WIDTH} characters, including for ${String(value)}`);
    assert.match(privacyHash(value), /^[0-9a-f]+$/, "hashes are lowercase hex");
  }
  assert.equal(privacyHash(123), privacyHash("123"), "values are stringified before hashing, so a number and its text form agree");
  assert.notEqual(privacyHash("a"), privacyHash("b"));
}

// The consolidation itself. Five copies of this algorithm were kept aligned by a comment; a sixth
// copy appearing anywhere in the pipeline reintroduces exactly the drift this replaced.
function testPrivacyHashHasOneImplementation() {
  const pattern = /createHash\(\s*["']sha256["']\s*\)[\s\S]{0,120}?slice\(\s*0\s*,\s*24\s*\)/;
  const searched = [];
  const offenders = [];
  for (const dir of ["scripts/cli", "scripts/cli/telemetry-schemas", "modules/telemetry"]) {
    const full = path.join(repoRoot, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full)) {
      if (!entry.endsWith(".mjs") || entry === "hash.mjs") continue;
      const file = path.join(full, entry);
      if (!fs.statSync(file).isFile()) continue;
      searched.push(path.join(dir, entry));
      if (pattern.test(fs.readFileSync(file, "utf8"))) offenders.push(path.join(dir, entry));
    }
  }
  assert.ok(searched.length > 5, `expected to search the telemetry modules, only saw ${searched.length} files`);
  assert.deepEqual(offenders, [],
    "each file listed here reimplements privacyHash inline; import it from telemetry-schemas/hash.mjs instead — a second copy drifts silently, and a width mismatch empties every cross-file join without failing anything");
}

// telemetry-capture.mjs imports this module and runs on every PreToolUse/PostToolUse hook, so the
// hash module has to stay as cheap to load as the inline copy it replaced.
function testPrivacyHashModuleStaysDependencyFree() {
  const source = fs.readFileSync(path.join(repoRoot, "scripts/cli/telemetry-schemas/hash.mjs"), "utf8");
  const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:crypto"],
    "hash.mjs may import node:crypto and nothing else; capture's minimal-import constraint depends on it");
}
