// Claude Code harness provider: manifest binding and capability adapters. Methods listed in
// stubGroups below are placeholders that throw until their behavior moves here from scripts/cli/.
//
// Split by capability group across this directory to stay under the repo's 150-200 line file-size
// guidance: mcp.mjs (the 4 MCP methods), hooks-withdraw.mjs (the withdraw-specific bulk strip).
// This file is the composition root: rootConfig/package-component merge, hooks merge/unmerge,
// telemetry, transcripts, and the final defineHarnessProvider wiring.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineHarnessProvider } from "../contract.mjs";
import { detectHarnessProvider } from "../discovery.mjs";
import { stubAdapterGroups } from "../stub-adapter.mjs";
import { mergeRootConfigHooks, unmergeRootConfigHooks } from "../root-config-hooks.mjs";
import { mergeHooksMap } from "../hooks-merge.mjs";
import { mergeClaudeSettings, normalizeRootConfigContent } from "../../cli/root-config-merge.mjs";
import { renderClaudeSettings } from "../permissions-render.mjs";
import { mcpRemove, mcpAddServer, mcpRemoveServer, mcpList } from "./mcp.mjs";
import { hooksWriteRemove } from "./hooks-withdraw.mjs";
import { transcriptStats } from "../transcript-parse.mjs";
import { locateTranscript, extractHeavyTurns, transcriptTitle } from "../transcript-locate.mjs";

const PACKAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "globals", "packages");

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, "..", "..", "..", "globals", "harnesses", "claude", "provider.json");
const claudeManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const coreHooksPath = path.resolve(here, "..", "..", "..", "globals", "harnesses", "claude", "hooks-claude.json");

function readCoreHooksFragment() {
  return JSON.parse(fs.readFileSync(coreHooksPath, "utf8"));
}

function renderClaudeRootConfig(current, manifest, overrides, options = {}) {
  const rendered = JSON.parse(renderClaudeSettings(current, manifest, overrides, options));
  rendered.hooks = mergeHooksMap(rendered.hooks || {}, readCoreHooksFragment()).hooks;
  return `${JSON.stringify(rendered, null, 2)}\n`;
}

function statusLineMatches(existing, desired) {
  return JSON.stringify(existing || null) === JSON.stringify(desired || null);
}

// merge/render/mergePackageComponent/unmergePackageComponent stay thin wrappers over
// root-config-merge.mjs's existing, characterization-tested functions
// (scripts/test/{root-config-merge,package-harness-config}-characterization-check.mjs) rather
// than a re-port — this phase moves OWNERSHIP behind the provider contract, not the
// implementation itself. mergePackageComponent/unmergePackageComponent take the already-read
// component config (not the raw component) so this module never needs package-harness-config.mjs's
// readHarnessConfig, which depends on paths.mjs -> registry.mjs -> this module — a cycle.
function mergePackageComponent(pkg, config, { claudeSettingsPath, readSettings, writeSettings }) {
  if (!config.statusLine || typeof config.statusLine !== "object") {
    throw new Error(`${pkg.id}: Claude harness-config needs statusLine`);
  }
  const settings = readSettings(claudeSettingsPath);
  if (settings.statusLine && !statusLineMatches(settings.statusLine, config.statusLine)) {
    console.warn("  conflict: Claude statusLine already exists; leaving unmanaged setting unchanged");
    return;
  }
  settings.statusLine = config.statusLine;
  writeSettings(claudeSettingsPath, settings);
  console.log(`  wired: Claude statusLine -> ${claudeSettingsPath}`);
}

function unmergePackageComponent(pkg, config, { claudeSettingsPath, readSettings, writeSettings }) {
  const settings = readSettings(claudeSettingsPath);
  if (!settings.statusLine) {
    console.log("  ok: Claude statusLine already absent");
    return;
  }
  if (!statusLineMatches(settings.statusLine, config.statusLine)) {
    console.warn("  conflict: Claude statusLine is unmanaged; leaving it unchanged");
    return;
  }
  delete settings.statusLine;
  writeSettings(claudeSettingsPath, settings);
  console.log(`  removed: Claude statusLine <- ${claudeSettingsPath}`);
}

// Claude stores hooks nested under settings.json's "hooks" key, alongside permissions etc. — the
// same shape Gemini's settings.json uses, so the read/merge/unmerge wrapper is shared via
// root-config-hooks.mjs rather than duplicated per provider. Returns { changed, content } rather
// than writing — the orchestrator (packages.mjs, which already imports paths.mjs directly with no
// cycle risk) performs the actual write, same pattern as mergePackageComponent/
// unmergePackageComponent above.

// Telemetry capture's hook fragment is fixed per provider (globals/packages/telemetry/hooks-<id>.json),
// unlike the package-driven hooks.merge below which takes an arbitrary fragment — reuses the same
// merge math (mergeRootConfigHooks) since Claude's settings.json is both the root config and the
// hooks file.
function wireCaptureHooks(settingsPath) {
  const fragmentPath = path.join(PACKAGES_DIR, "telemetry", "hooks-claude.json");
  const fragment = JSON.parse(fs.readFileSync(fragmentPath, "utf8"));
  return mergeRootConfigHooks(settingsPath, fragment);
}

function locate(sessionId) {
  return locateTranscript(sessionId, "claude");
}

// transcriptStats tolerates either harness's entry shape by design (a session's transcript should
// only ever contain its own harness's shape, but the shared parser stays format-tolerant as a
// safety net rather than trusting the caller's harness id blindly) — both providers share this
// same parser rather than each owning a harness-pure copy. includeHeavyTurns is opt-in: the hot
// capture path (every PreToolUse/PostToolUse) never sets it, since extractHeavyTurns/transcriptTitle
// do a full non-incremental re-read that only the on-demand session drill-down needs.
function parse(transcriptPath, { sessionId, collectorDir, includeHeavyTurns = false } = {}) {
  const stats = transcriptStats(transcriptPath, { sessionId, collectorDir });
  if (!includeHeavyTurns) return { stats, heavyTurns: null, title: null };
  return {
    stats,
    heavyTurns: extractHeavyTurns(transcriptPath, { limit: 8 }),
    title: transcriptTitle(transcriptPath),
  };
}

const stubGroups = stubAdapterGroups("claude", {
  rules: ["render"],
  skills: ["link"],
  commands: ["render"],
  hooks: ["read"],
  mcp: ["add"],
  session: ["launch"],
});

export const claudeProvider = defineHarnessProvider({
  manifest: claudeManifest,
  adapters: {
    discovery: { detect: () => detectHarnessProvider(claudeManifest) },
    ...stubGroups,
    rootConfig: {
      merge: (repoText, localText) => mergeClaudeSettings(repoText, localText),
      render: (content) => normalizeRootConfigContent("claude", content),
      mergePackageComponent,
      unmergePackageComponent,
    },
    mcp: {
      ...stubGroups.mcp,
      remove: mcpRemove,
      addServer: mcpAddServer,
      removeServer: mcpRemoveServer,
      list: mcpList,
    },
    hooks: {
      ...stubGroups.hooks,
      write: hooksWriteRemove,
      merge: mergeRootConfigHooks,
      unmerge: unmergeRootConfigHooks,
    },
    telemetry: {
      wireCaptureHooks,
    },
    transcripts: {
      locate,
      parse,
    },
    // 4th param (target path) is Codex-only (used in an error message). The optional 5th param lets
    // the generated build render a deterministic home while live config renders keep using os.homedir().
    permissions: {
      render: (current, manifest, overrides, _target, options = {}) => renderClaudeRootConfig(current, manifest, overrides, options),
    },
  },
});
