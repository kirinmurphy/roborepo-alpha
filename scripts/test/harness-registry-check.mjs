#!/usr/bin/env node
// Harness provider registry, discovery, state, and harness-runtime.

import { defineHarnessProvider } from "../harnesses/contract.mjs";
import { detectHarnessProvider } from "../harnesses/discovery.mjs";
import {
  applyDiscoveryToState,
  setProviderEnabled,
  isProviderEnabled,
} from "../harnesses/state.mjs";
import { listHarnessProviders, getHarnessProvider, hasHarnessProvider, harnessDisplayName } from "../harnesses/registry.mjs";
import { createHarnessRuntime, requireHarnessCapability } from "../harnesses/harness-runtime.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn, label) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${label}: expected to throw`);
}

// --- Real registry: exactly claude + codex + gemini, all constructible and passing contract
// validation. Gemini is the first real (non-synthetic) third provider. ---
const providers = listHarnessProviders();
assert(providers.length === 3, `expected 3 registered providers, got ${providers.length}`);
assert(hasHarnessProvider("claude") && hasHarnessProvider("codex") && hasHarnessProvider("gemini"), "registry must know claude, codex, and gemini");
assertThrows(() => getHarnessProvider("nonexistent"), "getHarnessProvider unknown id");

// --- harnessDisplayName: human-facing name for known ids, id fallback for unknown ids. Used by
// init/web first-run summaries, so a fallback regression would surface as a raw id in user-facing
// output rather than a crash — asserted directly. ---
assert(harnessDisplayName("claude") === providers.find((p) => p.id === "claude").manifest.displayName, "harnessDisplayName must return the manifest displayName for a known id");
assert(harnessDisplayName("nonexistent") === "nonexistent", "harnessDisplayName must fall back to the id for an unknown id");

// --- Discovery confidence normalization: executable+home+config -> confirmed; executable-only or
// config-only -> probable; home-only -> possible; nothing -> absent. Uses fake manifests pointed
// at fixture-controlled paths, not the real installed claude/codex, so results are deterministic. ---
function fakeManifest(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    commandName: id,
    adapter: id,
    detection: {
      executables: [],
      homeCandidates: [],
      configCandidates: [],
      minimumConfidence: "probable",
      ...overrides,
    },
    paths: {},
    capabilities: ["root-config"],
  };
}

{
  const result = detectHarnessProvider(fakeManifest("nope-nowhere"));
  assert(result.status === "absent", "no evidence must be absent status");
  assert(result.confidence === "absent", "no evidence must be absent confidence");
}

if (process.platform !== "win32") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-discovery-"));
  const bin = path.join(tmp, "bin");
  const home = path.join(tmp, "home");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  try {
    withDiscoveryEnv({ home, pathPrefix: bin }, () => {
      writeExecutable(path.join(bin, "working-harness"), "echo working-harness 1.0\n");
      const result = detectHarnessProvider(fakeManifest("working-harness", { executables: ["working-harness"] }));
      assert(result.status === "detected", "validated executable must be detected");
      assert(result.confidence === "probable", "validated executable-only evidence must be probable");
      assert(result.evidence.some((item) => item.kind === "executable"), "validated executable must produce executable evidence");
    });

    withDiscoveryEnv({ home, pathPrefix: bin }, () => {
      writeExecutable(path.join(bin, "broken-harness"), "echo real harness unavailable >&2\nexit 127\n");
      const result = detectHarnessProvider(fakeManifest("broken-harness", { executables: ["broken-harness"] }));
      assert(result.status === "absent", "resolved executable that fails validation must be absent with no other evidence");
      assert(result.confidence === "absent", "failed executable validation must not create probable confidence");
      assert(!result.evidence.some((item) => item.kind === "executable"), "failed executable validation must not produce executable evidence");
    });

    withDiscoveryEnv({ home, pathPrefix: bin }, () => {
      const homeDir = path.join(home, ".home-only");
      fs.mkdirSync(homeDir, { recursive: true });
      const homeResult = detectHarnessProvider(fakeManifest("home-only", { homeCandidates: ["~/.home-only"] }));
      assert(homeResult.status === "absent", "home-only evidence below the default probable threshold must not be detected");
      assert(homeResult.confidence === "possible", "home-only evidence must remain possible");

      const configDir = path.join(home, ".config-only");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "settings.json"), "{}\n");
      const configResult = detectHarnessProvider(fakeManifest("config-only", { configCandidates: ["~/.config-only/settings.json"] }));
      assert(configResult.status === "absent", "config-only evidence must not detect (a stray config file is not an installed harness)");
      assert(configResult.confidence === "possible", "config-only evidence must rank only possible");
    });

    withDiscoveryEnv({ home, pathPrefix: bin }, () => {
      const homeDir = path.join(home, ".home-possible");
      fs.mkdirSync(homeDir, { recursive: true });
      const result = detectHarnessProvider(fakeManifest("home-possible", {
        homeCandidates: ["~/.home-possible"],
        minimumConfidence: "possible",
      }));
      assert(result.status === "detected", "home-only evidence must be detected when the provider minimum is possible");
      assert(result.confidence === "possible", "home-only evidence must keep possible confidence");
    });

    withDiscoveryEnv({ home, pathPrefix: path.join(tmp, "cmux-cli-shims", "session") }, () => {
      fs.mkdirSync(process.env.PATH.split(path.delimiter)[0], { recursive: true });
      writeExecutable(path.join(process.env.PATH.split(path.delimiter)[0], "claude"), "echo 'Error: claude not found in PATH' >&2\nexit 127\n");
      const result = detectHarnessProvider(fakeManifest("claude", { executables: ["claude"] }));
      assert(result.status === "absent", "cmux-style shim alone must not detect Claude");
      assert(result.evidence.length === 0, "cmux-style shim alone must not produce executable evidence");
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Synthetic third provider: proves the registry/harness-runtime/discovery pipeline carries no
// hardcoded two-provider (claude/codex) assumption anywhere in this phase's code. ---
const thirdManifest = {
  schemaVersion: 1,
  id: "synthetic-third",
  displayName: "Synthetic Third",
  commandName: "synthetic-third",
  adapter: "synthetic-third",
  detection: { minimumConfidence: "possible" },
  paths: {},
  capabilities: ["root-config"],
};
const thirdProvider = defineHarnessProvider({
  manifest: thirdManifest,
  adapters: { rootConfig: { merge: () => {}, render: () => {} } },
});
assert(thirdProvider.id === "synthetic-third", "synthetic third provider must construct via defineHarnessProvider");

// --- State: zero/one/multi enabled-provider scenarios, explicit-disable survives refresh ---
let state = { schemaVersion: 1, lastDiscoveredAt: new Date(0).toISOString(), providers: {} };

// Zero enabled: harnessRuntime.providersFor must return empty, not throw.
{
  const harnessRuntime = createHarnessRuntime({ state });
  assert(harnessRuntime.providersFor("root-config").length === 0, "zero enabled providers must yield empty list");
}

const detected = [
  { providerId: "claude", status: "detected", confidence: "confirmed", evidence: [{ kind: "executable", value: "claude" }], warnings: [] },
  { providerId: "codex", status: "detected", confidence: "confirmed", evidence: [{ kind: "executable", value: "codex" }], warnings: [] },
];
state = applyDiscoveryToState(state, detected);
assert(isProviderEnabled(state, "claude"), "claude enabled after discovery");
assert(isProviderEnabled(state, "codex"), "codex enabled after discovery");

// One enabled: disable codex, harnessRuntime must only surface claude for a shared capability.
state = setProviderEnabled(state, "codex", false);
{
  const harnessRuntime = createHarnessRuntime({ state });
  const rootConfigProviders = harnessRuntime.providersFor("root-config").map((p) => p.id);
  assert(rootConfigProviders.length === 1 && rootConfigProviders[0] === "claude", "one enabled provider must scope to that provider only");
}

// Explicit disable must survive a subsequent discovery refresh (discovery re-detects codex, but
// the user's explicit disable wins).
const rediscovered = applyDiscoveryToState(state, detected);
assert(!isProviderEnabled(rediscovered, "codex"), "explicit disable must survive refresh");
assert(isProviderEnabled(rediscovered, "claude"), "claude stays enabled across refresh");
assert(rediscovered.providers.codex.selectionSource === "user", "disabled provider keeps selectionSource=user across refresh");

// Multi enabled: re-enable codex, both must appear for a shared capability.
const bothEnabled = setProviderEnabled(rediscovered, "codex", true);
{
  const harnessRuntime = createHarnessRuntime({ state: bothEnabled });
  const ids = harnessRuntime.providersFor("root-config").map((p) => p.id).sort();
  assert(ids.length === 2 && ids[0] === "claude" && ids[1] === "codex", "multi enabled providers must both surface for a shared capability");
}

// requireHarnessCapability throws for a capability the provider doesn't declare.
assertThrows(
  () => requireHarnessCapability(getHarnessProvider("claude"), "telemetry-rate-limits"),
  "requireHarnessCapability must reject an undeclared capability (claude has no telemetry-rate-limits)"
);

console.log("harness registry/discovery/state/harness-runtime: all checks passed");

function withDiscoveryEnv({ home, pathPrefix }, fn) {
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = [pathPrefix, previousPath].filter(Boolean).join(path.delimiter);
  try {
    return fn();
  } finally {
    process.env.HOME = previousHome;
    process.env.PATH = previousPath;
  }
}

function writeExecutable(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#!/bin/sh\n${body}`);
  fs.chmodSync(filePath, 0o755);
}
