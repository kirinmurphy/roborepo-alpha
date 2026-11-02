#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Proves the INSTALL-SIDE artifact delivery path (slash-command rendering, skill linking, rules
// rendering, live permission rendering) does not encode a fixed-provider assumption.
//
// Why this test exists, and why it is separate from config-synthetic-provider-check.mjs: Gemini
// once passed 108 doctor checks while missing two whole artifact classes, because it was outside
// the delivery mechanism rather than partially inside it — there were no rows to fail on, and
// "no rows" reads identically to "all rows pass". The bug class is a hardcoded provider list in a
// delivery loop, so the only way to catch it is to register a provider that is NOT in any such
// list and assert it still receives artifacts.
//
// Same subprocess-isolation technique as config-/telemetry-synthetic-provider-check.mjs
// (registry.mjs's PROVIDERS map is a static import-time Map): a fresh copy of scripts/ +
// globals/harnesses/ with a fabricated third "acme" provider registered alongside claude/codex.
// Deliberately registered WITHOUT gemini, so a delivery loop that was merely widened from two
// hardcoded ids to three still fails here.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-delivery-synthetic-provider-"));
const appRoot = path.join(tmp, "app");
const home = path.join(tmp, "home");

try {
  fs.cpSync(path.resolve("scripts"), path.join(appRoot, "scripts"), { recursive: true });
  fs.cpSync(path.resolve("globals"), path.join(appRoot, "globals"), { recursive: true });
  fs.cpSync(path.resolve("modules"), path.join(appRoot, "modules"), { recursive: true });
  fs.cpSync(path.resolve("manifests"), path.join(appRoot, "manifests"), { recursive: true });
  fs.cpSync(path.resolve("generated"), path.join(appRoot, "generated"), { recursive: true });

  // "acme": declares the four delivery capabilities under test. Paths are deliberately NOT
  // claude/codex/gemini-shaped (~/.acme, AGENT.md) so any code that guesses a filename from a
  // hardcoded table instead of reading the manifest resolves the wrong path and fails visibly.
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
      detection: { homeCandidates: ["~/.acme"], minimumConfidence: "possible" },
      paths: {
        home: { path: "~/.acme", kind: "directory" },
        rootConfig: { path: "~/.acme/settings.json", kind: "file" },
        rules: { path: "~/.acme/AGENT.md", kind: "file" },
        skills: { path: "~/.acme/skills", kind: "directory" },
        commands: { path: "~/.acme/commands", kind: "directory" },
      },
      capabilities: ["root-config", "rules", "permissions", "skills", "slash-commands"],
      extensions: { app: { rootConfigFormat: "json", hooksStorage: "embedded-in-root-config" } },
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
      "const here = path.dirname(fileURLToPath(import.meta.url));",
      'const manifestPath = path.resolve(here, "..", "..", "..", "globals", "harnesses", "acme", "provider.json");',
      "const acmeManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));",
      "",
      "export const acmeProvider = defineHarnessProvider({",
      "  manifest: acmeManifest,",
      "  adapters: {",
      "    rootConfig: { merge: (v) => v, render: (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? {}, null, 2) + '\\n') },",
      // Rules/commands renders are marker-tagged so assertions prove acme's OWN adapter produced
      // the artifact, not that some file merely appeared at the path.
      "    rules: { render: (body) => '# ACME RULES MARKER\\n' + String(body ?? '') },",
      "    permissions: { render: () => '# ACME PERMISSIONS MARKER\\n' },",
      "    skills: { link: () => ({ changed: false }) },",
      "    commands: { render: (body) => '# ACME COMMAND MARKER\\n' + String(body ?? '') },",
      "  },",
      "});",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(appRoot, "scripts", "harnesses", "registry.mjs"),
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
      "  if (!provider) throw new Error(`unsupported harness: ${id}`);",
      "  return provider;",
      "}",
      "export function hasHarnessProvider(id) { return PROVIDERS.has(id); }",
    ].join("\n"),
  );

  // Live harness homes for all three, so every present-harness gate is satisfied and any missing
  // artifact is a delivery-loop defect rather than an absent-home skip.
  for (const dir of [".claude", ".codex", ".acme"]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");

  const probeScript = path.join(tmp, "probe.mjs");
  fs.writeFileSync(
    probeScript,
    [
      `import { knownHarnessIds } from ${JSON.stringify(path.join(appRoot, "scripts", "cli", "rules-render.mjs"))};`,
      `import { renderPermissionsTo } from ${JSON.stringify(path.join(appRoot, "scripts", "cli", "permissions-render.mjs"))};`,
      `import { listHarnessProviders } from ${JSON.stringify(path.join(appRoot, "scripts", "harnesses", "registry.mjs"))};`,
      `import { resolveHarnessPath } from ${JSON.stringify(path.join(appRoot, "scripts", "harnesses", "paths.mjs"))};`,
      "",
      "const failures = [];",
      "",
      "// (1) The shared id helper enumerates the registry, so every delivery loop built on it",
      "// picks up a new provider for free.",
      "const ids = knownHarnessIds();",
      "if (!ids.includes('acme')) failures.push('knownHarnessIds() omits acme: ' + JSON.stringify(ids));",
      "",
      "// (2) Every provider declaring a capability must resolve the path that capability needs.",
      "// This is the check that would have caught Gemini's missing artifacts: a provider claiming",
      "// slash-commands/skills but resolving no commands/skills path is outside the mechanism.",
      "const CAPABILITY_PATHS = { 'slash-commands': 'commands', skills: 'skills', rules: 'rules', 'root-config': 'rootConfig' };",
      "for (const provider of listHarnessProviders()) {",
      "  for (const [capability, pathKey] of Object.entries(CAPABILITY_PATHS)) {",
      "    if (!provider.manifest.capabilities.includes(capability)) continue;",
      "    let resolved = null;",
      "    try { resolved = resolveHarnessPath(provider.manifest, pathKey); } catch (err) { resolved = null; }",
      "    if (!resolved) failures.push(provider.id + ' declares ' + capability + ' but resolves no ' + pathKey + ' path');",
      "  }",
      "}",
      "",
      "// (3) Live permission rendering must reach acme's own adapter and write to acme's own",
      "// declared path -- not silently cover only the providers the function was written against.",
      `const result = renderPermissionsTo(${JSON.stringify(home)}, { manifest: { behaviors: [], commands: {} }, overrides: {} });`,
      "const touched = (result && result.touched) || [];",
      "if (!touched.some((p) => p.includes('.acme'))) {",
      "  failures.push('renderPermissionsTo touched no acme target; touched=' + JSON.stringify(touched));",
      "}",
      "",
      "if (failures.length > 0) { console.error('FAIL\\n  ' + failures.join('\\n  ')); process.exit(1); }",
      "console.log('ok');",
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, [probeScript], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, ROBOREPO_APP_ROOT: appRoot, ROBOREPO_STATE_ROOT: path.join(home, ".roborepo") },
  });

  assert.equal(result.status, 0, `synthetic third-provider delivery probe failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ok/);

  console.log("delivery synthetic third-provider checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
