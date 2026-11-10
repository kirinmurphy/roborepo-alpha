// Codex harness provider: manifest binding and capability adapters. Methods listed in
// stubGroups below are placeholders that throw until their behavior moves here from scripts/cli/.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineHarnessProvider } from "../contract.mjs";
import { detectHarnessProvider, selectedHarnessExecutable } from "../discovery.mjs";
import { resolveHarnessPath } from "../paths.mjs";
import { stubAdapterGroups } from "../stub-adapter.mjs";
import { isHooksMap, unmergeHooksMap } from "../hooks-merge.mjs";
import { readCodexHooks } from "./hooks-read.mjs";
import { mergeCodexHooks } from "./hooks-merge.mjs";
import { codexHookGuidance } from "./hook-guidance.mjs";
import { mergeCodexConfig, normalizeRootConfigContent } from "../../cli/root-config-merge.mjs";
import { resolveBehaviors, resolveArbitraryCommands, renderCodexConfig } from "../permissions-render.mjs";
import { loadPermissionWorkspaceRootsForCwd } from "../permission-workspace-roots.mjs";
import { addCodexMcpBlock, removeCodexMcpBlock, codexHasMcp, listCodexMcpServers } from "../mcp-codex-toml.mjs";
import { transcriptStats, privacySafeRateLimits } from "../transcript-parse.mjs";
import { tomlConfigEdit } from "../config-edit/toml.mjs";
import { locateTranscript, extractHeavyTurns, transcriptTitle } from "../transcript-locate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, "..", "..", "..", "globals", "harnesses", "codex", "provider.json");
const codexManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

// Codex stores hooks in a dedicated hooks.json sidecar, whose whole content is { hooks: {...} } —
// unlike Claude's settings.json, no other top-level keys share this file, and there's no
// drift-tracking write equivalent to writeRootConfig for it. Reads the file itself (plain fs, no
// paths.mjs) and returns { changed, content } — the orchestrator performs the actual write, same
// pattern as Claude's hooksMerge/hooksUnmerge.
function readHooksFile(hooksPath) {
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8")); } catch {}
  return { parsed, hooks: isHooksMap(parsed.hooks) ? parsed.hooks : {} };
}

function hooksMerge(hooksPath, hooksFragment) {
  const { parsed, hooks } = readHooksFile(hooksPath);
  // Append: Codex trust keys are positional, so new entries must not move trusted ones.
  const { hooks: nextHooks, changed } = mergeCodexHooks(hooks, hooksFragment);
  return { changed, content: `${JSON.stringify({ ...parsed, hooks: nextHooks }, null, 2)}\n` };
}

// The executable rule matches discovery's: a Codex CLI on PATH first, then the desktop bundle's
// own binary. Both read the same ~/.codex/config.toml trust state.
function hooksRead({ cwd, hooksPath = resolveHarnessPath(codexManifest, "hooks"), executable, timeoutMs } = {}) {
  return readCodexHooks({
    executable: executable === undefined ? selectedHarnessExecutable(codexManifest) : executable,
    cwd, hooksPath, timeoutMs,
  });
}

// Codex reviews hooks itself: a bare interactive start of its CLI shows "Hooks need review" when
// any are pending, and the desktop app has the same screen under Settings → Hooks. Both record
// trust in ~/.codex/config.toml, so either route serves desktop sessions. `review` tells a caller
// which binary opens that screen; the desktop app's bundled CLI comes first because it matches the
// app the user installed. RoboRepo only opens the screen; every trust decision stays in Codex.
function hooksGuidance() {
  return codexHookGuidance(detectHarnessProvider(codexManifest).evidence);
}

// Core hooks: the ones RoboRepo installs for Codex whatever packages are enabled.
function coreHooks() {
  const corePath = path.resolve(here, "..", "..", "..", "globals", "harnesses", "codex", "hooks-codex.json");
  return JSON.parse(fs.readFileSync(corePath, "utf8")).hooks;
}

function hooksUnmerge(hooksPath, hooksFragment) {
  const { parsed, hooks } = readHooksFile(hooksPath);
  const { hooks: nextHooks, removed } = unmergeHooksMap(hooks, hooksFragment);
  return { changed: removed > 0, content: `${JSON.stringify({ ...parsed, hooks: nextHooks }, null, 2)}\n` };
}

// Telemetry capture's hook fragment is fixed per provider (globals/packages/telemetry/hooks-<id>.json).
// Codex's hooks.json sidecar has no root-config equivalent, so this reuses the same hooksMerge as the
// package-driven hooks.merge adapter above.
function wireCaptureHooks(hooksPath) {
  const fragmentPath = path.resolve(here, "..", "..", "..", "globals", "packages", "telemetry", "hooks-codex.json");
  const fragment = JSON.parse(fs.readFileSync(fragmentPath, "utf8"));
  return hooksMerge(hooksPath, fragment);
}

function locate(sessionId) {
  return locateTranscript(sessionId, "codex");
}

// Shares the same format-tolerant parser as Claude's provider — see the longer note in
// scripts/harnesses/claude/index.mjs's parse().
function parse(transcriptPath, { sessionId, collectorDir, includeHeavyTurns = false } = {}) {
  const stats = transcriptStats(transcriptPath, { sessionId, collectorDir });
  if (!includeHeavyTurns) return { stats, heavyTurns: null, title: null };
  return {
    stats,
    heavyTurns: extractHeavyTurns(transcriptPath, { limit: 8 }),
    title: transcriptTitle(transcriptPath),
  };
}

// Single-server add/remove: unlike Claude, Codex has a real config file to write into directly —
// no CLI shell-out. Thin wrappers over the pure TOML block math in ../mcp-codex-toml.mjs; return
// { changed, content } without writing, the same as hooksMerge above.
function mcpAddServer(spec, { configPath }) {
  const text = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const { changed, content } = addCodexMcpBlock(text, spec);
  return { ok: true, changed, providerId: "codex", action: "mcp.addServer", content };
}

function mcpRemoveServer(name, { configPath }) {
  if (!fs.existsSync(configPath)) return { ok: true, changed: false, providerId: "codex", action: "mcp.removeServer" };
  const text = fs.readFileSync(configPath, "utf8");
  const { changed, content } = removeCodexMcpBlock(text, name);
  return { ok: true, changed, providerId: "codex", action: "mcp.removeServer", content };
}

function mcpList({ configPath }) {
  if (!fs.existsSync(configPath)) return [];
  return listCodexMcpServers(fs.readFileSync(configPath, "utf8"));
}

const stubGroups = stubAdapterGroups("codex", {
  rules: ["render"],
  skills: ["link"],
  commands: ["render"],
  hooks: ["write"],
  mcp: ["add", "remove"],
  session: ["launch"],
});

// merge/render stay thin wrappers over root-config-merge.mjs's existing, characterization-tested
// functions (scripts/test/root-config-merge-characterization-check.mjs) rather than a re-port.
export const codexProvider = defineHarnessProvider({
  manifest: codexManifest,
  adapters: {
    discovery: { detect: () => detectHarnessProvider(codexManifest) },
    ...stubGroups,
    hooks: {
      ...stubGroups.hooks,
      read: hooksRead,
      core: coreHooks,
      guidance: hooksGuidance,
      merge: hooksMerge,
      unmerge: hooksUnmerge,
    },
    telemetry: {
      wireCaptureHooks,
      parseRateLimits: privacySafeRateLimits,
    },
    transcripts: {
      locate,
      parse,
    },
    rootConfig: {
      merge: (repoText, localText) => mergeCodexConfig(repoText, localText),
      render: (content) => normalizeRootConfigContent("codex", content),
    },
    configEdit: tomlConfigEdit,
    permissions: {
      workspaceRoots: ({ cwd } = {}) => loadPermissionWorkspaceRootsForCwd(cwd),
      render: (current, manifest, overrides, target, options = {}) => {
        const behaviors = resolveBehaviors(manifest, overrides.behaviors);
        const arbitraryCommands = resolveArbitraryCommands(manifest, overrides.commands);
        return renderCodexConfig(current, behaviors, arbitraryCommands, target, options);
      },
    },
    mcp: {
      ...stubGroups.mcp,
      addServer: mcpAddServer,
      removeServer: mcpRemoveServer,
      list: mcpList,
    },
  },
});
