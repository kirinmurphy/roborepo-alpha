// Codex harness provider: manifest binding and capability adapters. Methods listed in
// stubGroups below are placeholders that throw until their behavior moves here from scripts/cli/.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineHarnessProvider } from "../contract.mjs";
import { detectHarnessProvider } from "../discovery.mjs";
import { stubAdapterGroups } from "../stub-adapter.mjs";
import { isHooksMap, mergeHooksMap, unmergeHooksMap } from "../hooks-merge.mjs";
import { mergeCodexConfig, normalizeRootConfigContent } from "../../cli/root-config-merge.mjs";
import { clearOwnedScalar, readOwnedScalar, recordOwnedScalar } from "../../cli/owned-scalars-state.mjs";
import { resolveBehaviors, resolveArbitraryCommands, renderCodexConfig } from "../permissions-render.mjs";
import { loadPermissionWorkspaceRootsForCwd } from "../permission-workspace-roots.mjs";
import { addCodexMcpBlock, removeCodexMcpBlock, codexHasMcp, listCodexMcpServers } from "../mcp-codex-toml.mjs";
import { transcriptStats, privacySafeRateLimits } from "../transcript-parse.mjs";
import { locateTranscript, extractHeavyTurns, transcriptTitle } from "../transcript-locate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, "..", "..", "..", "globals", "harnesses", "codex", "provider.json");
const codexManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

// --- TOML [table] array/scalar helpers, moved unchanged from package-harness-config.mjs. Only
// Codex needs these (Claude's package config is a JSON statusLine key, handled entirely by the
// Claude provider's own mergePackageComponent). ---

function tomlArrayLine(key, values) {
  return `${key} = [${values.map((value) => JSON.stringify(String(value))).join(", ")}]\n`;
}

function tomlTableKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tableHeader(table) {
  return `[${tomlTableKey(table)}]`;
}

// Captures a table's body as everything from just after its `[header]\n` up to the next table
// header (`^[`) or the true end of the string. The end-of-string branch is `$(?![\s\S])` — NOT a
// bare `\s*$`: under the `m` flag `$` matches every line end, so a lazy body + `\s*$` would stop at
// the FIRST line, silently excluding later keys in the same table (e.g. a scalar written after an
// array) and causing duplicate-key appends on re-write. Anchoring to absolute end keeps the whole
// table body in one capture.
function tableBlockPattern(table) {
  const header = tableHeader(table).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^${header}\\n)([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, "m");
}

function parseTomlArray(body, key) {
  const match = body.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"));
  if (!match) return null;
  return [...match[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((entry) => JSON.parse(`"${entry[1]}"`));
}

function mergeTomlArray(text, table, key, values) {
  const pattern = tableBlockPattern(table);
  const deduped = (existing) => [...new Set([...existing, ...values.map(String)])];
  if (pattern.test(text)) {
    return {
      text: text.replace(pattern, (_match, header, body) => {
        const existing = parseTomlArray(body, key);
        if (existing) {
          return `${header}${body.replace(new RegExp(`^${key}\\s*=\\s*\\[[^\\]]*\\].*\\n?`, "m"), tomlArrayLine(key, deduped(existing)))}`;
        }
        const prefix = body.endsWith("\n") || body.length === 0 ? body : `${body}\n`;
        return `${header}${prefix}${tomlArrayLine(key, deduped([]))}`;
      }),
    };
  }
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  return { text: `${prefix}${prefix ? "\n" : ""}${tableHeader(table)}\n${tomlArrayLine(key, deduped([]))}` };
}

function unmergeTomlArray(text, table, key, values) {
  const pattern = tableBlockPattern(table);
  if (!pattern.test(text)) return text;
  const owned = new Set(values.map(String));
  return text.replace(pattern, (_match, header, body) => {
    const existing = parseTomlArray(body, key);
    if (!existing) return `${header}${body}`;
    const nextValues = existing.filter((value) => !owned.has(value));
    return `${header}${body.replace(new RegExp(`^${key}\\s*=\\s*\\[[^\\]]*\\].*\\n?`, "m"), tomlArrayLine(key, nextValues))}`;
  }).replace(/\n{3,}/g, "\n\n");
}

// Read a boolean scalar's current value from a TOML table. Returns undefined when the table or key
// is absent — the caller distinguishes "absent" (safe to remove on disable) from a real value.
function getTomlScalar(text, table, key) {
  const match = text.match(tableBlockPattern(table));
  if (!match) return undefined;
  const line = match[2].match(new RegExp(`^${key}\\s*=\\s*(true|false)`, "m"));
  return line ? line[1] === "true" : undefined;
}

function removeTomlScalar(text, table, key) {
  const pattern = tableBlockPattern(table);
  if (!pattern.test(text)) return text;
  return text
    .replace(pattern, (_match, header, body) => `${header}${body.replace(new RegExp(`^${key}\\s*=.*\\n?`, "m"), "")}`)
    .replace(/\n{3,}/g, "\n\n");
}

function setTomlScalar(text, table, key, value) {
  const pattern = tableBlockPattern(table);
  const line = `${key} = ${value ? "true" : "false"}\n`;
  if (pattern.test(text)) {
    return text.replace(pattern, (_match, header, body) => {
      if (new RegExp(`^${key}\\s*=`, "m").test(body)) {
        return `${header}${body.replace(new RegExp(`^${key}\\s*=.*\\n?`, "m"), line)}`;
      }
      const prefix = body.endsWith("\n") || body.length === 0 ? body : `${body}\n`;
      return `${header}${prefix}${line}`;
    });
  }
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  return `${prefix}${prefix ? "\n" : ""}${tableHeader(table)}\n${line}`;
}

const COLORS_KEY = "status_line_use_colors";

// Own the color scalar safely. On the first enable, an existing value we didn't set is unmanaged: if
// it disagrees with what we want, preserve it and report rather than corrupt it. Once roborepo has
// recorded ownership, subsequent enables freely reassert the desired value (the user's original is
// safe in provenance and restored on disable).
function mergeCodexColorScalar(text, desiredValue) {
  const priorRecord = readOwnedScalar("codex", "tui", COLORS_KEY);
  const current = getTomlScalar(text, "tui", COLORS_KEY);
  if (!priorRecord && current !== undefined && current !== desiredValue) {
    console.warn(`  conflict: Codex tui.${COLORS_KEY} is unmanaged; leaving it unchanged`);
    return text;
  }
  recordOwnedScalar("codex", "tui", COLORS_KEY, current);
  return setTomlScalar(text, "tui", COLORS_KEY, desiredValue);
}

// Restore the color scalar to its provenance: put back an unmanaged prior value, or remove the key
// entirely if roborepo introduced it. Only touches the scalar when roborepo recorded ownership, so
// a manual user value set after enable is never clobbered.
function unmergeCodexColorScalar(text) {
  const record = readOwnedScalar("codex", "tui", COLORS_KEY);
  if (!record) return text;
  const next = record.existed
    ? setTomlScalar(text, "tui", COLORS_KEY, record.priorValue)
    : removeTomlScalar(text, "tui", COLORS_KEY);
  clearOwnedScalar("codex", "tui", COLORS_KEY);
  return next;
}

// mergePackageComponent/unmergePackageComponent take the already-read component config (not the
// raw component) so this module never needs package-harness-config.mjs's readHarnessConfig, which
// depends on paths.mjs's harness-path section -> registry.mjs -> this module — a cycle.
//
// Returns { changed, content } rather than writing the file itself: writeRootConfig (drift-state
// bookkeeping) lives behind paths.mjs's harness-path section too, so a provider adapter calling it
// directly would recreate the same cycle. The orchestrator (package-harness-config.mjs), which sits
// above both the provider and paths.mjs in the dependency graph, performs the actual write.
function mergePackageComponent(pkg, config, { codexConfigPath }) {
  const tui = config.tui || {};
  const desired = Array.isArray(tui.status_line) ? tui.status_line : [];
  if (desired.length === 0) throw new Error("Codex harness-config needs non-empty tui.status_line");
  let text = "";
  try { text = fs.readFileSync(codexConfigPath, "utf8"); } catch {}
  let next = mergeTomlArray(text, "tui", "status_line", desired).text;
  if (typeof tui.status_line_use_colors === "boolean") {
    next = mergeCodexColorScalar(next, tui.status_line_use_colors);
  }
  return { changed: next !== text, content: next };
}

function unmergePackageComponent(pkg, config, { codexConfigPath }) {
  const tui = config.tui || {};
  const owned = Array.isArray(tui.status_line) ? tui.status_line : [];
  let text = "";
  try { text = fs.readFileSync(codexConfigPath, "utf8"); } catch {}
  let next = unmergeTomlArray(text, "tui", "status_line", owned);
  if (typeof tui.status_line_use_colors === "boolean") {
    next = unmergeCodexColorScalar(next);
  }
  return { changed: next !== text, content: next };
}

// Codex stores hooks in a dedicated hooks.json sidecar, whose whole content is { hooks: {...} } —
// unlike Claude's settings.json, no other top-level keys share this file, and there's no
// drift-tracking write equivalent to writeRootConfig for it. Reads the file itself (plain fs, no
// paths.mjs) and returns { changed, content } — the orchestrator performs the actual write, same
// pattern as Claude's hooksMerge/hooksUnmerge and mergePackageComponent above.
function readHooksFile(hooksPath) {
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8")); } catch {}
  return { parsed, hooks: isHooksMap(parsed.hooks) ? parsed.hooks : {} };
}

function hooksMerge(hooksPath, hooksFragment) {
  const { parsed, hooks } = readHooksFile(hooksPath);
  const { hooks: nextHooks, added } = mergeHooksMap(hooks, hooksFragment);
  return { changed: added > 0, content: `${JSON.stringify({ ...parsed, hooks: nextHooks }, null, 2)}\n` };
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
// { changed, content } without writing, same pattern as rootConfig.mergePackageComponent above.
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
  hooks: ["read", "write"],
  mcp: ["add", "remove"],
  session: ["launch"],
});

// merge/render stay thin wrappers over root-config-merge.mjs's existing, characterization-tested
// functions (scripts/test/{root-config-merge,package-harness-config}-characterization-check.mjs)
// rather than a re-port — this phase moves OWNERSHIP behind the provider contract, not the
// implementation itself.
export const codexProvider = defineHarnessProvider({
  manifest: codexManifest,
  adapters: {
    discovery: { detect: () => detectHarnessProvider(codexManifest) },
    ...stubGroups,
    hooks: {
      ...stubGroups.hooks,
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
      mergePackageComponent,
      unmergePackageComponent,
    },
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
