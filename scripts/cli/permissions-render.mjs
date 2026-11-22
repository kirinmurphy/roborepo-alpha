import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { repoRoot } from "./paths.mjs";
import { writeRootConfig } from "./root-config-writes.mjs";
import { recordAppRoot } from "./state-paths.mjs";
import { agentIdentityPackageEnabled } from "./agent-identity-package.mjs";
import { listHarnessProviders } from "../harnesses/registry.mjs";
import {
  resolveBehaviors,
  resolveArbitraryCommands,
  renderCodexConfig,
  renderCodexRules,
  claudePermissions,
  renderClaudeSettings,
} from "../harnesses/permissions-render.mjs";
import { GENERATED_POLICY_FILENAME } from "../harnesses/gemini/policy-toml.mjs";

// Orchestration + manifest loading for agent-permission rendering. The pure render core
// (resolveBehaviors, renderClaudeSettings, renderCodexConfig, ...) lives in
// scripts/harnesses/permissions-render.mjs, re-exported here for existing consumers, so both the
// build entrypoint (scripts/build/render-agent-permissions.mjs, repo SOURCE) and the config
// controls (renderPermissionsToHome, a consumer's LIVE home config) keep importing from this one
// module. Provider adapters (scripts/harnesses/{claude,codex}/index.mjs) import the pure module
// directly instead, since this module's writeRootConfig import pulls in paths.mjs's registry-
// dependent half and would cycle back into a provider importing this file.
export { resolveBehaviors, resolveArbitraryCommands, renderCodexConfig, renderCodexRules, claudePermissions, renderClaudeSettings };

const manifestPath = path.join(repoRoot, "manifests", "inventory", "agent-permissions.json");

export function loadPermissionManifest(p = manifestPath) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Where a provider's rendered permissions land, relative to its home dir, and whether roborepo may
// create the file from nothing. Derived from the provider manifest's declared permissionsStorage
// so a new provider needs no edit here:
//
//   - "generated-file-in-directory": roborepo fully owns a dedicated file (Gemini's Policy Engine
//     TOML in ~/.gemini/policies/). Never a pre-existing user file, so always safe to create.
//   - anything else: the permissions live inside the provider's own root config, which the user
//     may also hand-edit. Created only when the harness home already exists, and (for providers
//     whose root config roborepo does not fabricate) only when the file itself already exists.
//
// The render itself is entirely the provider's business — this function owns only the
// create/existence gating, which is platform policy about not fabricating user files.
function permissionsTargetFor(manifest, baseDir) {
  const appExt = manifest.extensions?.app ?? {};
  const homeRel = manifest.paths?.home?.path?.replace(/^~\//, "");
  if (!homeRel) return null;
  const homeDir = path.join(baseDir, homeRel);

  if (appExt.permissionsStorage === "policy-engine-toml-directory") {
    const dirRel = manifest.paths?.policies?.path?.replace(/^~\//, "");
    if (!dirRel) return null;
    return { file: path.join(baseDir, dirRel, GENERATED_POLICY_FILENAME), homeDir, mayCreate: true, seedCurrent: false };
  }

  const rootRel = manifest.paths?.rootConfig?.path?.replace(/^~\//, "");
  if (!rootRel) return null;
  // JSON root configs are materialized from nothing (Claude's settings.json); non-JSON ones are
  // only rewritten in place (Codex's config.toml is never fabricated by roborepo).
  const mayCreate = appExt.rootConfigFormat === "json";
  return { file: path.join(baseDir, rootRel), homeDir, mayCreate, seedCurrent: true };
}

// A provider may widen its own sandbox for the current repository: `workspaceRoots` for folders
// agents work in, `writablePaths` for individual paths outside them. Both are optional adapter
// methods, and what they return is the provider's business.
function permissionOptionsForProvider(provider, { cwd = process.cwd(), workspaceRoots } = {}) {
  const adapter = provider.adapters.permissions;
  const roots = Array.isArray(workspaceRoots) ? [...workspaceRoots] : [];
  if (typeof adapter.workspaceRoots === "function") roots.push(...adapter.workspaceRoots({ cwd }));
  const writablePaths = typeof adapter.writablePaths === "function" ? adapter.writablePaths({ cwd }) : [];
  return { workspaceRoots: [...new Set(roots)], writablePaths };
}

function ensureClaudePermissionHookAssets(baseDir) {
  const sourceDir = path.join(repoRoot, "globals", "harnesses", "claude", "hooks");
  const destDir = path.join(baseDir, ".claude", "hooks", "provider");
  if (!fs.existsSync(sourceDir)) return;
  if (fs.existsSync(destDir) && !fs.lstatSync(destDir).isDirectory()) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = path.join(sourceDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (fs.existsSync(dest) && !fs.lstatSync(dest).isFile()) continue;
    fs.copyFileSync(source, dest);
  }
}

// Codex's prefix-rule file, relative to the Codex home. Only RoboRepo writes it: the `owned` row in
// manifests/platform/manifest.tsv installs the identity-off baseline from generated/codex/rules/,
// and this module rewrites it for the live identity state.
export const CODEX_RULES_HOME_SUB = "rules/roborepo.rules";

// Writes Codex's rules/roborepo.rules for the live identity state, so with the GitHub agent identity
// on, `gh api`, posting, and `git push` get the identity's buckets there too. Personal overrides are
// not rendered into it; the Codex permission hook applies them. A `rules` folder that is a link (an
// old install linked it into the checkout) is left alone, so this never writes into the repo; the
// install step replaces that link. Returns whether the file changed.
export function writeCodexRulesFile(codexHome, { manifest = loadPermissionManifest(), agentIdentity = agentIdentityPackageEnabled() } = {}) {
  const file = path.join(codexHome, CODEX_RULES_HOME_SUB);
  const dir = path.dirname(file);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) return false;
  const content = renderCodexRules(manifest, {}, { agentIdentity });
  const isFile = fs.existsSync(file) && fs.lstatSync(file).isFile();
  if (isFile && fs.readFileSync(file, "utf8") === content) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(file, { recursive: true, force: true });
  fs.writeFileSync(file, content);
  return true;
}

// Render the manifest (+ overrides) into each present harness's live config under `baseDir`.
// Always global scope — no project override. `createClaude` retained for callers that might target
// a fresh directory (e.g. a scratch/test harness home); default global-only usage never needs it.
// `overrides` is the FULL override-file shape: { behaviors: {id: bucket}, commands: {key: {tokens, bucket}} }.
// `agentIdentity` defaults to whether the GitHub agent identity package is enabled; pass it
// explicitly to override.
//
// Iterates the provider registry rather than a fixed provider list, so a newly registered harness
// receives permissions without editing this function. A provider that does not declare the
// "permissions" capability is skipped by contract, not by omission.
export function renderPermissionsTo(
  baseDir,
  { manifest = loadPermissionManifest(), overrides = {}, createClaude = false, workspaceRoots = [], cwd = process.cwd(), agentIdentity = agentIdentityPackageEnabled() } = {},
) {
  const touched = [];

  for (const provider of listHarnessProviders()) {
    if (!provider.manifest.capabilities.includes("permissions")) continue;
    const target = permissionsTargetFor(provider.manifest, baseDir);
    if (!target) continue;

    // `createClaude` is a legacy caller affordance for materializing a scratch harness home; it
    // applies to whichever provider roborepo may create a root config for.
    const forceCreate = createClaude && target.mayCreate;
    const homeExists = fs.existsSync(target.homeDir);
    const fileExists = fs.existsSync(target.file);
    if (!forceCreate && !fileExists && !(homeExists && target.mayCreate)) continue;

    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    const cur = target.seedCurrent && fileExists ? fs.readFileSync(target.file, "utf8") : "";
    const rendered = provider.adapters.permissions.render(cur, manifest, overrides, target.file, { ...permissionOptionsForProvider(provider, { cwd, workspaceRoots }), agentIdentity });
    writeRootConfig(provider.id, target.file, rendered);
    if (provider.id === "claude") ensureClaudePermissionHookAssets(baseDir);
    touched.push(target.file);
    if (provider.id === "codex" && writeCodexRulesFile(target.homeDir, { manifest, agentIdentity })) {
      touched.push(path.join(target.homeDir, CODEX_RULES_HOME_SUB));
    }
  }

  return { touched };
}

// Global-scope render into the live home dir. This is the path that installs live permission hooks,
// so it also records the app root those hooks resolve the platform manifest from.
export function renderPermissionsToHome({
  home = os.homedir(),
  manifest = loadPermissionManifest(),
  overrides = {},
  workspaceRoots,
  cwd = process.cwd(),
  agentIdentity,
} = {}) {
  recordAppRoot();
  return renderPermissionsTo(home, { manifest, overrides, workspaceRoots, cwd, ...(agentIdentity === undefined ? {} : { agentIdentity }) });
}
