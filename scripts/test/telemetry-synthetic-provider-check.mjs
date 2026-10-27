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
fs.cpSync(path.resolve("globals/packages"), path.join(appRoot, "globals", "packages"), { recursive: true });
fs.cpSync(path.resolve("manifests"), path.join(appRoot, "manifests"), { recursive: true });
fs.cpSync(path.resolve("portal/shared"), path.join(appRoot, "portal", "shared"), { recursive: true });
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
    extensions: { app: { headlessPromptArgs: ["--input-type=module", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", "{prompt}"] } },
    paths: { skills: { path: "~/.acme/skills", kind: "directory" }, home: { path: "~/.acme", kind: "directory" }, rootConfig: { path: "~/.acme/config.json", kind: "file" } },
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
    "export function harnessDisplayName(id) { return PROVIDERS.get(id)?.manifest.displayName ?? id; }",
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


const headlessProbe = path.join(appRoot, "headless-probe.mjs");
fs.writeFileSync(headlessProbe, `
import assert from "node:assert/strict";
import { findDeepReadProvider, runDeepRead } from "./scripts/cli/telemetry.mjs";
import { getHarnessProvider } from "./scripts/harnesses/registry.mjs";
import { createHarnessRuntime } from "./scripts/harnesses/harness-runtime.mjs";
import { insightsSummary } from "./scripts/cli/telemetry-insights.mjs";
const runtime = createHarnessRuntime({ state: { providers: { acme: { enabled: true }, claude: { enabled: false }, codex: { enabled: false } } } });
const selection = { runtime, resolveExecutable: () => process.execPath };
assert.equal(findDeepReadProvider(selection).cli, "acme");
const special = ${JSON.stringify("--leading 'quoted' \"double\"\n$(touch should-not-exist); & | < > `echo no` $HOME")};
const report = { capture_count: 0, group_cost: [{ group: special, calls: 1, avg_tokens: 1, total_tokens: 1 }], raw: "RAW_SECRET_MUST_NOT_LEAVE" };
const result = runDeepRead(report, selection);
assert.equal(result.ok, true);
assert.equal(result.cli, "acme");
const argv = JSON.parse(result.text);
assert.equal(argv.length, 1);
assert.ok(argv[0].endsWith(insightsSummary(report)));
assert.ok(argv[0].includes(special));
assert.ok(!argv[0].includes(report.raw));
const manifest = getHarnessProvider("acme").manifest;
const original = manifest.extensions.app.headlessPromptArgs;
for (const args of [undefined, null, [], ["-p"], ["prefix{prompt}"], ["{prompt}", "{prompt}"], ["{prompt}", 1], ["{prompt}", ""]]) {
  manifest.extensions.app.headlessPromptArgs = args;
  assert.equal(findDeepReadProvider({ runtime, resolveExecutable: () => { throw new Error("must not resolve ineligible providers"); } }), null);
  assert.equal(runDeepRead(report, selection).ok, false);
}
manifest.extensions.app.headlessPromptArgs = original;
assert.equal(findDeepReadProvider({ ...selection, resolveExecutable: () => null }), null);
const missing = runDeepRead(report, { ...selection, resolveExecutable: () => ${JSON.stringify(path.join(tmp, "missing-runtime"))} });
assert.equal(missing.ok, false);
assert.equal(missing.cli, "acme");
assert.match(missing.note, /ENOENT/);
assert.equal(findDeepReadProvider({ runtime: createHarnessRuntime({ state: { providers: {} } }), resolveExecutable: () => { throw new Error("disabled"); } }), null);
const unavailable = { manifest: { id: "unavailable", commandName: "unavailable", extensions: { app: { headlessPromptArgs: ["{prompt}"] } } } };
const ordered = { enabledProviders: () => [unavailable, getHarnessProvider("acme")] };
assert.equal(findDeepReadProvider({ runtime: ordered, resolveExecutable: (m) => m.id === "acme" ? process.execPath : null }).cli, "acme");
for (const [script, expected] of [["process.exit(7)", /exited 7/], ["", /returned no output/], ["setTimeout(() => {}, 10000)", /ETIMEDOUT/]]) {
  manifest.extensions.app.headlessPromptArgs = ["-e", script || " ", "--", "{prompt}"];
  const failure = runDeepRead(report, { ...selection, timeout: expected.source === "ETIMEDOUT" ? 100 : 5000 });
  assert.equal(failure.ok, false);
  assert.match(failure.note, expected);
  assert.equal(failure.cli, "acme");
}
console.log("headless synthetic selection and process checks passed");
`);
const headlessResult = spawnSync(process.execPath, [headlessProbe], { encoding: "utf8", env: { ...process.env, HOME: tmp, ROBOREPO_STATE_ROOT: path.join(tmp, "state") } });
assert.equal(headlessResult.status, 0, `${headlessResult.stdout}\n${headlessResult.stderr}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("telemetry synthetic third-provider checks passed");
