import { generateId, isValidId } from "./id.mjs";
import { validateObjectKeys, validateStringArray } from "./validators.mjs";

export const MARKER_SCHEMA_VERSION = 2;

export const MARKER_TYPES = new Set(["change", "phase", "outcome", "experiment-start", "experiment-end", "note"]);
export const OUTCOME_STATUSES = new Set(["successful", "partial", "failed", "abandoned", "unknown"]);
export const EXPECTED_DIRECTIONS = new Set(["increase", "decrease", "no-change"]);
export const TASK_CATEGORIES = new Set([
  "documentation", "ui", "bug-fix", "feature", "refactor", "build-tooling",
  "dependency-configuration", "investigation", "unknown",
]);
export const TASK_CATEGORY_SOURCES = new Set(["explicit", "inferred"]);

const ALLOWED_FIELDS = [
  "schema", "marker_id", "ts", "type", "title", "description", "repo", "branch", "sha",
  "config_snapshot_id", "packages", "skills", "tags", "metric", "expected_direction",
  "supersedes", "session_id", "phase", "status",
  "task_category", "task_category_source", "task_scale", "effective_at", "repository_id", "scope", "watching_kinds", "finding_id",
];

const TASK_SCALE_FIELDS = ["files_touched", "directories_touched", "insertions", "deletions", "cross_cutting", "surface"];
const TASK_SCALE_SURFACES = new Set(["code", "configuration", "documentation", "generated", "mixed", "unknown"]);

export function generateMarkerId() {
  return generateId("mark");
}

// Throws with a descriptive message on the first structural problem found. Callers that need to
// report every problem at once (e.g. a CLI batch import) should catch per-record.
export function validateMarker(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) throw new Error("marker must be an object");
  validateObjectKeys(marker, ALLOWED_FIELDS, "marker");
  if (![1, MARKER_SCHEMA_VERSION].includes(marker.schema)) throw new Error(`unsupported marker schema version: ${marker.schema}`);
  if (!isValidId(marker.marker_id, "mark")) throw new Error(`invalid marker_id: ${marker.marker_id}`);
  if (typeof marker.ts !== "string" || Number.isNaN(Date.parse(marker.ts))) throw new Error("marker ts must be an ISO timestamp");
  if (!MARKER_TYPES.has(marker.type)) throw new Error(`unknown marker type: ${marker.type}`);
  if (typeof marker.title !== "string" || !marker.title.trim()) throw new Error("marker title is required");
  if (marker.description != null && typeof marker.description !== "string") throw new Error("marker description must be a string");
  if (marker.repo != null && typeof marker.repo !== "string") throw new Error("marker repo must be a string");
  if (marker.branch != null && typeof marker.branch !== "string") throw new Error("marker branch must be a string");
  if (marker.sha != null && typeof marker.sha !== "string") throw new Error("marker sha must be a string");
  // Snapshot IDs are content-addressed hashes (see snapshot-schema.mjs computeSnapshotId), not
  // generic generateId() ids — 24 hex chars, not 16 — so they need their own format check.
  if (marker.config_snapshot_id != null && !/^cfg_[a-f0-9]{24}$/.test(marker.config_snapshot_id)) {
    throw new Error(`invalid marker config_snapshot_id: ${marker.config_snapshot_id}`);
  }
  validateStringArray(marker.packages, "marker packages");
  validateStringArray(marker.skills, "marker skills");
  validateStringArray(marker.tags, "marker tags");
  if (marker.metric != null && typeof marker.metric !== "string") throw new Error("marker metric must be a string");
  if (marker.expected_direction != null && !EXPECTED_DIRECTIONS.has(marker.expected_direction)) {
    throw new Error(`unknown marker expected_direction: ${marker.expected_direction}`);
  }
  if (marker.supersedes != null && !isValidId(marker.supersedes, "mark")) {
    throw new Error(`invalid marker supersedes id: ${marker.supersedes}`);
  }
  if (marker.session_id != null && typeof marker.session_id !== "string") throw new Error("marker session_id must be a string");
  if (marker.type === "outcome") {
    if (!OUTCOME_STATUSES.has(marker.status)) throw new Error(`outcome marker requires a valid status, got: ${marker.status}`);
  } else if (marker.status != null) {
    throw new Error("marker status is only valid on outcome markers");
  }
  if (marker.type === "phase") {
    if (typeof marker.phase !== "string" || !marker.phase.trim()) throw new Error("phase marker requires a non-empty phase");
  } else if (marker.phase != null) {
    throw new Error("marker phase is only valid on phase markers");
  }
  if (marker.task_category != null || marker.task_category_source != null || marker.task_scale != null) {
    if (marker.type !== "outcome") throw new Error("marker task_category/task_scale are only valid on outcome markers");
  }
  if (marker.task_category != null) {
    if (!TASK_CATEGORIES.has(marker.task_category)) throw new Error(`unknown marker task_category: ${marker.task_category}`);
    if (!TASK_CATEGORY_SOURCES.has(marker.task_category_source)) {
      throw new Error(`marker task_category requires a valid task_category_source, got: ${marker.task_category_source}`);
    }
  } else if (marker.task_category_source != null) {
    throw new Error("marker task_category_source requires task_category");
  }
  if (marker.task_scale != null) validateTaskScale(marker.task_scale);
  if (marker.schema === 2) {
    if (typeof marker.effective_at !== "string" || !Number.isFinite(Date.parse(marker.effective_at))) throw new Error("marker effective_at must be an ISO timestamp");
    if (!["repository", "all", "unknown"].includes(marker.scope)) throw new Error("marker scope must be repository, all, or unknown");
    if (marker.scope === "repository" && (typeof marker.repository_id !== "string" || !/^(git|local):/.test(marker.repository_id))) throw new Error("repository marker requires canonical repository_id");
    if (marker.scope !== "repository" && marker.repository_id != null) throw new Error("repository_id requires repository scope");
    validateStringArray(marker.watching_kinds, "marker watching_kinds");
    if (!Array.isArray(marker.watching_kinds) || marker.watching_kinds.some((kind) => !["spike", "loop", "read-warning", "over-testing"].includes(kind))) throw new Error("invalid watching_kinds");
    if (marker.finding_id != null && typeof marker.finding_id !== "string") throw new Error("finding_id must be a string");
  }
  return marker;
}

// Explainable scope dimensions for a completed task. Never guessed beyond what
// git/changed-file signals directly support — unknown fields stay null rather than being estimated.
function validateTaskScale(scale) {
  if (typeof scale !== "object" || Array.isArray(scale)) throw new Error("marker task_scale must be an object");
  validateObjectKeys(scale, TASK_SCALE_FIELDS, "marker task_scale");
  for (const field of ["files_touched", "directories_touched", "insertions", "deletions"]) {
    if (scale[field] != null && (!Number.isInteger(scale[field]) || scale[field] < 0)) {
      throw new Error(`marker task_scale.${field} must be a non-negative integer`);
    }
  }
  if (scale.cross_cutting != null && typeof scale.cross_cutting !== "boolean") {
    throw new Error("marker task_scale.cross_cutting must be a boolean");
  }
  if (scale.surface != null && !TASK_SCALE_SURFACES.has(scale.surface)) {
    throw new Error(`unknown marker task_scale.surface: ${scale.surface}`);
  }
}
