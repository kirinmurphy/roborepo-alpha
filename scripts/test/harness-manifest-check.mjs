#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  HARNESS_CAPABILITIES,
  CAPABILITY_REQUIRED_METHODS,
  validateProviderManifest,
  validateCapabilityAdapters,
  defineHarnessProvider,
} from "../harnesses/contract.mjs";
import {
  validateDiscoveryResult,
  validateHarnessState,
  validateAdapterActionResult,
} from "../harnesses/schemas.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn, messageFragment, label) {
  try {
    fn();
  } catch (err) {
    assert(err.message.includes(messageFragment), `${label}: expected error to include "${messageFragment}", got: ${err.message}`);
    return;
  }
  throw new Error(`${label}: expected to throw`);
}

const fixturesDir = path.resolve("scripts/test/fixtures/harnesses");
function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
}

// Real app-owned manifests must validate cleanly.
validateProviderManifest(loadFixture("valid-claude.json"));
validateProviderManifest(loadFixture("valid-codex.json"));
validateProviderManifest(loadFixture("valid-gemini.json"));
validateProviderManifest(loadFixture("valid-with-extensions.json"));
assert(true, "app-owned manifests validate");

// Every capability referenced by the fixtures must be a known capability.
for (const file of ["valid-claude.json", "valid-codex.json", "valid-gemini.json"]) {
  const manifest = loadFixture(file);
  for (const capability of manifest.capabilities) {
    assert(HARNESS_CAPABILITIES.includes(capability), `${file}: capability "${capability}" missing from HARNESS_CAPABILITIES`);
  }
}

// Every declared capability has a required-method mapping (contract completeness).
for (const capability of HARNESS_CAPABILITIES) {
  assert(CAPABILITY_REQUIRED_METHODS[capability], `capability "${capability}" has no entry in CAPABILITY_REQUIRED_METHODS`);
}

assertThrows(() => validateProviderManifest(loadFixture("invalid-id.json")), "id must be a lowercase slug", "invalid-id fixture");
assertThrows(() => validateProviderManifest(loadFixture("invalid-capability.json")), "unknown capability: time-travel", "invalid-capability fixture");

// missing-adapter-binding.json is a structurally valid manifest; the missing binding only surfaces
// once its declared capabilities are checked against an incomplete adapter object.
const missingAdapterManifest = loadFixture("missing-adapter-binding.json");
validateProviderManifest(missingAdapterManifest);
assertThrows(
  () => validateCapabilityAdapters(missingAdapterManifest.capabilities, { rootConfig: { merge() {}, render() {} } }),
  'adapters.hooks to be an object',
  "missing-adapter-binding fixture",
);

// Unknown top-level keys are rejected.
assertThrows(
  () => validateProviderManifest({ ...loadFixture("valid-claude.json"), unknownField: true }),
  "unknown top-level key: unknownField",
  "unknown top-level key",
);

// defineHarnessProvider wires manifest + adapter validation together and freezes the result.
const completeAdapters = {
  rootConfig: { merge() {}, render() {}, mergePackageComponent() {}, unmergePackageComponent() {} },
  rules: { render() {} },
  permissions: { render() {} },
  skills: { link() {} },
  commands: { render() {} },
  hooks: { read() {}, write() {}, merge() {}, unmerge() {} },
  mcp: { add() {}, remove() {}, addServer() {}, removeServer() {}, list() {} },
  telemetry: { wireCaptureHooks() {} },
  transcripts: { locate() {}, parse() {} },
  session: { launch() {} },
};
const claudeManifest = loadFixture("valid-claude.json");
const provider = defineHarnessProvider({ manifest: claudeManifest, adapters: completeAdapters });
assert(provider.id === "claude", "defineHarnessProvider returns the manifest id");
assert(Object.isFrozen(provider), "defineHarnessProvider freezes the returned provider");
assertThrows(
  () => defineHarnessProvider({ manifest: claudeManifest, adapters: { rootConfig: { merge() {} } } }),
  "requires adapters.",
  "defineHarnessProvider with incomplete adapters",
);

// Discovery result, harness state, and adapter action result shapes.
validateDiscoveryResult({
  providerId: "claude",
  status: "detected",
  confidence: "confirmed",
  evidence: [{ kind: "executable", value: "claude", resolvedPath: "/usr/local/bin/claude" }],
  warnings: [],
});
assertThrows(
  () => validateDiscoveryResult({ providerId: "claude", status: "installed", confidence: "confirmed", evidence: [] }),
  "status must be one of",
  "discovery result with bad status",
);

validateHarnessState({
  schemaVersion: 1,
  lastDiscoveredAt: new Date().toISOString(),
  providers: {
    claude: { enabled: true, selectionSource: "discovery", confidence: "confirmed", evidence: [] },
    codex: { enabled: true, selectionSource: "user", confidence: "probable", evidence: [] },
  },
});
assertThrows(
  () => validateHarnessState({ schemaVersion: 1, lastDiscoveredAt: "not-a-date", providers: {} }),
  "lastDiscoveredAt must be an ISO 8601 timestamp",
  "harness state with bad timestamp",
);

validateAdapterActionResult({
  ok: true,
  changed: true,
  providerId: "codex",
  action: "merge-package-config",
  paths: ["~/.codex/config.toml"],
  warnings: [],
});
validateAdapterActionResult({
  ok: true,
  changed: false,
  providerId: "codex",
  action: "render-permission",
  paths: [],
  warnings: [],
  status: "unsupported",
});
// degraded: the provider applied a partial/best-effort equivalent rather than the exact requested
// behavior (e.g. no native concept for one allow/ask/deny mode) -- distinct from unsupported (did
// nothing) and from the no-status case (fully applied as requested).
validateAdapterActionResult({
  ok: true,
  changed: true,
  providerId: "codex",
  action: "render-permission",
  paths: ["~/.codex/config.toml"],
  warnings: ["codex has no native \"ask\" mode; applied as \"allow\" instead"],
  status: "degraded",
});
assertThrows(
  () => validateAdapterActionResult({ ok: true, changed: true, providerId: "codex", action: "x", paths: [], warnings: [], status: "broken" }),
  'status must be "unsupported" or "degraded"',
  "adapter action result with bad status",
);

console.log("ok: harness manifest and schema checks passed");
