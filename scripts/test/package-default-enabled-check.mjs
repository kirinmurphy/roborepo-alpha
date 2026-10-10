#!/usr/bin/env node
// Default-selection provenance contract (default selection respects explicit enable/disable
// provenance):
//   effective = explicit-enable OR (defaultEnabled AND NOT explicit-disable)
//   precedence: explicit-disable > explicit-enable > current defaults
// Covers both the pure computation (effectiveEnabledIds) and the live CLI path (a default-enabled
// package's rules render into a fresh home with zero `enable` calls, and disabling it once keeps
// it off even though it's still default-enabled in the catalog).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { effectiveEnabledIds } from "../cli/rules-render.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

// --- Pure computation ---
{
  const catalog = [
    { id: "always-on", defaultEnabled: true },
    { id: "opt-in", defaultEnabled: false },
  ];

  assert.deepEqual(
    effectiveEnabledIds(catalog, { packages: [], disabled: [] }).sort(),
    ["always-on"],
    "a default-enabled package is active with an empty registry",
  );
  assert.deepEqual(
    effectiveEnabledIds(catalog, { packages: ["opt-in"], disabled: [] }).sort(),
    ["always-on", "opt-in"],
    "explicit-enable adds to the default set",
  );
  assert.deepEqual(
    effectiveEnabledIds(catalog, { packages: [], disabled: ["always-on"] }),
    [],
    "explicit-disable suppresses a default-enabled package",
  );
  assert.deepEqual(
    effectiveEnabledIds(catalog, { packages: ["always-on"], disabled: ["always-on"] }),
    [],
    "explicit-disable wins even if the same id is also (stale) in the explicit-enable list",
  );
}

// --- Live CLI path: a synthetic default-enabled package, no `enable` call ever made ---
function makeHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-default-enabled-"));
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "");
  return tmp;
}

const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-default-enabled-app-"));
try {
  fs.mkdirSync(path.join(appRoot, ".git"), { recursive: true });
  fs.cpSync(path.resolve("manifests"), path.join(appRoot, "manifests"), { recursive: true });
  fs.cpSync(path.resolve("globals"), path.join(appRoot, "globals"), { recursive: true });
  // module-loader.mjs resolves "module" adapter commands (enable/disable, ...) relative to appRoot,
  // mirroring the real npm package layout (scripts/cli/ ships under the install root) — so a
  // spawned CLI subprocess under a fake appRoot needs scripts/ too, not just manifests/+globals/.
  fs.cpSync(path.resolve("scripts"), path.join(appRoot, "scripts"), { recursive: true });

  const pkgDir = path.join(appRoot, "globals", "packages", "always-on-check");
  fs.mkdirSync(path.join(pkgDir, "rules"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "rules", "rules.md"), "Always-on check marker text.\n");
  fs.writeFileSync(path.join(pkgDir, "package.config.json"), JSON.stringify({
    schemaVersion: 1,
    id: "always-on-check",
    label: "Always On Check",
    description: "Fixture package for default-enabled provenance testing.",
    lifecycle: "optional",
    defaultEnabled: true,
    presentation: { category: "code-conventions", order: 999 },
    resources: [{ type: "rules", source: "rules/rules.md", harness: "both" }],
  }, null, 2));

  const home1 = makeHome();
  const env1 = { ...process.env, ROBOREPO_MODE: "development", ROBOREPO_APP_ROOT: appRoot, HOME: home1, ROBOREPO_STATE_DIR: path.join(home1, ".roborepo"), SKIP_MCP: "1" };
  try {
    // renderHomeRules() directly, not `roborepo rules` (that shells out to the repo-tracked
    // scripts/build/render-rules.sh baseline renderer, which this synthetic app root doesn't
    // carry) — this is exactly the function enable/disable call, invoked here with zero prior
    // enable/disable calls to prove a default-enabled package's rules are live from a cold state.
    const render = spawnSync(process.execPath, [
      "-e",
      `import(${JSON.stringify(path.resolve("scripts/cli/rules-render.mjs"))}).then((m) => m.renderHomeRules())`,
    ], { env: env1, encoding: "utf8" });
    assert.equal(render.status, 0, `renderHomeRules should succeed: ${render.stderr}\n${render.stdout}`);
    const claudeRules = fs.readFileSync(path.join(home1, ".claude", "CLAUDE.md"), "utf8");
    assert.match(claudeRules, /Always-on check marker text\./, "default-enabled package's rules render without ever calling enable");
  } finally {
    fs.rmSync(home1, { recursive: true, force: true });
  }

  // Explicit disable, once, then re-render: the package must stay off even though it's still
  // default-enabled in the catalog.
  const home2 = makeHome();
  const env2 = { ...process.env, ROBOREPO_MODE: "development", ROBOREPO_APP_ROOT: appRoot, HOME: home2, ROBOREPO_STATE_DIR: path.join(home2, ".roborepo"), SKIP_MCP: "1" };
  try {
    const disable = spawnSync(process.execPath, [cli, "package", "disable", "always-on-check"], { env: env2, encoding: "utf8" });
    assert.equal(disable.status, 0, `disable should succeed: ${disable.stderr}\n${disable.stdout}`);
    const claudeRules = fs.readFileSync(path.join(home2, ".claude", "CLAUDE.md"), "utf8");
    assert.doesNotMatch(claudeRules, /Always-on check marker text\./, "explicit disable suppresses a default-enabled package's rules");

    const registry = JSON.parse(fs.readFileSync(path.join(home2, ".roborepo", "enabled-packages.json"), "utf8"));
    assert.ok(registry.disabled.includes("always-on-check"), "explicit disable is recorded in the registry's disabled list");

    // Re-enabling clears the explicit-disable and the package renders again.
    const enable = spawnSync(process.execPath, [cli, "package", "enable", "always-on-check"], { env: env2, encoding: "utf8" });
    assert.equal(enable.status, 0, `re-enable should succeed: ${enable.stderr}\n${enable.stdout}`);
    const claudeRulesAfterEnable = fs.readFileSync(path.join(home2, ".claude", "CLAUDE.md"), "utf8");
    assert.match(claudeRulesAfterEnable, /Always-on check marker text\./, "re-enable clears explicit-disable and restores default-enabled behavior");
  } finally {
    fs.rmSync(home2, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(appRoot, { recursive: true, force: true });
}

console.log("ok: default-enabled provenance contract");