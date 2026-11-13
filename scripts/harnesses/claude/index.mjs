// Claude Code harness provider: manifest binding and capability adapters. Methods listed in
// stubGroups below are placeholders that throw until their behavior moves here from scripts/cli/.
//
// Split by capability group across this directory: mcp.mjs (the 4 MCP methods), hooks-withdraw.mjs
// (the withdraw-specific bulk strip), sandbox-settings.mjs (the `sandbox` key of permissions.render).
// This file is the composition root: rootConfig/package-component merge, hooks merge/unmerge,
// telemetry, transcripts, and the final defineHarnessProvider wiring.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineHarnessProvider } from "../contract.mjs";
import { detectHarnessProvider } from "../discovery.mjs";
import { stubAdapterGroups } from "../stub-adapter.mjs";
import { hookRecordsFromFile, mergeRootConfigHooks, unmergeRootConfigHooks } from "../root-config-hooks.mjs";
import { resolveHarnessPath } from "../paths.mjs";
import { mergeHooksMap } from "../hooks-merge.mjs";
import { mergeClaudeSettings, normalizeRootConfigContent } from "../../cli/root-config-merge.mjs";
import { renderClaudeSettings, resolveBehaviors } from "../permissions-render.mjs";
import { claudeSandboxSettings } from "./sandbox-settings.mjs";
import { mcpRemove, mcpAddServer, mcpRemoveServer, mcpList } from "./mcp.mjs";
import { hooksWriteRemove } from "./hooks-withdraw.mjs";
import { transcriptStats } from "../transcript-parse.mjs";
import { jsonConfigEdit } from "../config-edit/json.mjs";
import { locateTranscript, extractHeavyTurns, transcriptTitle } from "../transcript-locate.mjs";

const PACKAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "globals", "packages");

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, "..", "..", "..", "globals", "harnesses", "claude", "provider.json");
const claudeManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const coreHooksPath = path.resolve(here, "..", "..", "..", "globals", "harnesses", "claude", "hooks-claude.json");

function readCoreHooksFragment() {
  return JSON.parse(fs.readFileSync(coreHooksPath, "utf8"));
}

// RoboRepo owns `sandbox` the way it owns `permissions`: each render replaces it whole. A
// repository's .claude/settings.local.json can still add entries, since Claude merges sandbox
// arrays across settings scopes.
function renderClaudeRootConfig(current, manifest, overrides = {}, options = {}) {
  const rendered = JSON.parse(renderClaudeSettings(current, manifest, overrides, options));
  rendered.hooks = mergeHooksMap(rendered.hooks || {}, readCoreHooksFragment()).hooks;
  const sandbox = claudeSandboxSettings(resolveBehaviors(manifest, overrides.behaviors));
  if (sandbox) rendered.sandbox = sandbox;
  return `${JSON.stringify(rendered, null, 2)}\n`;
}

// merge/render stay thin wrappers over root-config-merge.mjs's existing, characterization-tested
// functions (scripts/test/root-config-merge-characterization-check.mjs) rather than a re-port.

// Claude stores hooks nested under settings.json's "hooks" key, alongside permissions etc. — the
// same shape Gemini's settings.json uses, so the read/merge/unmerge wrapper is shared via
// root-config-hooks.mjs rather than duplicated per provider. Returns { changed, content } rather
// than writing — the orchestrator (packages.mjs, which already imports paths.mjs directly with no
// cycle risk) performs the actual write.

// Telemetry capture's hook fragment is fixed per provider (globals/packages/telemetry/hooks-<id>.json),
// unlike the package-driven hooks.merge below which takes an arbitrary fragment — reuses the same
// merge math (mergeRootConfigHooks) since Claude's settings.json is both the root config and the
// hooks file.
function wireCaptureHooks(settingsPath) {
  const fragmentPath = path.join(PACKAGES_DIR, "telemetry", "hooks-claude.json");
  const fragment = JSON.parse(fs.readFileSync(fragmentPath, "utf8"));
  return mergeRootConfigHooks(settingsPath, fragment);
}

// Claude has no per-hook approval; this confirms file-level configuration, not workspace execution.
// Async to match the contract, whose Codex implementation has to ask a running process.
async function hooksRead({ hooksPath = resolveHarnessPath(claudeManifest, "rootConfig") } = {}) {
  return hookRecordsFromFile(hooksPath, { trust: "not-required" });
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
    },
    configEdit: jsonConfigEdit,
    mcp: {
      ...stubGroups.mcp,
      remove: mcpRemove,
      addServer: mcpAddServer,
      removeServer: mcpRemoveServer,
      list: mcpList,
    },
    hooks: {
      read: hooksRead,
      core: () => readCoreHooksFragment(),
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
