#!/usr/bin/env node
// Characterization test for the Claude provider's mcp.remove adapter (scripts/harnesses/claude/
// index.mjs), ported from scripts/install/uninstall.sh's remove_mcp_servers. Pins: only servers
// declaring "claude" in their harnesses array (from manifests/inventory/mcp-servers.json) are
// removed; top-level mcpServers and every project-scoped mcpServers map are pruned; entries not
// matching a known server name are left untouched; a missing ~/.claude.json is a no-op, not a
// failure.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { claudeProvider } = await import("../harnesses/claude/index.mjs");

function testPrunesKnownServersOnly() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-mcp-remove-"));
  const homePath = path.join(tmp, ".claude");
  fs.mkdirSync(homePath, { recursive: true });
  const claudeJsonPath = path.join(tmp, ".claude.json");
  fs.writeFileSync(claudeJsonPath, JSON.stringify({
    mcpServers: {
      jcodemunch: { command: "uvx", args: ["jcodemunch-mcp"] },
      "unrelated-server": { command: "foo" },
    },
    projects: {
      "/some/project": { mcpServers: { jdocmunch: { command: "uvx", args: ["jdocmunch-mcp"] } } },
    },
  }));

  const result = claudeProvider.adapters.mcp.remove({ homePath });
  assert.equal(result.ok, true, "remove must report ok");
  assert.equal(result.changed, true, "remove must report changed when it pruned entries");
  assert.equal(result.providerId, "claude");

  const after = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
  assert.deepEqual(Object.keys(after.mcpServers), ["unrelated-server"], "must remove only known builtin-managed server names");
  assert.deepEqual(after.projects["/some/project"].mcpServers, {}, "must prune project-scoped mcpServers maps too");

  fs.rmSync(tmp, { recursive: true, force: true });
}

function testMissingClaudeJsonIsNoop() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-mcp-remove-missing-"));
  const homePath = path.join(tmp, ".claude");
  fs.mkdirSync(homePath, { recursive: true });

  const result = claudeProvider.adapters.mcp.remove({ homePath });
  assert.equal(result.ok, true, "missing ~/.claude.json must not be reported as a failure");
  assert.equal(result.changed, false, "nothing to change when there's no file to prune");

  fs.rmSync(tmp, { recursive: true, force: true });
}

function testDryRunMakesNoChange() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-mcp-remove-dryrun-"));
  const homePath = path.join(tmp, ".claude");
  fs.mkdirSync(homePath, { recursive: true });
  const claudeJsonPath = path.join(tmp, ".claude.json");
  const before = JSON.stringify({ mcpServers: { jcodemunch: { command: "uvx" } } });
  fs.writeFileSync(claudeJsonPath, before);

  const result = claudeProvider.adapters.mcp.remove({ homePath, dryRun: true });
  assert.equal(result.changed, false, "dry-run must never report changed");
  assert.equal(fs.readFileSync(claudeJsonPath, "utf8"), before, "dry-run must not touch the file");

  fs.rmSync(tmp, { recursive: true, force: true });
}

testPrunesKnownServersOnly();
testMissingClaudeJsonIsNoop();
testDryRunMakesNoChange();

console.log("harness Claude mcp.remove characterization: all checks passed");
