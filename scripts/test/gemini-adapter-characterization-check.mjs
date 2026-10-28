#!/usr/bin/env node
// Characterization tests for the Gemini CLI provider adapter (scripts/harnesses/gemini/index.mjs,
// scripts/harnesses/gemini/policy-toml.mjs) — the first real (non-synthetic) third harness
// provider.
//
// Mirrors permissions-render-live-characterization-check.mjs and root-config-merge-
// characterization-check.mjs's style: pin exact render/merge output for the cases specific to
// Gemini's native shape (Policy Engine TOML decision mapping, mcpServers JSON key, hooks embedded
// in settings.json like Claude rather than a sidecar like Codex).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.ROBOREPO_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { geminiProvider } = await import("../harnesses/gemini/index.mjs");
const { renderGeminiPolicyRules } = await import("../harnesses/gemini/policy-toml.mjs");

function makeTmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-gemini-adapter-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return { dir, filePath };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- rootConfig: plain-object deep merge, arrays deduped, mirrors mergeClaudeSettings's shape ---
function testRootConfigMerge() {
  const repo = JSON.stringify({ contextFileName: "GEMINI.md", mcpServers: { a: { command: "x" } } });
  const local = JSON.stringify({ mcpServers: { b: { command: "y" } }, customField: true });
  const merged = JSON.parse(geminiProvider.adapters.rootConfig.merge(repo, local));
  assert.equal(merged.contextFileName, "GEMINI.md", "repo-only field is kept");
  assert.equal(merged.customField, true, "local-only field is kept");
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["a", "b"], "mcpServers objects deep-merge by key, not overwrite");
}

function testRootConfigRenderNormalizes() {
  const rendered = geminiProvider.adapters.rootConfig.render('{"b":2,"a":1}');
  assert.equal(rendered, `${JSON.stringify({ b: 2, a: 1 }, null, 2)}\n`, "render reserializes with stable 2-space formatting");
}

// --- permissions: Policy Engine TOML, "ask" bucket maps to native "ask_user" decision (NOT bare
// "ask" -- the Policy Engine's own enum is allow/deny/ask_user, confirmed via the installed
// @google/gemini-cli@0.53.1 bundle's docs/reference/policy-engine.md) ---
function testPermissionsAskMapsToAskUser() {
  const manifest = {
    behaviors: [{ id: "delete-files", kind: "commands", commands: [["rm"]], bucket: "ask" }],
  };
  const rendered = renderGeminiPolicyRules(geminiProvider.manifest, manifest);
  assert.match(rendered, /decision = "ask_user"/, "manifest 'ask' bucket must render as Gemini's native ask_user decision");
  assert.doesNotMatch(rendered, /decision = "ask"\n/, "bare 'ask' (not a real Gemini decision) must never appear");
}

// --- permissions: kind:"tools" behaviors map through the verified Claude-tool-name ->
// Gemini-tool-name table (write_file/replace/read_file — sourced from the installed package's own
// WRITE_FILE_TOOL_NAME/EDIT_TOOL_NAME/READ_FILE_TOOL_NAME constants in chunk-2NH5AG3B.js, not
// guessed from docs) ---
function testPermissionsToolsKindMapsToGeminiToolNames() {
  const manifest = {
    behaviors: [{ id: "write-files", kind: "tools", tools: ["Write", "Edit"], bucket: "allow" }],
  };
  // Uses the real provider manifest (globals/harnesses/gemini/provider.json, via geminiProvider)
  // rather than a fabricated toolNameMap, so this test also pins that the real manifest declares
  // the mapping this render path depends on.
  const rendered = renderGeminiPolicyRules(geminiProvider.manifest, manifest);
  assert.match(rendered, /toolName = \["write_file", "replace"\]/, "Write/Edit must map to write_file/replace via the provider manifest's own toolNameMap");
}

// --- permissions: kind:"network" (Codex-only sandbox concept) renders nothing, same as Claude's
// claudePermissions skipping it ---
function testPermissionsNetworkKindSkipped() {
  const manifest = {
    behaviors: [{ id: "go-online", kind: "network", codexOnly: true, bucket: "deny" }],
  };
  const rendered = renderGeminiPolicyRules(geminiProvider.manifest, manifest);
  assert.equal(rendered.trim(), "", "network-kind behavior has no Gemini render target and must produce no rule");
}

// --- permissions: arbitrary commands render as run_shell_command + commandPrefix rules ---
function testPermissionsArbitraryCommand() {
  const manifest = { commands: { allow: [["npm", "test"]] } };
  const rendered = renderGeminiPolicyRules(geminiProvider.manifest, manifest);
  assert.match(rendered, /toolName = "run_shell_command"/, "arbitrary commands target run_shell_command");
  assert.match(rendered, /commandPrefix = "npm test"/, "arbitrary command tokens join into a single commandPrefix string");
  assert.match(rendered, /decision = "allow"/, "manifest.commands.allow entries default to allow");
}

// --- permissions: adapter's render ignores `current` (roborepo fully owns the generated policy
// file, no merge-into-existing-content like Claude/Codex's rootConfig) ---
function testPermissionsRenderIgnoresCurrent() {
  const manifest = { behaviors: [], commands: { allow: [] } };
  const withGarbageCurrent = geminiProvider.adapters.permissions.render("garbage-not-toml", manifest, {});
  const withEmptyCurrent = geminiProvider.adapters.permissions.render("", manifest, {});
  assert.equal(withGarbageCurrent, withEmptyCurrent, "render output must not depend on `current` — the file is fully regenerated, not merged");
  assert.match(withGarbageCurrent, /^# Generated by roborepo/, "rendered file always starts with roborepo's own header");
}

// --- hooks: embedded in settings.json's "hooks" key (like Claude), not a dedicated sidecar (like
// Codex) -- merge/unmerge round-trip via the shared hooks-merge.mjs pure logic ---
function testHooksMergeAndUnmerge() {
  const { dir, filePath } = makeTmpFile("settings.json", "{}");
  try {
    const fragment = { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ type: "command", command: "echo hi" }] }] };
    const { changed: mergedChanged, content: mergedContent } = geminiProvider.adapters.hooks.merge(filePath, fragment);
    assert.equal(mergedChanged, true, "merging a new hook fragment reports changed");
    const mergedSettings = JSON.parse(mergedContent);
    assert.equal(mergedSettings.hooks.BeforeTool[0].hooks[0].command, "echo hi", "hook fragment is written under settings.json's hooks key");

    fs.writeFileSync(filePath, mergedContent);
    const { changed: unmergedChanged, content: unmergedContent } = geminiProvider.adapters.hooks.unmerge(filePath, fragment);
    assert.equal(unmergedChanged, true, "unmerging the same fragment reports changed");
    const unmergedSettings = JSON.parse(unmergedContent);
    assert.equal(unmergedSettings.hooks, undefined, "removing the only hook entry drops the now-empty hooks key entirely");
  } finally {
    cleanup(dir);
  }
}

// --- mcp: settings.json's mcpServers key, confirmed real via `gemini mcp add ... --scope user`
// -- {command, args} for stdio, direct object write, no CLI shell-out required ---
function testMcpAddListRemoveRoundTrip() {
  const { dir, filePath } = makeTmpFile("settings.json", "{}");
  try {
    const addResult = geminiProvider.adapters.mcp.addServer({ name: "test-server", commandOrUrl: "echo", args: ["hello"] }, { configPath: filePath });
    assert.equal(addResult.changed, true, "adding a new server reports changed");
    const addedSettings = JSON.parse(addResult.content);
    assert.deepEqual(addedSettings.mcpServers["test-server"], { command: "echo", args: ["hello"] }, "stdio server writes {command, args} exactly as gemini's own CLI does");

    fs.writeFileSync(filePath, addResult.content);
    assert.deepEqual(geminiProvider.adapters.mcp.list({ configPath: filePath }), ["test-server"], "list enumerates mcpServers keys");

    const removeResult = geminiProvider.adapters.mcp.removeServer("test-server", { configPath: filePath });
    assert.equal(removeResult.changed, true, "removing an existing server reports changed");
    const removedSettings = JSON.parse(removeResult.content);
    assert.equal(removedSettings.mcpServers, undefined, "removing the only server drops the now-empty mcpServers key entirely");
  } finally {
    cleanup(dir);
  }
}

function testMcpAddHttpTransport() {
  const { dir, filePath } = makeTmpFile("settings.json", "{}");
  try {
    const result = geminiProvider.adapters.mcp.addServer({ name: "remote", commandOrUrl: "https://example.com/mcp", transport: "http" }, { configPath: filePath });
    const settings = JSON.parse(result.content);
    assert.deepEqual(settings.mcpServers.remote, { httpUrl: "https://example.com/mcp" }, "http transport writes {httpUrl}, not {command, args}");
  } finally {
    cleanup(dir);
  }
}

testRootConfigMerge();
testRootConfigRenderNormalizes();
testPermissionsAskMapsToAskUser();
testPermissionsToolsKindMapsToGeminiToolNames();
testPermissionsNetworkKindSkipped();
testPermissionsArbitraryCommand();
testPermissionsRenderIgnoresCurrent();
testHooksMergeAndUnmerge();
testMcpAddListRemoveRoundTrip();
testMcpAddHttpTransport();

console.log("gemini-adapter-characterization-check: ok");
