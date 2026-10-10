// Capability vocabulary and provider-manifest validation shared by every harness provider.
// This file is data + structural validation only — it does not import or execute any provider
// adapter. See provider-manifest.schema.json for the schema this validator enforces.

export const HARNESS_CAPABILITIES = Object.freeze([
  "root-config",
  "rules",
  "permissions",
  "skills",
  "slash-commands",
  "hooks",
  "mcp",
  "package-config",
  "telemetry-capture",
  "telemetry-rate-limits",
  "telemetry-transcripts",
  "session-launch",
  "session-resume",
]);

const CAPABILITY_SET = new Set(HARNESS_CAPABILITIES);

// Each declared capability requires the adapter group to exist and expose these method names.
// A provider that declares a capability without the matching methods fails validation rather than
// silently no-opping at call time.
export const CAPABILITY_REQUIRED_METHODS = Object.freeze({
  "root-config": { group: "rootConfig", methods: ["merge", "render"] },
  rules: { group: "rules", methods: ["render"] },
  permissions: { group: "permissions", methods: ["render"] },
  skills: { group: "skills", methods: ["link"] },
  "slash-commands": { group: "commands", methods: ["render"] },
  // read/write: withdraw's blanket strip-all (see harness withdraw <id>). merge/unmerge:
  // one package's hooks fragment added/removed during package install/disable. Four
  // separate names on purpose — "write" was already claimed by withdraw's removal-only semantics
  // first, so reusing it for a generic install-time merge would make one name mean two
  // different operations depending on caller.
  hooks: { group: "hooks", methods: ["read", "write", "merge", "unmerge"] },
  // add/remove: bulk operations (add = not yet migrated; remove = withdraw's "strip
  // every MCP server this package owns" sweep, real for Claude). addServer/removeServer/list:
  // single-server operations (add one server, remove one named server, enumerate
  // configured servers) -- separate names on purpose, same lesson as hooks' merge/unmerge vs
  // write: "remove" was already claimed by bulk-removal semantics first, so reusing it
  // for a single-server op would make one name mean two different things depending on caller.
  mcp: { group: "mcp", methods: ["add", "remove", "addServer", "removeServer", "list"] },
  "package-config": { group: "rootConfig", methods: ["mergePackageComponent", "unmergePackageComponent"] },
  "telemetry-capture": { group: "telemetry", methods: ["wireCaptureHooks"] },
  "telemetry-rate-limits": { group: "telemetry", methods: ["parseRateLimits"] },
  "telemetry-transcripts": { group: "transcripts", methods: ["locate", "parse"] },
  "session-launch": { group: "session", methods: ["launch"] },
  "session-resume": { group: "session", methods: ["resume"] },
});

const PLATFORMS = new Set(["darwin", "linux", "win32"]);
const DETECTION_CONFIDENCES = new Set(["confirmed", "probable", "possible"]);
const PATH_KINDS = new Set(["file", "directory"]);
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const HOME_RELATIVE_PATTERN = /^~\//;

function fail(errors, message) {
  errors.push(message);
}

function validateDetection(detection, label, errors) {
  if (typeof detection !== "object" || detection === null || Array.isArray(detection)) {
    fail(errors, `${label} detection must be an object`);
    return;
  }
  if (!DETECTION_CONFIDENCES.has(detection.minimumConfidence)) {
    fail(errors, `${label} detection.minimumConfidence must be one of ${[...DETECTION_CONFIDENCES].join(", ")}`);
  }
  for (const key of ["executables", "homeCandidates", "configCandidates"]) {
    const value = detection[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      fail(errors, `${label} detection.${key} must be an array`);
      continue;
    }
    for (const entry of value) {
      if (typeof entry !== "string" || entry.trim() === "") {
        fail(errors, `${label} detection.${key} entries must be non-empty strings`);
      } else if (key !== "executables" && !HOME_RELATIVE_PATTERN.test(entry)) {
        fail(errors, `${label} detection.${key} entry must be home-relative (start with ~/): ${entry}`);
      }
    }
  }
  if (detection.executableValidation !== undefined) {
    const validation = detection.executableValidation;
    if (typeof validation !== "object" || validation === null || Array.isArray(validation)) {
      fail(errors, `${label} detection.executableValidation must be an object`);
    } else {
      for (const key of Object.keys(validation)) {
        if (key !== "args" && key !== "timeoutMs") {
          fail(errors, `${label} detection.executableValidation has unknown key: ${key}`);
        }
      }
      if (validation.args !== undefined) {
        if (!Array.isArray(validation.args)) {
          fail(errors, `${label} detection.executableValidation.args must be an array`);
        } else {
          for (const entry of validation.args) {
            if (typeof entry !== "string") {
              fail(errors, `${label} detection.executableValidation.args entries must be strings`);
            }
          }
        }
      }
      if (
        validation.timeoutMs !== undefined
        && (!Number.isInteger(validation.timeoutMs) || validation.timeoutMs < 1)
      ) {
        fail(errors, `${label} detection.executableValidation.timeoutMs must be a positive integer`);
      }
    }
  }
}

function validatePathMap(paths, label, errors) {
  if (typeof paths !== "object" || paths === null || Array.isArray(paths)) {
    fail(errors, `${label} paths must be an object`);
    return;
  }
  for (const [key, entry] of Object.entries(paths)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(errors, `${label} paths.${key} must be an object`);
      continue;
    }
    if (typeof entry.path !== "string" || !HOME_RELATIVE_PATTERN.test(entry.path)) {
      fail(errors, `${label} paths.${key}.path must be a home-relative string (start with ~/)`);
    }
    if (!PATH_KINDS.has(entry.kind)) {
      fail(errors, `${label} paths.${key}.kind must be one of ${[...PATH_KINDS].join(", ")}`);
    }
  }
}

// Structural validation of a provider manifest against provider-manifest.schema.json's rules.
// Throws with every problem found rather than failing on the first, since manifest authoring is
// batch work (fix the fixture, rerun) not an interactive form.
export function validateProviderManifest(manifest) {
  const errors = [];
  const label = manifest && typeof manifest.id === "string" ? `provider "${manifest.id}"` : "provider manifest";

  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("provider manifest must be an object");
  }

  if (manifest.schemaVersion !== 1) fail(errors, `${label} schemaVersion must be 1`);
  if (typeof manifest.id !== "string" || !ID_PATTERN.test(manifest.id)) {
    fail(errors, `${label} id must be a lowercase slug matching ${ID_PATTERN}`);
  }
  if (typeof manifest.displayName !== "string" || manifest.displayName.trim() === "") {
    fail(errors, `${label} displayName is required`);
  }
  if (typeof manifest.commandName !== "string" || manifest.commandName.trim() === "") {
    fail(errors, `${label} commandName is required`);
  }
  if (typeof manifest.adapter !== "string" || !ID_PATTERN.test(manifest.adapter)) {
    fail(errors, `${label} adapter must be a lowercase slug matching ${ID_PATTERN}`);
  }

  validateDetection(manifest.detection, label, errors);
  validatePathMap(manifest.paths, label, errors);

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    fail(errors, `${label} capabilities must be a non-empty array`);
  } else {
    const seen = new Set();
    for (const capability of manifest.capabilities) {
      if (!CAPABILITY_SET.has(capability)) {
        fail(errors, `${label} unknown capability: ${capability}`);
      } else if (seen.has(capability)) {
        fail(errors, `${label} duplicate capability: ${capability}`);
      }
      seen.add(capability);
    }
  }

  if (manifest.platforms !== undefined) {
    if (typeof manifest.platforms !== "object" || manifest.platforms === null || Array.isArray(manifest.platforms)) {
      fail(errors, `${label} platforms must be an object`);
    } else {
      for (const [platform, override] of Object.entries(manifest.platforms)) {
        if (!PLATFORMS.has(platform)) {
          fail(errors, `${label} unknown platform key: ${platform}`);
          continue;
        }
        if (override.detection !== undefined) validateDetection(override.detection, `${label} platforms.${platform}`, errors);
        if (override.paths !== undefined) validatePathMap(override.paths, `${label} platforms.${platform}`, errors);
      }
    }
  }

  const knownKeys = new Set(["$schema", "schemaVersion", "id", "displayName", "commandName", "adapter", "detection", "paths", "capabilities", "platforms", "extensions"]);
  for (const key of Object.keys(manifest)) {
    if (!knownKeys.has(key)) fail(errors, `${label} unknown top-level key: ${key}`);
  }

  if (errors.length > 0) {
    throw new Error(`invalid provider manifest:\n  ${errors.join("\n  ")}`);
  }
}

// Verifies a provider's executable adapter object actually implements every method its manifest's
// declared capabilities require. Adapter shape: { [group]: { [method]: fn, ... }, ... }.
export function validateCapabilityAdapters(capabilities, adapters) {
  const errors = [];
  for (const capability of capabilities) {
    const requirement = CAPABILITY_REQUIRED_METHODS[capability];
    if (!requirement) {
      fail(errors, `capability "${capability}" has no required-method mapping in CAPABILITY_REQUIRED_METHODS`);
      continue;
    }
    const group = adapters?.[requirement.group];
    if (typeof group !== "object" || group === null) {
      fail(errors, `capability "${capability}" requires adapters.${requirement.group} to be an object`);
      continue;
    }
    for (const method of requirement.methods) {
      if (typeof group[method] !== "function") {
        fail(errors, `capability "${capability}" requires adapters.${requirement.group}.${method} to be a function`);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`invalid capability adapters:\n  ${errors.join("\n  ")}`);
  }
}

export function defineHarnessProvider({ manifest, adapters }) {
  validateProviderManifest(manifest);
  validateCapabilityAdapters(manifest.capabilities, adapters);
  return Object.freeze({ id: manifest.id, manifest, adapters });
}
