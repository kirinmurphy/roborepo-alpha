// Shared paths for roborepo command modules.
//
// appRoot/STATE_ROOT/workspaceRoot and workspace scaffolding live in roots.mjs, a leaf module with
// no harness-registry dependency (state-paths.mjs, owned-scalars-state.mjs, and provider adapter
// code all need those roots without pulling in this file's harness-path section below, which
// imports scripts/harnesses/registry.mjs and would otherwise cycle back into a provider's own
// index.mjs). Re-exported here unchanged so every existing consumer of this module is unaffected.
import path from "node:path";
import {
  appRoot,
  STATE_ROOT,
  developmentMode,
  packageMode,
  workspaceRoot,
  repoRoot,
  sharedSkillsDir,
  workspaceSkillsDir,
  workspaceCommandsDir,
  workspaceMcpServersPath,
  workspacePackagesDir,
  workspaceOverridesDir,
  requireDevelopmentCheckout,
  workspaceManifestPath,
  initializeWorkspace,
} from "./roots.mjs";

export {
  appRoot,
  STATE_ROOT,
  // Compatibility alias: several modules take stateRoot as an options-object key or param name
  // (camelCase locals); they keep importing the constant under the old binding. New code imports
  // STATE_ROOT directly.
  STATE_ROOT as stateRoot,
  developmentMode,
  packageMode,
  workspaceRoot,
  repoRoot,
  sharedSkillsDir,
  workspaceSkillsDir,
  workspaceCommandsDir,
  workspaceMcpServersPath,
  workspacePackagesDir,
  workspaceOverridesDir,
  requireDevelopmentCheckout,
  workspaceManifestPath,
  initializeWorkspace,
};

// Harness home/root-config/live-store paths below are derived from each provider's manifest
// (globals/harnesses/<id>/provider.json, resolved via scripts/harnesses/paths.mjs) rather than
// hardcoded here — the manifest is the single source of truth for these home-relative locations.
// This module keeps the same
// plain-object-keyed-by-id export shape so existing consumers (presets.mjs, update-report.mjs,
// config.mjs, and everything using Object.keys(rootConfigActive) to iterate harnesses) are
// unaffected by the migration.
import { listHarnessProviders } from "../harnesses/registry.mjs";
import { resolveHarnessPath, hasHarnessPath } from "../harnesses/paths.mjs";

function pathById(key) {
  return Object.fromEntries(
    listHarnessProviders()
      .filter((provider) => hasHarnessPath(provider.manifest, key))
      .map((provider) => [provider.id, resolveHarnessPath(provider.manifest, key)])
  );
}

export const harnessHome = pathById("home");
// Root config baseline paths (the repo-tracked templates for mutable harness config). This is repo
// build output, not a harness's own home-relative location, so it is not part of the provider
// manifest's declarative paths — but the filename itself still comes from the manifest's own
// rootConfig path (settings.json / config.toml / ...), keyed generically per registered provider
// rather than hardcoded per id, following the same "generated/<id>/<basename>" convention used
// elsewhere for generated build output (see config.mjs's generatedSidecarHooksPath).
export const rootConfigBaseline = Object.fromEntries(
  listHarnessProviders()
    .filter((provider) => hasHarnessPath(provider.manifest, "rootConfig"))
    .map((provider) => [
      provider.id,
      path.join(appRoot, "generated", provider.id, path.basename(resolveHarnessPath(provider.manifest, "rootConfig"))),
    ])
);
// Root config active paths (what the harness actually reads).
export const rootConfigActive = pathById("rootConfig");
// Claude's per-user MCP live store (~/.claude.json), distinct from ~/.claude/settings.json.
export const claudeJsonPath = resolveHarnessPath(
  listHarnessProviders().find((provider) => provider.id === "claude").manifest,
  "mcpLiveStore"
);
// Codex hooks live in a dedicated file, not inside config.toml — single source of truth for the
// live path (previously re-derived independently in package-probes.mjs, config.mjs, telemetry.mjs).
export const codexHooksPath = resolveHarnessPath(
  listHarnessProviders().find((provider) => provider.id === "codex").manifest,
  "hooks"
);
