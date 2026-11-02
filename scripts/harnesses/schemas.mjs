// Shape references and validators for discovery results and persisted harness state.
// These are runtime-produced/consumed shapes (not authored manifests), so they are documented and
// validated here rather than as JSON Schema files. Pair with contract.mjs for the provider manifest
// itself and provider-manifest.schema.json for its JSON Schema.

const EVIDENCE_KINDS = new Set(["executable", "home", "config"]);
const DISCOVERY_STATUSES = new Set(["detected", "absent"]);
const DISCOVERY_CONFIDENCES = new Set(["confirmed", "probable", "possible", "absent"]);
const SELECTION_SOURCES = new Set(["discovery", "user", "migration"]);

/**
 * @typedef {object} DiscoveryEvidence
 * @property {"executable"|"home"|"config"} kind
 * @property {string} value
 * @property {string} [resolvedPath]
 * @property {"cli"|"desktop"} [source] Required for executable evidence.
 * @property {string} [version] Required for executable evidence.
 */

/**
 * @typedef {object} DiscoveryResult
 * @property {string} providerId
 * @property {"detected"|"absent"} status
 * @property {"confirmed"|"probable"|"possible"|"absent"} confidence
 * @property {DiscoveryEvidence[]} evidence
 * @property {string[]} warnings
 */

export function validateDiscoveryResult(result) {
  const errors = [];
  const label = result && typeof result.providerId === "string" ? `discovery result "${result.providerId}"` : "discovery result";

  if (typeof result !== "object" || result === null) {
    throw new Error("discovery result must be an object");
  }
  if (typeof result.providerId !== "string" || result.providerId.trim() === "") {
    errors.push(`${label} providerId is required`);
  }
  if (!DISCOVERY_STATUSES.has(result.status)) {
    errors.push(`${label} status must be one of ${[...DISCOVERY_STATUSES].join(", ")}`);
  }
  if (!DISCOVERY_CONFIDENCES.has(result.confidence)) {
    errors.push(`${label} confidence must be one of ${[...DISCOVERY_CONFIDENCES].join(", ")}`);
  }
  if (!Array.isArray(result.evidence)) {
    errors.push(`${label} evidence must be an array`);
  } else {
    for (const [index, item] of result.evidence.entries()) {
      if (typeof item !== "object" || item === null || !EVIDENCE_KINDS.has(item.kind) || typeof item.value !== "string") {
        errors.push(`${label} evidence[${index}] must have a known kind and a string value`);
      } else if (item.kind === "executable" && (typeof item.resolvedPath !== "string" || !["cli", "desktop"].includes(item.source) || typeof item.version !== "string")) {
        errors.push(`${label} evidence[${index}] executable must have a path, source, and version`);
      }
    }
  }
  if (result.warnings !== undefined && !Array.isArray(result.warnings)) {
    errors.push(`${label} warnings must be an array when present`);
  }

  if (errors.length > 0) throw new Error(`invalid discovery result:\n  ${errors.join("\n  ")}`);
}

/**
 * @typedef {object} PersistedProviderState
 * @property {boolean} enabled
 * @property {"discovery"|"user"|"migration"} selectionSource
 * @property {"confirmed"|"probable"|"possible"|"absent"} confidence
 * @property {DiscoveryEvidence[]} evidence
 * @property {string[]} warnings
 */

/**
 * @typedef {object} HarnessState
 * @property {2} schemaVersion
 * @property {string} lastDiscoveredAt ISO 8601 timestamp
 * @property {Record<string, PersistedProviderState>} providers
 */

export function validateHarnessState(state) {
  const errors = [];

  if (typeof state !== "object" || state === null) {
    throw new Error("harness state must be an object");
  }
  if (state.schemaVersion !== 2) errors.push("harness state schemaVersion must be 2");
  if (typeof state.lastDiscoveredAt !== "string" || Number.isNaN(Date.parse(state.lastDiscoveredAt))) {
    errors.push("harness state lastDiscoveredAt must be an ISO 8601 timestamp string");
  }
  if (typeof state.providers !== "object" || state.providers === null || Array.isArray(state.providers)) {
    errors.push("harness state providers must be an object keyed by provider id");
  } else {
    for (const [providerId, entry] of Object.entries(state.providers)) {
      const label = `harness state providers.${providerId}`;
      if (typeof entry !== "object" || entry === null) {
        errors.push(`${label} must be an object`);
        continue;
      }
      if (typeof entry.enabled !== "boolean") errors.push(`${label}.enabled must be a boolean`);
      if (!SELECTION_SOURCES.has(entry.selectionSource)) {
        errors.push(`${label}.selectionSource must be one of ${[...SELECTION_SOURCES].join(", ")}`);
      }
      if (!DISCOVERY_CONFIDENCES.has(entry.confidence)) {
        errors.push(`${label}.confidence must be one of ${[...DISCOVERY_CONFIDENCES].join(", ")}`);
      }
      if (!Array.isArray(entry.evidence)) errors.push(`${label}.evidence must be an array`);
      if (!Array.isArray(entry.warnings) || entry.warnings.some((warning) => typeof warning !== "string")) {
        errors.push(`${label}.warnings must be an array of strings`);
      }
    }
  }

  if (errors.length > 0) throw new Error(`invalid harness state:\n  ${errors.join("\n  ")}`);
}

/**
 * @typedef {object} AdapterActionResult A "write-and-report" adapter method's return shape — one
 *   that performs (or dry-run-previews) its own side effect and reports what happened. Used by
 *   e.g. mcp.addServer/removeServer/remove, hooks.write. Distinct from AdapterComputeResult below,
 *   which a "compute-only" method returns for the orchestrator to write.
 * @property {boolean} ok
 * @property {boolean} changed
 * @property {string} providerId
 * @property {string} action
 * @property {string[]} paths
 * @property {string[]} warnings
 * @property {"unsupported"|"degraded"} [status] Present only when the operation could not fully
 *   complete for this provider — e.g. Codex has no direct equivalent for a Claude-only permission.
 * @property {number} [exitStatus] On `ok: false` from a method that shells out (Claude's
 *   mcp.addServer), the external CLI's exit status, for a terminal caller that exits with it.
 */

export function validateAdapterActionResult(result) {
  const errors = [];
  const label = result && typeof result.providerId === "string" ? `adapter result "${result.providerId}"` : "adapter result";

  if (typeof result !== "object" || result === null) {
    throw new Error("adapter action result must be an object");
  }
  if (typeof result.ok !== "boolean") errors.push(`${label} ok must be a boolean`);
  if (typeof result.changed !== "boolean") errors.push(`${label} changed must be a boolean`);
  if (typeof result.providerId !== "string" || result.providerId.trim() === "") errors.push(`${label} providerId is required`);
  if (typeof result.action !== "string" || result.action.trim() === "") errors.push(`${label} action is required`);
  if (!Array.isArray(result.paths)) errors.push(`${label} paths must be an array`);
  if (!Array.isArray(result.warnings)) errors.push(`${label} warnings must be an array`);
  if (result.status !== undefined && result.status !== "unsupported" && result.status !== "degraded") {
    errors.push(`${label} status must be "unsupported" or "degraded" when present`);
  }

  if (errors.length > 0) throw new Error(`invalid adapter action result:\n  ${errors.join("\n  ")}`);
}

/**
 * @typedef {object} AdapterComputeResult A "compute-only" adapter method's return shape — no file
 *   I/O, no path resolution; the caller (an orchestrator that already sits above the harness
 *   registry in the dependency graph, e.g. hook-composition.mjs, package-harness-config.mjs,
 *   mcp.mjs) performs the actual write via writeRootConfig or a plain file write. Used by e.g.
 *   rootConfig.merge{,PackageComponent}, hooks.merge/unmerge, mcp.addServer/removeServer (the
 *   config-file-backed providers' single-server shape, as opposed to Claude's CLI-shell-out
 *   AdapterActionResult shape for the same capability).
 * @property {boolean} changed
 * @property {string} [content] Omitted when the method reports {changed:false} without computing
 *   new content (e.g. removing a server that was never present).
 */

export function validateAdapterComputeResult(result) {
  const errors = [];
  if (typeof result !== "object" || result === null) {
    throw new Error("adapter compute result must be an object");
  }
  if (typeof result.changed !== "boolean") errors.push("adapter compute result changed must be a boolean");
  if (result.content !== undefined && typeof result.content !== "string") {
    errors.push("adapter compute result content must be a string when present");
  }
  if (errors.length > 0) throw new Error(`invalid adapter compute result:\n  ${errors.join("\n  ")}`);
}
