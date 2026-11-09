// Codex's package-resource adapters: per-tool MCP approval modes a package owns in
// ~/.codex/config.toml ([mcp_servers.<server>.tools.<tool>] approval_mode = "..."). The package
// system hands each method an io object ({ configPath, write }); write persists the new TOML text
// through the package system's tracked root-config write.

import fs from "node:fs";

function readText(configPath) {
  try { return fs.readFileSync(configPath, "utf8"); } catch { return ""; }
}

function tomlTableKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toolApprovalTable(resource, toolName) {
  return `[mcp_servers.${tomlTableKey(resource.server)}.tools.${tomlTableKey(toolName)}]`;
}

function mergeToolApprovals(resource, io) {
  let text = readText(io.configPath);
  let changed = false;
  for (const [toolName, approvalMode] of Object.entries(resource.approvals || {})) {
    const table = toolApprovalTable(resource, toolName);
    const blockPattern = new RegExp(`(^${escapeRegExp(table)}\\n)([^[]*)`, "m");
    const nextLine = `approval_mode = ${JSON.stringify(approvalMode)}\n`;
    if (blockPattern.test(text)) {
      text = text.replace(blockPattern, (_match, header, body) => {
        if (/^approval_mode\s*=/m.test(body)) {
          const nextBody = body.replace(/^approval_mode\s*=.*$/m, nextLine.trim());
          if (nextBody !== body) changed = true;
          return `${header}${nextBody}`;
        }
        changed = true;
        return `${header}${nextLine}${body}`;
      });
    } else {
      text = `${text.endsWith("\n") ? text : `${text}\n`}\n${table}\n${nextLine}`;
      changed = true;
    }
  }
  if (!changed) { console.log(`ok: Codex tool approvals already present → ${io.configPath}`); return; }
  io.write(text);
  console.log(`wired: Codex tool approvals → ${io.configPath}`);
}

function unmergeToolApprovals(resource, io) {
  let text = readText(io.configPath);
  let changed = false;
  for (const toolName of Object.keys(resource.approvals || {})) {
    const blockPattern = new RegExp(`\\n?^${escapeRegExp(toolApprovalTable(resource, toolName))}\\n[^[]*(?=^\\[|$)`, "m");
    if (blockPattern.test(text)) {
      text = text.replace(blockPattern, (match) => {
        changed = true;
        return match.startsWith("\n") ? "\n" : "";
      });
    }
  }
  if (!changed) { console.log(`ok: Codex tool approvals already absent ← ${io.configPath}`); return; }
  io.write(text.replace(/\n{3,}/g, "\n\n"));
  console.log(`removed: Codex tool approvals ← ${io.configPath}`);
}

function probeToolApprovals(resource, { configPath }) {
  const config = readText(configPath);
  const approvals = Object.entries(resource.approvals || {});
  const missing = approvals.filter(([toolName, approvalMode]) => {
    const pattern = `^\\[mcp_servers\\.${escapeRegExp(resource.server)}\\.tools\\.${escapeRegExp(toolName)}\\]\\s*\\napproval_mode\\s*=\\s*"${escapeRegExp(approvalMode)}"`;
    return !new RegExp(pattern, "m").test(config);
  });
  return {
    observed: missing.length === 0,
    detail: missing.length ? `${missing.length} Codex tool approval(s) missing` : `${approvals.length} Codex tool approval(s) present`,
  };
}

export const codexPackageAdapters = { mergeToolApprovals, unmergeToolApprovals, probeToolApprovals };
