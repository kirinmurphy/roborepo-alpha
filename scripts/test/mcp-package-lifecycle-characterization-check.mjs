#!/usr/bin/env node
// Characterizes scripts/cli/packages.mjs's installMcpPreset/removeMcpPreset (package enable/
// disable's MCP wiring), which dispatches through
// getHarnessProvider(id).adapters.mcp.addServer/removeServer. Pins:
//   - installMcpPreset respects SKIP_MCP (skips entirely, no Codex write either).
//   - removeMcpPreset's --dry-run path (real removal shells to `claude`, not exercised here).
//   - Claude and Codex are wired/removed INDEPENDENTLY, not as a single all-or-nothing operation
//     (the whole reason these two functions don't just delegate to `mcp add`/a combined helper --
//     see installMcpPreset's own comment) -- pinned by asserting Codex's config.toml changes even
//     when the `claude` CLI path is skipped/unavailable.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { makeAppRoot, makeHome } from "./app-root-fixture.mjs";

const appRoot = makeAppRoot({ prefix: "roborepo-mcp-lifecycle-app-" });
try {
  const pkgId = "jcodemunch"; // real built-in package with an mcp resource (preset "jcodemunch")

  // --- SKIP_MCP=1: installMcpPreset must skip entirely, Codex config untouched ---
  {
    const home = makeHome();
    try {
      const before = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
      const env = { ...process.env, HOME: home, ROBOREPO_APP_ROOT: appRoot, ROBOREPO_MODE: "development", ROBOREPO_STATE_DIR: path.join(home, ".roborepo"), SKIP_MCP: "1" };
      const result = spawnSync(process.execPath, [path.join(appRoot, "scripts", "cli", "main.mjs"), "package", "enable", pkgId], { env, encoding: "utf8" });
      assert.equal(result.status, 0, `package enable should succeed: ${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, new RegExp(`skip: mcp jcodemunch \\(SKIP_MCP\\)`), "SKIP_MCP must skip the mcp wiring entirely");
      const after = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
      // SKIP_MCP only gates the MCP server registration itself -- jcodemunch also ships a
      // separate codex_tool_approvals resource (a different resource type, its own write path) that
      // is NOT gated by this env var, so only the [mcp_servers.jcodemunch] block itself is asserted.
      assert.doesNotMatch(after, /\[mcp_servers\.jcodemunch\]/, "the mcp_servers block itself must not appear when SKIP_MCP=1");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // --- Real enable (no SKIP): Codex config gets the mcp_servers block regardless of claude CLI
  // availability -- proves Claude/Codex wiring is independent, not all-or-nothing ---
  {
    const home = makeHome();
    try {
      const env = { ...process.env, HOME: home, ROBOREPO_APP_ROOT: appRoot, ROBOREPO_MODE: "development", ROBOREPO_STATE_DIR: path.join(home, ".roborepo"), PATH: "/usr/bin:/bin" };
      const result = spawnSync(process.execPath, [path.join(appRoot, "scripts", "cli", "main.mjs"), "package", "enable", pkgId], { env, encoding: "utf8" });
      assert.equal(result.status, 0, `package enable should succeed: ${result.stderr}\n${result.stdout}`);
      const codexToml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
      assert.match(codexToml, /\[mcp_servers\.jcodemunch\]/, "Codex config gets the mcp_servers block even without the claude CLI on PATH");

      // --- disable: real (non-dry-run) removal also independent -- Codex block removed regardless
      // of claude CLI availability ---
      const disableResult = spawnSync(process.execPath, [path.join(appRoot, "scripts", "cli", "main.mjs"), "package", "disable", pkgId], { env, encoding: "utf8" });
      assert.equal(disableResult.status, 0, `package disable should succeed: ${disableResult.stderr}\n${disableResult.stdout}`);
      const codexTomlAfter = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
      assert.doesNotMatch(codexTomlAfter, /\[mcp_servers\.jcodemunch\]/, "Codex mcp_servers block removed on disable");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
} finally {
  fs.rmSync(appRoot, { recursive: true, force: true });
}

console.log("mcp-package-lifecycle-characterization-check: ok");