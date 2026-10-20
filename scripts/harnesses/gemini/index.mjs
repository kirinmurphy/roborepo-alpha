// Gemini CLI harness provider — the first real (non-synthetic) third provider, proving the
// registry/adapter contract against actual native config complexity.
//
// rules/skills/commands/hooks.read+write/mcp.add+remove stay stubbed (notYetMigrated), matching
// the current bar for Claude and Codex — those capabilities are declared in the manifest (real,
// verified shapes exist) but their render/link logic still lives in scripts/cli/*.mjs, unmigrated
// for any provider yet (not specific to Gemini).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineHarnessProvider } from "../contract.mjs";
import { detectHarnessProvider } from "../discovery.mjs";
import { stubAdapterGroups } from "../stub-adapter.mjs";
import { mergeRootConfigHooks, unmergeRootConfigHooks } from "../root-config-hooks.mjs";
import { renderGeminiPolicyFile, GENERATED_POLICY_FILENAME } from "./policy-toml.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, "..", "..", "..", "globals", "harnesses", "gemini", "provider.json");
const geminiManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniqueByJson(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// Recursive object merge, arrays deduped by JSON identity — same policy as
// scripts/cli/root-config-merge.mjs's mergeObjects/mergeArrays for Claude's settings.json.
// Gemini's settings.json shares that shape closely enough (plain JSON object, hooks/mcpServers
// nested keys) to reuse the same merge rule directly, rather than a re-port.
function mergeObjects(repo, local) {
  const out = { ...(repo || {}) };
  for (const [key, localValue] of Object.entries(local || {})) {
    const repoValue = out[key];
    if (Array.isArray(repoValue) && Array.isArray(localValue)) {
      out[key] = uniqueByJson([...repoValue, ...localValue]);
      continue;
    }
    if (isPlainObject(repoValue) && isPlainObject(localValue)) {
      out[key] = mergeObjects(repoValue, localValue);
      continue;
    }
    out[key] = localValue;
  }
  return out;
}

function mergeGeminiSettings(repoText, localText) {
  let repo = {};
  let local = {};
  try { repo = JSON.parse(repoText || "{}"); } catch {}
  try { local = JSON.parse(localText || "{}"); } catch {}

  const merged = mergeObjects(repo, local);
  if (local.hooks && isPlainObject(local.hooks) && isPlainObject(repo.hooks)) {
    merged.hooks = mergeObjects(repo.hooks, local.hooks);
  }
  if (local.mcpServers && isPlainObject(local.mcpServers) && isPlainObject(repo.mcpServers)) {
    merged.mcpServers = mergeObjects(repo.mcpServers, local.mcpServers);
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function normalizeGeminiRootConfig(content) {
  try {
    const settings = JSON.parse(content || "{}");
    return `${JSON.stringify(settings, null, 2)}\n`;
  } catch {
    return content;
  }
}

// Gemini stores hooks nested under settings.json's "hooks" key, same location and shape as
// Claude's settings.json (not a dedicated sidecar like Codex's hooks.json) — the read/merge/
// unmerge wrapper is shared via root-config-hooks.mjs rather than duplicated per provider, since
// the hook-definition shape ({matcher, sequential, hooks:[{type, command, ...}]}) keys off the same
// entry.hooks[0].command identity Claude's hooks do (bundle/docs/hooks/reference.md's
// Configuration schema table).

// Permissions render targets one whole roborepo-owned file inside ~/.gemini/policies/ (the Policy
// Engine directory loads every *.toml file present and combines their rules — no generated-marker-
// block-inside-an-existing-file merge like Claude/Codex's rootConfig needs), so `current` is
// ignored: roborepo fully owns this file's content, same "never touch what we don't own" posture
// as Claude/Codex's renderers, just expressed as "always fully regenerate the one file we own"
// instead of "merge a marked block into a shared file." 4th param (target path) unused here, same
// as Claude's render — kept for signature parity with permissions-render.mjs's uniform call site.
//
// `behaviorManifest` here is manifests/inventory/agent-permissions.json's content (behaviors/
// commands to render), distinct from this module's own `geminiManifest` (globals/harnesses/gemini/
// provider.json, the harness provider manifest) — renderGeminiPolicyRules needs the LATTER too, for
// its extensions.app.toolNameMap tool-name translation table, so it's passed separately rather
// than threaded through the call signature every other provider's render already uses.
function renderGeminiPermissions(_current, behaviorManifest, overrides) {
  return renderGeminiPolicyFile(geminiManifest, behaviorManifest, overrides);
}

// Single-server add/remove: Gemini has a real config file to write into directly (settings.json's
// mcpServers key), confirmed via a real `gemini mcp add test-server echo hello --scope user` call
// {command, args} for stdio, {url}/{httpUrl} for sse/http, no CLI shell-
// out required unlike Claude. Same { changed, content } return shape as Codex's mcpAddServer.
function readSettingsMcp(settingsPath) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
  return { settings, mcpServers: isPlainObject(settings.mcpServers) ? settings.mcpServers : {} };
}

function mcpServerEntry(spec) {
  if (spec.transport === "sse" || spec.transport === "http") {
    const key = spec.transport === "http" ? "httpUrl" : "url";
    return { [key]: spec.commandOrUrl, ...(spec.env ? { env: spec.env } : {}) };
  }
  return { command: spec.commandOrUrl, args: spec.args ?? [], ...(spec.env ? { env: spec.env } : {}) };
}

function mcpAddServer(spec, { configPath }) {
  const { settings, mcpServers } = readSettingsMcp(configPath);
  const nextSettings = { ...settings, mcpServers: { ...mcpServers, [spec.name]: mcpServerEntry(spec) } };
  return { ok: true, changed: true, providerId: "gemini", action: "mcp.addServer", content: `${JSON.stringify(nextSettings, null, 2)}\n` };
}

function mcpRemoveServer(name, { configPath }) {
  if (!fs.existsSync(configPath)) return { ok: true, changed: false, providerId: "gemini", action: "mcp.removeServer" };
  const { settings, mcpServers } = readSettingsMcp(configPath);
  if (!(name in mcpServers)) return { ok: true, changed: false, providerId: "gemini", action: "mcp.removeServer" };
  const nextServers = { ...mcpServers };
  delete nextServers[name];
  const nextSettings = { ...settings };
  if (Object.keys(nextServers).length > 0) nextSettings.mcpServers = nextServers;
  else delete nextSettings.mcpServers;
  return { ok: true, changed: true, providerId: "gemini", action: "mcp.removeServer", content: `${JSON.stringify(nextSettings, null, 2)}\n` };
}

function mcpList({ configPath }) {
  if (!fs.existsSync(configPath)) return [];
  const { mcpServers } = readSettingsMcp(configPath);
  return Object.keys(mcpServers);
}

const stubGroups = stubAdapterGroups("gemini", {
  rules: ["render"],
  skills: ["link"],
  commands: ["render"],
  hooks: ["read", "write"],
  mcp: ["add", "remove"],
});

export const geminiProvider = defineHarnessProvider({
  manifest: geminiManifest,
  adapters: {
    discovery: { detect: () => detectHarnessProvider(geminiManifest) },
    ...stubGroups,
    rootConfig: {
      merge: (repoText, localText) => mergeGeminiSettings(repoText, localText),
      render: (content) => normalizeGeminiRootConfig(content),
    },
    permissions: {
      render: renderGeminiPermissions,
    },
    hooks: {
      ...stubGroups.hooks,
      merge: mergeRootConfigHooks,
      unmerge: unmergeRootConfigHooks,
    },
    mcp: {
      ...stubGroups.mcp,
      addServer: mcpAddServer,
      removeServer: mcpRemoveServer,
      list: mcpList,
    },
  },
});

export { GENERATED_POLICY_FILENAME };
