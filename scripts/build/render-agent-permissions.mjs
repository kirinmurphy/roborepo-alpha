#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPermissionManifest, loadPermissionWorkspaceRoots } from "../cli/permissions-render.mjs";
import { renderCodexRules } from "../harnesses/permissions-render.mjs";
import { listHarnessProviders } from "../harnesses/registry.mjs";
import { GENERATED_POLICY_FILENAME } from "../harnesses/gemini/policy-toml.mjs";

// Build entrypoint: renders the manifest's default behaviors into the committed generated system
// candidate (generated/<provider-id>/). Per-provider rendering goes through each provider's own
// `permissions.render` adapter (scripts/harnesses/{claude,codex,gemini}/index.mjs) so this script
// stays generic over the provider registry instead of hardcoding Claude/Codex; the config controls
// render the same adapter logic into a consumer's LIVE home config. `roborepo permissions` and
// doctor --check run this script. The generated candidate never carries personal overrides — it
// always renders the manifest's own default buckets, unmodified.
//
// Codex additionally renders a `rules/default.rules` prefix-rule sidecar with no analog in Claude's
// settings.json — Codex's approval model needs an extra file the shared `permissions.render`
// capability doesn't cover, so that one output stays an explicit codex-only step below rather than
// forcing every provider's render into one shape.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

function generatedHomeForRepo(root) {
  if (process.env.GENERATED_HOME) return process.env.GENERATED_HOME;
  return path.join(path.sep, "Users", "you");
}

const generatedRenderOptions = { home: generatedHomeForRepo(repoRoot) };

// Provider manifest paths are home-relative (e.g. "~/.claude/settings.json"); the generated
// candidate mirrors just the basename under generated/<provider-id>/. Most providers render
// permissions into their rootConfig file (Claude's settings.json, Codex's config.toml) — but
// Gemini's Policy Engine is a directory of standalone *.toml rule files with no rootConfig
// involvement at all (extensions.app.permissionsStorage: "policy-engine-toml-directory"),
// so its generated candidate target is paths.policies + the adapter's own generated filename,
// not paths.rootConfig.
function generatedPermissionsPath(provider) {
  if (provider.manifest.extensions?.app?.permissionsStorage === "policy-engine-toml-directory") {
    return path.join(repoRoot, "generated", provider.id, "policies", GENERATED_POLICY_FILENAME);
  }
  const basename = path.basename(provider.manifest.paths.rootConfig.path);
  return path.join(repoRoot, "generated", provider.id, basename);
}

let check = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--check") check = true;
  else {
    console.error("usage: render-agent-permissions.mjs [--check]");
    process.exit(2);
  }
}

const manifest = loadPermissionManifest();
const workspaceRoots = loadPermissionWorkspaceRoots();

function checkOrWrite(target, rendered, label) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (current === rendered) {
    if (check) console.log(`ok: ${label} generated permissions current`);
    return true;
  }
  if (check) {
    console.error(`fail: ${label} generated permissions drifted`);
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rendered);
  console.log(`render: ${path.relative(repoRoot, target)}`);
  return true;
}

let ok = true;
try {
  for (const provider of listHarnessProviders()) {
    if (!provider.manifest.capabilities.includes("permissions")) continue;
    const target = generatedPermissionsPath(provider);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    const rendered = provider.adapters.permissions.render(current, manifest, {}, target, {
      ...generatedRenderOptions,
      workspaceRoots,
    });
    ok = checkOrWrite(target, rendered, path.relative(repoRoot, target)) && ok;
  }

  const codexHooksSource = path.join(repoRoot, "globals", "harnesses", "codex", "hooks-codex.json");
  const codexHooksPath = path.join(repoRoot, "generated", "codex", "hooks.json");
  const codexHooks = JSON.parse(fs.readFileSync(codexHooksSource, "utf8"));
  ok = checkOrWrite(codexHooksPath, `${JSON.stringify(codexHooks, null, 2)}\n`, "Codex core hooks") && ok;

  const codexRulesPath = path.join(repoRoot, "generated", "codex", "rules", "default.rules");
  ok = checkOrWrite(codexRulesPath, renderCodexRules(manifest), "generated/codex/rules/default.rules") && ok;
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}
process.exit(ok ? 0 : 1);