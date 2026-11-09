import fs from "node:fs";
import { rootConfigActive, rootConfigBaseline } from "./paths.mjs";
import { displayPath } from "./mcp-config.mjs";
import { writeRootConfig } from "./root-config-writes.mjs";
import { claudeMcpArgs, runClaudeMcpAdd } from "../harnesses/claude/mcp-claude-cli.mjs";
import { shellQuote } from "../harnesses/shell-quote.mjs";
import { addMcpPermission } from "../harnesses/claude/mcp-permission.mjs";

// claudeMcpArgs/runClaudeMcpAdd live in scripts/harnesses/claude/mcp-claude-cli.mjs (a leaf
// module with zero registry-touching imports) so the Claude provider adapter can call them
// directly; re-exported here for existing consumers (mcp.mjs).
export { shellQuote, claudeMcpArgs, runClaudeMcpAdd };

// The MCP permission grant targets the ACTIVE Claude settings (~/.claude/settings.json) — the file
// the harness actually reads — not the repo baseline template. In package mode there is no writable
// baseline (appRoot is immutable release files), and even in a dev checkout the active file is a
// separate copy, not a symlink to the tracked source. writeRootConfig routes the write through the
// same drift-state recording + normalization Codex already uses, so a later `apply` won't clobber
// this grant. When the active file does not exist yet, the baseline seeds the initial permission set.
export function ensureClaudeMcpPermission(serverName) {
  const activePath = rootConfigActive.claude;
  const settings = readClaudeSettings(activePath) ?? readClaudeSettings(rootConfigBaseline.claude) ?? {};
  const { permission, changed } = addMcpPermission(settings, serverName);
  if (!changed) {
    console.log(`permission already present: ${permission}`);
    return;
  }
  writeRootConfig("claude", activePath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`permission added: ${permission} -> ${displayPath(activePath)}`);
}

function readClaudeSettings(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
