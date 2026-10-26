#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-mcp-codex-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.HOME = tmp;
process.env.ROBOREPO_STATE_DIR = path.join(tmp, ".roborepo");

const codexDir = path.join(tmp, ".codex");
const codexConfig = path.join(codexDir, "config.toml");
fs.mkdirSync(codexDir, { recursive: true });

const { ensureCodexMcp, removeCodexMcp } = await import("../cli/mcp-codex.mjs");
const { checkDrift } = await import("../cli/root-config-state.mjs");

ensureCodexMcp({ name: "unit-server", commandOrUrl: "uvx", args: ["unit-mcp"] });
let text = fs.readFileSync(codexConfig, "utf8");
assert.match(text, /\[mcp_servers\.unit-server\]/, "MCP block is written to active Codex config");
assert.equal(checkDrift("codex", codexConfig).status, "clean", "MCP add records active root-config hash");

removeCodexMcp("unit-server");
text = fs.readFileSync(codexConfig, "utf8");
assert.doesNotMatch(text, /unit-server/, "MCP block is removed from active Codex config");
assert.equal(checkDrift("codex", codexConfig).status, "clean", "MCP remove records active root-config hash");

console.log("mcp-codex-active ok");
