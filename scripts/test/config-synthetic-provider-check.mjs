#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Prove the Config snapshot's
// `harnesses` list (grid columns, defaults popover) and root-config baseline/active path maps do
// not encode a two-provider assumption. Same subprocess-isolation technique as
// telemetry-synthetic-provider-check.mjs (registry.mjs's PROVIDERS map is a static import-time
// Map) — a fresh copy of scripts/+globals/harnesses/ with a fabricated third "acme" provider
// registered alongside the real claude/codex.
//
// Scoped to the pure per-provider derivations (configSnapshotHarnesses, rootConfigBaseline/Active),
// not the full readConfigSnapshot()/portal snapshot — that pulls in package catalog, skills,
// telemetry state, and other disk-backed machinery unrelated to the harness-genericness question
// this test exists to answer, and would need a fully faked $HOME/repoRoot to run in isolation.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-config-synthetic-provider-"));
const appRoot = path.join(tmp, "app");

fs.cpSync(path.resolve("scripts"), path.join(appRoot, "scripts"), { recursive: true });
fs.cpSync(path.resolve("globals/harnesses"), path.join(appRoot, "globals", "harnesses"), { recursive: true });
fs.cpSync(path.resolve("modules"), path.join(appRoot, "modules"), { recursive: true });
fs.cpSync(path.resolve("manifests"), path.join(appRoot, "manifests"), { recursive: true });

// A minimal third provider, "acme": declares root-config + rules (like claude/codex) with a
// dedicated-json-sidecar hooks file (like Codex) so configSnapshotHarnesses' hooksStorage branch
// has a real third case to generalize to, and a displayName distinct from its id.
const acmeDir = path.join(appRoot, "globals", "harnesses", "acme");
fs.mkdirSync(acmeDir, { recursive: true });
fs.writeFileSync(
  path.join(acmeDir, "provider.json"),
  JSON.stringify({
    schemaVersion: 1,
    id: "acme",
    displayName: "Acme Coder",
    commandName: "acme",
    adapter: "acme",
    detection: { executables: ["acme"], minimumConfidence: "possible" },
    paths: {
      home: { path: "~/.acme", kind: "directory" },
      rootConfig: { path: "~/.acme/settings.json", kind: "file" },
      rules: { path: "~/.acme/AGENT.md", kind: "file" },
      hooks: { path: "~/.acme/hooks.json", kind: "file" },
      skills: { path: "~/.acme/skills", kind: "directory" },
      commands: { path: "~/.acme/commands", kind: "directory" },
    },
    capabilities: ["root-config", "rules", "hooks"],
    extensions: { app: { hooksStorage: "dedicated-json-sidecar" } },
  }, null, 2),
);

const acmeAdapterDir = path.join(appRoot, "scripts", "harnesses", "acme");
fs.mkdirSync(acmeAdapterDir, { recursive: true });
fs.writeFileSync(
  path.join(acmeAdapterDir, "index.mjs"),
  [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'import { defineHarnessProvider } from "../contract.mjs";',
    "",
    'const here = path.dirname(fileURLToPath(import.meta.url));',
    'const manifestPath = path.resolve(here, "..", "..", "..", "globals", "harnesses", "acme", "provider.json");',
    "const acmeManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));",
    "",
    "export const acmeProvider = defineHarnessProvider({",
    "  manifest: acmeManifest,",
    "  adapters: {",
    "    discovery: { detect: () => ({ providerId: 'acme', confidence: 'possible', evidence: [] }) },",
    "    rootConfig: { merge: (v) => v, render: () => '' },",
    "    rules: { render: () => '' },",
    "    hooks: { read: () => ({}), write: () => {}, merge: (v) => v, unmerge: (v) => v },",
    "  },",
    "});",
  ].join("\n"),
);

const registryPath = path.join(appRoot, "scripts", "harnesses", "registry.mjs");
fs.writeFileSync(
  registryPath,
  [
    'import { claudeProvider } from "./claude/index.mjs";',
    'import { codexProvider } from "./codex/index.mjs";',
    'import { acmeProvider } from "./acme/index.mjs";',
    "",
    "const PROVIDERS = new Map([",
    "  [claudeProvider.id, claudeProvider],",
    "  [codexProvider.id, codexProvider],",
    "  [acmeProvider.id, acmeProvider],",
    "]);",
    "",
    "export function listHarnessProviders() { return [...PROVIDERS.values()]; }",
    "export function getHarnessProvider(id) {",
    "  const provider = PROVIDERS.get(id);",
    '  if (!provider) throw new Error(`unsupported harness: ${id}`);',
    "  return provider;",
    "}",
    "export function hasHarnessProvider(id) { return PROVIDERS.has(id); }",
  ].join("\n"),
);

// Persisted discovery state for the machine-cohort assertions below: acme detected+enabled, codex
// present but explicitly disabled by the user, claude discovered as absent. Written directly rather
// than by running discovery so the fixture states exactly the three cases under test.
const stateDir = path.join(tmp, "state");
fs.mkdirSync(path.join(stateDir, "harnesses"), { recursive: true });
fs.writeFileSync(
  path.join(stateDir, "harnesses", "state.json"),
  JSON.stringify({
    schemaVersion: 1,
    lastDiscoveredAt: "2026-01-01T00:00:00.000Z",
    providers: {
      claude: { enabled: false, selectionSource: "discovery", confidence: "absent", evidence: [] },
      codex: { enabled: false, selectionSource: "user", confidence: "confirmed", evidence: [] },
      acme: { enabled: true, selectionSource: "discovery", confidence: "possible", evidence: [] },
    },
  }, null, 2),
);

// Live-discovery evidence for claude must come from the fixture, never from the developer's real
// home. Discovery expands manifest-declared home-relative candidates against os.homedir(), so the
// probe below runs with HOME pointed at this fabricated tree: ~/.claude exists (a "home" evidence
// kind) but no `claude` executable is on the probe's PATH, which normalizeConfidence scores as
// "possible". That is exactly the live-present/stale-absent case assertion (5) is about, and it is
// now stated by the fixture rather than inherited from the machine -- on a CI runner with no
// ~/.claude the old inherited-HOME version dropped claude from the cohort and failed.
const probeHome = path.join(tmp, "home");
fs.mkdirSync(path.join(probeHome, ".claude"), { recursive: true });

const probeScript = path.join(tmp, "probe.mjs");
fs.writeFileSync(
  probeScript,
  [
    `import { configSnapshotHarnesses, configSnapshotMachineHarnesses } from ${JSON.stringify(path.join(appRoot, "scripts", "cli", "config.mjs"))};`,
    `import { rootConfigBaseline, rootConfigActive } from ${JSON.stringify(path.join(appRoot, "scripts", "cli", "paths.mjs"))};`,
    "",
    "const harnesses = configSnapshotHarnesses();",
    "",
    "// (1) three providers, not a hardcoded two.",
    "if (harnesses.length !== 3) {",
    "  console.error('FAIL harness count: ' + harnesses.length);",
    "  process.exit(1);",
    "}",
    "",
    "// (2) acme resolves its real manifest displayName and declared filenames, not its bare id or a",
    "// literal claude/codex-shaped guess.",
    "const acme = harnesses.find((h) => h.id === 'acme');",
    "if (!acme || acme.displayName !== 'Acme Coder' || acme.rulesFile !== 'AGENT.md' || acme.settingsFile !== 'settings.json') {",
    "  console.error('FAIL acme entry: ' + JSON.stringify(acme));",
    "  process.exit(1);",
    "}",
    "",
    "// (3) acme declares dedicated-json-sidecar hooksStorage (like Codex) -- hooksFile must follow",
    "// its own declared hooks path, not the root-config file an embedded-storage provider would show.",
    "if (acme.hooksFile !== 'hooks.json') {",
    "  console.error('FAIL acme hooksFile: ' + acme.hooksFile);",
    "  process.exit(1);",
    "}",
    "",
    "// (4) rootConfigBaseline/rootConfigActive both key by whatever's registered, not a hardcoded",
    "// claude/codex pair -- the exact gap that would otherwise make buildRootConfigView() call",
    "// fs.existsSync(undefined) for a genuine third provider.",
    "if (!('acme' in rootConfigBaseline) || !('acme' in rootConfigActive)) {",
    "  console.error('FAIL rootConfigBaseline/Active missing acme: ' + JSON.stringify({ rootConfigBaseline, rootConfigActive }));",
    "  process.exit(1);",
    "}",
    "if (!rootConfigBaseline.acme.endsWith('generated/acme/settings.json')) {",
    "  console.error('FAIL rootConfigBaseline.acme: ' + rootConfigBaseline.acme);",
    "  process.exit(1);",
    "}",
    "",
    "// (5) The machine cohort combines persisted discovery state with bounded live discovery. It",
    "// picks up a synthetic provider with no source edit, keeps an explicitly-disabled-but-present",
    "// provider visible (it IS on the machine, it is just not managed), and also includes a provider",
    "// whose persisted state says absent when live discovery reaches its manifest minimum.",
    "// This is the distinction that makes the Agents view truthful even before refresh can write.",
    "const machine = configSnapshotMachineHarnesses();",
    "const ids = machine.map((h) => h.id).sort().join(',');",
    "if (ids !== 'acme,codex') {",
    "  console.error('FAIL machine cohort ids: ' + ids + ' (expected acme,codex)');",
    "  process.exit(1);",
    "}",
    "const acmeMachine = machine.find((h) => h.id === 'acme');",
    "if (!acmeMachine || acmeMachine.displayName !== 'Acme Coder' || acmeMachine.enabled !== true) {",
    "  console.error('FAIL acme machine entry: ' + JSON.stringify(acmeMachine));",
    "  process.exit(1);",
    "}",
    "const codexMachine = machine.find((h) => h.id === 'codex');",
    "if (!codexMachine || codexMachine.enabled !== false) {",
    "  console.error('FAIL user-disabled provider must stay visible: ' + JSON.stringify(codexMachine));",
    "  process.exit(1);",
    "}",
    "// Claude's manifest requires probable confidence, so a home-only possible signal is evidence,",
    "// but it is below the machine-cohort detection threshold.",
    "const claudeMachine = machine.find((h) => h.id === 'claude');",
    "if (claudeMachine) {",
    "  console.error('FAIL below-threshold claude must not appear: ' + JSON.stringify(claudeMachine));",
    "  process.exit(1);",
    "}",
    "// The registered catalog is unchanged by any of this -- config metadata still knows all three.",
    "if (configSnapshotHarnesses().length !== 3) {",
    "  console.error('FAIL registered catalog must retain every provider');",
    "  process.exit(1);",
    "}",
    "",
    "console.log('ok');",
  ].join("\n"),
);

const result = spawnSync(process.execPath, [probeScript], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: probeHome,
    USERPROFILE: probeHome,
    PATH: ["/usr/bin", "/bin"].join(path.delimiter),
    ROBOREPO_APP_ROOT: appRoot,
    ROBOREPO_STATE_DIR: stateDir,
    ROBOREPO_WORKSPACE_ROOT: path.join(tmp, "workspace"),
  },
});
assert.equal(result.status, 0, `synthetic third-provider probe failed:\n${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /ok/);

// Empty/stale state must not make the Agents page claim "no harnesses detected" when bounded live
// discovery can see a provider. This catches the exact regression where `/agents` depended only on
// ~/.roborepo/harnesses/state.json and ignored executable evidence until `roborepo harness refresh`
// was able to write machine state.
fs.writeFileSync(
  path.join(stateDir, "harnesses", "state.json"),
  JSON.stringify({
    schemaVersion: 1,
    lastDiscoveredAt: "2026-01-01T00:00:00.000Z",
    providers: {
      acme: { enabled: false, selectionSource: "discovery", confidence: "absent", evidence: [] },
    },
  }, null, 2),
);
const toolBin = path.join(tmp, "tools");
fs.mkdirSync(toolBin, { recursive: true });
fs.writeFileSync(path.join(toolBin, "acme"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

// Deliberately an EMPTY home: this probe's whole point is that a fabricated `acme` executable on
// PATH is enough on its own, so the cohort here must be exactly [acme] with no claude/codex leaking
// in from the developer's real home directory.
const liveProbeHome = path.join(tmp, "home-empty");
fs.mkdirSync(liveProbeHome, { recursive: true });

const liveProbeScript = path.join(tmp, "live-probe.mjs");
fs.writeFileSync(
  liveProbeScript,
  [
    `import { configSnapshotMachineHarnesses } from ${JSON.stringify(path.join(appRoot, "scripts", "cli", "config.mjs"))};`,
    "",
    "const machine = configSnapshotMachineHarnesses();",
    "const acme = machine.find((h) => h.id === 'acme');",
    "if (!acme || acme.enabled !== true || acme.confidence !== 'probable') {",
    "  console.error('FAIL live-discovered acme: ' + JSON.stringify(machine));",
    "  process.exit(1);",
    "}",
    "// Empty home + only the fabricated acme executable on PATH: nothing else may appear, which is",
    "// what proves the cohort came from this fixture's evidence and not the ambient machine.",
    "if (machine.length !== 1) {",
    "  console.error('FAIL cohort must contain only fixture-backed providers: ' + JSON.stringify(machine));",
    "  process.exit(1);",
    "}",
    "console.log('ok');",
  ].join("\n"),
);
const liveFallbackResult = spawnSync(process.execPath, [liveProbeScript], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: liveProbeHome,
    USERPROFILE: liveProbeHome,
    PATH: [toolBin, "/usr/bin", "/bin"].join(path.delimiter),
    ROBOREPO_APP_ROOT: appRoot,
    ROBOREPO_STATE_DIR: stateDir,
    ROBOREPO_WORKSPACE_ROOT: path.join(tmp, "workspace-live"),
  },
});
assert.equal(liveFallbackResult.status, 0, `live discovery fallback probe failed:\n${liveFallbackResult.stdout}\n${liveFallbackResult.stderr}`);
assert.match(liveFallbackResult.stdout, /ok/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("config synthetic third-provider checks passed");
