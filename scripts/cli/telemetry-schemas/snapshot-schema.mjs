import { privacyHash } from "./hash.mjs";
import { validateObjectKeys, validateStringArray } from "./validators.mjs";
import { hasHarnessProvider } from "../../harnesses/registry.mjs";

export const SNAPSHOT_SCHEMA_VERSION = 2;

const ALLOWED_FIELDS = [
  "schema", "snapshot_id", "created_at", "app_version", "harness", "harness_version",
  "model", "packages", "rules", "skills", "hooks", "commands", "feature_flags", "unavailable", "ambient", "evaluability", "revision_contract",
];

// Content-addressed: the ID is a hash of the normalized fields, so two sessions with identical
// effective configuration collapse to one stored snapshot. `created_at` and `harness`/`model`
// (session-specific, not configuration-specific) are excluded from the v1 hash.
// v2 includes provider coverage and ambient evidence, while still excluding model/creation time.
export function computeSnapshotId(snapshot) {
  const material = JSON.stringify({
    ...(snapshot.schema === 2 ? { schema: 2, unavailable: snapshot.unavailable, ambient: snapshot.ambient, evaluability: snapshot.evaluability, revision_contract: snapshot.revision_contract } : {}),
    app_version: snapshot.app_version ?? null,
    packages: [...(snapshot.packages || [])].sort(),
    rules: [...(snapshot.rules || [])].sort(),
    skills: [...(snapshot.skills || [])].sort(),
    hooks: snapshot.hooks || {},
    commands: snapshot.commands || {},
    feature_flags: snapshot.feature_flags || {},
  });
  return `cfg_${privacyHash(material)}`;
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("snapshot must be an object");
  validateObjectKeys(snapshot, ALLOWED_FIELDS, "snapshot");
  if (![1, SNAPSHOT_SCHEMA_VERSION].includes(snapshot.schema)) throw new Error(`unsupported snapshot schema version: ${snapshot.schema}`);
  if (typeof snapshot.snapshot_id !== "string" || !/^cfg_[a-f0-9]{24}$/.test(snapshot.snapshot_id)) {
    throw new Error(`invalid snapshot_id: ${snapshot.snapshot_id}`);
  }
  if (typeof snapshot.created_at !== "string" || Number.isNaN(Date.parse(snapshot.created_at))) {
    throw new Error("snapshot created_at must be an ISO timestamp");
  }
  if (snapshot.app_version != null && typeof snapshot.app_version !== "string") throw new Error("snapshot app_version must be a string");
  if (snapshot.harness != null && snapshot.harness !== "unknown" && !hasHarnessProvider(snapshot.harness)) throw new Error(`unknown snapshot harness: ${snapshot.harness}`);
  if (snapshot.harness_version != null && typeof snapshot.harness_version !== "string") throw new Error("snapshot harness_version must be a string");
  if (snapshot.model != null && typeof snapshot.model !== "string") throw new Error("snapshot model must be a string");
  validateStringArray(snapshot.packages, "snapshot packages");
  validateStringArray(snapshot.rules, "snapshot rules");
  validateStringArray(snapshot.skills, "snapshot skills");
  if (snapshot.hooks != null && (typeof snapshot.hooks !== "object" || Array.isArray(snapshot.hooks))) {
    throw new Error("snapshot hooks must be an object");
  }
  if (snapshot.commands != null && (typeof snapshot.commands !== "object" || Array.isArray(snapshot.commands))) {
    throw new Error("snapshot commands must be an object");
  }
  if (snapshot.feature_flags != null && (typeof snapshot.feature_flags !== "object" || Array.isArray(snapshot.feature_flags))) {
    throw new Error("snapshot feature_flags must be an object");
  }
  validateStringArray(snapshot.unavailable, "snapshot unavailable");
  if (snapshot.schema === 2) {
    if (snapshot.revision_contract !== 1) throw new Error("snapshot revision_contract must be 1");
    if (!snapshot.evaluability || typeof snapshot.evaluability.packages !== "boolean" || typeof snapshot.evaluability.skills !== "boolean") throw new Error("snapshot evaluability is required");
    if (!snapshot.ambient || typeof snapshot.ambient.evaluable !== "boolean" || !Array.isArray(snapshot.ambient.packages)) throw new Error("snapshot ambient evidence is required");
    if (snapshot.ambient.evaluable && (typeof snapshot.ambient.hash !== "string" || !snapshot.ambient.harness)) throw new Error("evaluable ambient evidence requires hash and harness");
  }
  return snapshot;
}

// Builds a snapshot from readConfigSnapshot()'s output plus session-supplied harness/model. Known
// gaps in readConfigSnapshot (full hook command strings, MCP server registration detail, parsed
// Codex config.toml) are recorded in `unavailable` rather than guessed; readConfigSnapshot does
// not read them today.
export function buildEffectiveSnapshot(configSnapshot, { harness = null, harnessVersion = null, model = null, appVersion = null } = {}) {
  const enabledPackageIds = (configSnapshot.packages || []).filter((pkg) => pkg.enabled).map((pkg) => pkg.id);
  const installedSkillIds = (configSnapshot.tools || []).filter((tool) => tool.installed).map((tool) => tool.id);
  const hookCounts = { ...(configSnapshot.globals?.settings?.hooks || {}) };

  const unavailable = ["hook_command_strings", "mcp_server_registration", "rules", "commands", "feature_flags"];
  if (harness === "codex") unavailable.push("codex_config_toml_parsed");

  const ambientTypes = new Set(["rules", "hooks", "permissions", "codex_tool_approvals", "mcp", "plugin", "harness-config", "service", "runtime-asset"]);
  const packages = configSnapshot.packages || [];
  const ambientPackages = packages.filter((pkg) => pkg.enabled && (pkg.resources || []).some((type) => ambientTypes.has(type)))
    .map((pkg) => ({ id: pkg.id, resources: [...new Set(pkg.resources.filter((type) => ambientTypes.has(type)))].sort() })).sort((a, b) => a.id.localeCompare(b.id));
  const ambientEvaluable = !!harness && Array.isArray(configSnapshot.packages) && packages.every((pkg) => Array.isArray(pkg.resources));
  const ambient = { harness, evaluable: ambientEvaluable, packages: ambientPackages,
    hash: ambientEvaluable ? privacyHash(JSON.stringify({ harness, packages: ambientPackages })) : null,
    scope: "configured-package-resource-types" };
  const snapshot = {
    schema: SNAPSHOT_SCHEMA_VERSION,
    ambient,
    evaluability: { packages: Array.isArray(configSnapshot.packages), skills: Array.isArray(configSnapshot.tools) },
    revision_contract: 1,
    created_at: new Date().toISOString(),
    app_version: appVersion,
    harness,
    harness_version: harnessVersion,
    model,
    packages: enabledPackageIds,
    rules: [],
    skills: installedSkillIds,
    hooks: hookCounts,
    commands: {},
    feature_flags: {},
    unavailable,
  };
  snapshot.snapshot_id = computeSnapshotId(snapshot);
  return validateSnapshot(snapshot);
}
