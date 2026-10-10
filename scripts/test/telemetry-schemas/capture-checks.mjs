import assert from "node:assert/strict";
import { generateId } from "../../cli/telemetry-schemas/id.mjs";
import { validateCaptureV3 } from "../../cli/telemetry-schemas/capture-schema-v3.mjs";

export function testCaptureV3Compat() {
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
