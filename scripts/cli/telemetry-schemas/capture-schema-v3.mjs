import { generateId, isValidId } from "./id.mjs";
import { validateObjectKeys } from "./validators.mjs";

export const CAPTURE_SCHEMA_V2 = 2;
export const CAPTURE_SCHEMA_V3 = 3;

export const OPERATION_CATEGORIES = new Set([
  "test", "lint", "typecheck", "build", "format", "install", "git", "serve",
  "file-read", "file-write", "search", "mcp", "other",
]);
export const OPERATION_SCOPES = new Set(["targeted", "affected", "full", "unknown"]);
export const OPERATION_EXIT_STATUSES = new Set(["pass", "fail", "blocked", "unknown"]);
export const PHASE_NAMES = new Set(["discovery", "implementation", "debugging", "verification", "finalization", "unknown"]);
export const PHASE_SOURCES = new Set(["explicit", "inferred"]);

const V3_ONLY_FIELDS = ["capture_id", "call_id", "config_snapshot_id", "operation", "phase", "intervening"];

export function generateCaptureId() {
  return generateId("cap");
}

// v2 records pass through unvalidated by this module (telemetry-capture.mjs already governs their
// shape) — this function's job is only to validate the v3-additive fields when present, and to
// leave a record with schema 2 (or no v3 fields at all) alone. Schema-v2 read compatibility is a
// hard requirement; this validator must never reject a plain v2 record.
export function validateCaptureV3(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("capture record must be an object");
  if (record.schema !== CAPTURE_SCHEMA_V2 && record.schema !== CAPTURE_SCHEMA_V3) {
    throw new Error(`unsupported capture schema version: ${record.schema}`);
  }
  if (record.schema === CAPTURE_SCHEMA_V2) return record;

  if (record.capture_id != null && !isValidId(record.capture_id, "cap")) throw new Error(`invalid capture_id: ${record.capture_id}`);
  if (record.call_id != null && typeof record.call_id !== "string") throw new Error("capture call_id must be a string");
  // Snapshot IDs are content-addressed hashes (snapshot-schema.mjs computeSnapshotId), 24 hex
  // chars — not the generic 16-hex generateId() shape isValidId(..., "cfg") checks for. Same fix
  // as marker-schema.mjs's config_snapshot_id.
  if (record.config_snapshot_id != null && !/^cfg_[a-f0-9]{24}$/.test(record.config_snapshot_id)) {
    throw new Error(`invalid capture config_snapshot_id: ${record.config_snapshot_id}`);
  }
  if (record.operation != null) validateOperation(record.operation);
  if (record.phase != null) validatePhase(record.phase);
  if (record.intervening != null) validateIntervening(record.intervening);
  if (record.repo != null) validateRepo(record.repo);
  return record;
}

// Repository-identity sub-object (telemetry-capture.mjs repoMetadata). All fields optional and
// privacy-safe: repository_id is a canonical git:/local: id (credential- and path-free);
// normalized_remote_hash correlates equivalent SSH/HTTPS remotes; git_root_hash/remote_hash are the
// legacy raw hashes kept for the migration window. Adding the two new fields to the allow-list is
// what makes strict validation accept them; older records lacking them still validate.
const REPO_FIELDS = ["label", "repository_id", "normalized_remote_hash", "git_root_hash", "remote_hash", "branch", "sha"];
function validateRepo(repo) {
  if (typeof repo !== "object" || Array.isArray(repo)) throw new Error("capture repo must be an object");
  validateObjectKeys(repo, REPO_FIELDS, "capture repo");
  if (repo.repository_id != null && (typeof repo.repository_id !== "string" || !/^(git|local):/.test(repo.repository_id))) {
    throw new Error(`invalid capture repo repository_id: ${repo.repository_id}`);
  }
  for (const field of ["label", "normalized_remote_hash", "git_root_hash", "remote_hash", "branch", "sha"]) {
    if (repo[field] != null && typeof repo[field] !== "string") throw new Error(`capture repo ${field} must be a string`);
  }
}

function validateOperation(operation) {
  if (typeof operation !== "object" || Array.isArray(operation)) throw new Error("capture operation must be an object");
  validateObjectKeys(operation, ["category", "runner", "scope", "target", "signature", "failure_signature", "exit_status", "classifier_version"], "capture operation");
  if (!OPERATION_CATEGORIES.has(operation.category)) throw new Error(`unknown operation category: ${operation.category}`);
  if (operation.runner != null && typeof operation.runner !== "string") throw new Error("operation runner must be a string");
  if (operation.scope != null && !OPERATION_SCOPES.has(operation.scope)) throw new Error(`unknown operation scope: ${operation.scope}`);
  if (operation.target != null && typeof operation.target !== "string") throw new Error("operation target must be a string");
  if (operation.signature != null && typeof operation.signature !== "string") throw new Error("operation signature must be a string");
  if (operation.failure_signature != null && typeof operation.failure_signature !== "string") throw new Error("operation failure_signature must be a string");
  if (operation.exit_status != null && !OPERATION_EXIT_STATUSES.has(operation.exit_status)) {
    throw new Error(`unknown operation exit_status: ${operation.exit_status}`);
  }
  // Plan requirement: "store a rule/version identifier with the classification so historical data
  // remains interpretable after classifier changes" — see telemetry-classify.mjs CLASSIFIER_VERSION.
  if (operation.classifier_version != null && !Number.isInteger(operation.classifier_version)) {
    throw new Error("operation classifier_version must be an integer");
  }
}

function validatePhase(phase) {
  if (typeof phase !== "object" || Array.isArray(phase)) throw new Error("capture phase must be an object");
  validateObjectKeys(phase, ["name", "source", "confidence", "classifier_version"], "capture phase");
  if (!PHASE_NAMES.has(phase.name)) throw new Error(`unknown phase name: ${phase.name}`);
  if (!PHASE_SOURCES.has(phase.source)) throw new Error(`unknown phase source: ${phase.source}`);
  if (typeof phase.confidence !== "number" || phase.confidence < 0 || phase.confidence > 1) {
    throw new Error("phase confidence must be a number between 0 and 1");
  }
  if (phase.classifier_version != null && !Number.isInteger(phase.classifier_version)) {
    throw new Error("phase classifier_version must be an integer");
  }
}

const INTERVENING_FIELDS = [
  "edit_since_last_test", "changed_file_count", "changed_file_categories",
  "diff_fingerprint", "diff_fingerprint_changed", "targeted_test_ran_since_last_full",
  "failure_signature_changed",
];

// Privacy-safe "what happened since the last equivalent test run" signals
// (intervening-work analysis). Booleans/counts/category labels only — no file paths, no diff content. diff_fingerprint
// is itself a hash (see telemetry-capture.mjs diffFingerprint()), not a real Git diff.
function validateIntervening(intervening) {
  if (typeof intervening !== "object" || Array.isArray(intervening)) throw new Error("capture intervening must be an object");
  validateObjectKeys(intervening, INTERVENING_FIELDS, "capture intervening");
  if (intervening.edit_since_last_test != null && typeof intervening.edit_since_last_test !== "boolean") {
    throw new Error("intervening edit_since_last_test must be a boolean");
  }
  if (intervening.changed_file_count != null && !Number.isInteger(intervening.changed_file_count)) {
    throw new Error("intervening changed_file_count must be an integer");
  }
  if (intervening.changed_file_categories != null) {
    if (!Array.isArray(intervening.changed_file_categories) || !intervening.changed_file_categories.every((c) => typeof c === "string")) {
      throw new Error("intervening changed_file_categories must be an array of strings");
    }
  }
  if (intervening.diff_fingerprint != null && typeof intervening.diff_fingerprint !== "string") {
    throw new Error("intervening diff_fingerprint must be a string");
  }
  if (intervening.diff_fingerprint_changed != null && typeof intervening.diff_fingerprint_changed !== "boolean") {
    throw new Error("intervening diff_fingerprint_changed must be a boolean");
  }
  if (intervening.targeted_test_ran_since_last_full != null && typeof intervening.targeted_test_ran_since_last_full !== "boolean") {
    throw new Error("intervening targeted_test_ran_since_last_full must be a boolean");
  }
  if (intervening.failure_signature_changed != null && typeof intervening.failure_signature_changed !== "boolean") {
    throw new Error("intervening failure_signature_changed must be a boolean");
  }
}

export const V3_ADDITIVE_FIELDS = V3_ONLY_FIELDS;
