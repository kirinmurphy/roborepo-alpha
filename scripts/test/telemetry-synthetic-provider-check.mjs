#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Prove the shared telemetry
// analysis and the harness-capability lookups it now uses (hasRateLimitsCapability,
// harness_display_names) do not encode a two-provider assumption. Both real providers
// (claude/codex) always exist together, so this can only be proven by registering a genuinely
// third provider — registry.mjs's PROVIDERS map is a static import-time Map, so (same technique
// as package-catalog-harness-check.mjs's capability-gap test) this runs in a fresh subprocess
// against a copied scripts/harnesses/ tree with a fabricated third provider added to the registry.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-telemetry-synthetic-provider-"));
const appRoot = path.join(tmp, "app");

fs.cpSync(path.resolve("scripts"), path.join(appRoot, "scripts"), { recursive: true });
fs.cpSync(path.resolve("globals/harnesses"), path.join(appRoot, "globals", "harnesses"), { recursive: true });
fs.cpSync(path.resolve("modules"), path.join(appRoot, "modules"), { recursive: true });

// A minimal third provider, "acme": declares telemetry-capture + telemetry-rate-limits (like
// Codex) so the capability-based rate-limit check has something real to generalize to, with a
// displayName distinct from its id so harness_display_names' lookup is provably not just echoing
// the id back.
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
    detection: { minimumConfidence: "possible" },
    paths: {},
    capabilities: ["telemetry-capture", "telemetry-rate-limits", "telemetry-transcripts"],
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
    "    telemetry: { wireCaptureHooks: () => ({ changed: false, content: '' }), parseRateLimits: (v) => v },",
    "    transcripts: { locate: () => null, parse: () => ({ stats: null, heavyTurns: null, title: null }) },",
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

const probeScript = path.join(tmp, "probe.mjs");
fs.writeFileSync(
  probeScript,
  [
    `import { analyzeTelemetry } from ${JSON.stringify(path.join(appRoot, "scripts", "cli", "telemetry-analyze.mjs"))};`,
    `import { getHarnessProvider, listHarnessProviders } from ${JSON.stringify(registryPath)};`,
    "",
    "const events = [",
    "  { schema: 3, ts: '2026-01-01T00:00:00.000Z', harness: 'claude', event: 'PostToolUse', session_id: 'a', repo: { label: 'r' }, tool: { name: 'Read', is_mcp: false }, tokens: { total: 100 }, delta_tokens: 10, last_result: { tool: 'Read', chars: 10, is_error: false }, details: {} },",
    "  { schema: 3, ts: '2026-01-01T00:01:00.000Z', harness: 'codex', event: 'PostToolUse', session_id: 'b', repo: { label: 'r' }, tool: { name: 'Read', is_mcp: false }, tokens: { total: 100 }, delta_tokens: 10, last_result: { tool: 'Read', chars: 10, is_error: false }, details: { codex_rate_limits: [{ name: 'weekly', used_percent: 40 }] } },",
    "  { schema: 3, ts: '2026-01-01T00:02:00.000Z', harness: 'acme', event: 'PostToolUse', session_id: 'c', repo: { label: 'r' }, tool: { name: 'Read', is_mcp: false }, tokens: { total: 100 }, delta_tokens: 10, last_result: { tool: 'Read', chars: 10, is_error: false }, details: {} },",
    "];",
    "",
    "const report = analyzeTelemetry(events);",
    "",
    "// (1) report.harnesses is genuinely N-provider, not hardcoded to two.",
    "if (JSON.stringify(report.harnesses) !== JSON.stringify(['acme', 'claude', 'codex'])) {",
    "  console.error('FAIL harnesses: ' + JSON.stringify(report.harnesses));",
    "  process.exit(1);",
    "}",
    "",
    "// (2) the capability-based rate-limit check generalizes: acme declares telemetry-rate-limits",
    "// (like Codex) but this event carries no codex_rate_limits payload, so it must warn the same",
    "// way an under-instrumented Codex session would -- proving the check is capability-driven, not",
    "// a literal 'codex' string match.",
    "const acmeWarning = report.data_quality_warnings.find((w) => w.type === 'rate_limit_unavailable' && w.harness === 'acme');",
    "if (!acmeWarning) {",
    "  console.error('FAIL: expected rate_limit_unavailable warning for acme, got: ' + JSON.stringify(report.data_quality_warnings));",
    "  process.exit(1);",
    "}",
    "",
    "// (3) harness_display_names resolves acme's real manifest displayName, not its bare id.",
    "const displayName = getHarnessProvider('acme').manifest.displayName;",
    "if (displayName !== 'Acme Coder') {",
    "  console.error('FAIL displayName: ' + displayName);",
    "  process.exit(1);",
    "}",
    "",
    "// (4) the registry itself reports 3 providers, not a hardcoded 2.",
    "if (listHarnessProviders().length !== 3) {",
    "  console.error('FAIL provider count: ' + listHarnessProviders().length);",
    "  process.exit(1);",
    "}",
    "",
    "console.log('ok');",
  ].join("\n"),
);

const result = spawnSync(process.execPath, [probeScript], { encoding: "utf8" });
assert.equal(result.status, 0, `synthetic third-provider probe failed:\n${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /ok/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("telemetry synthetic third-provider checks passed");
