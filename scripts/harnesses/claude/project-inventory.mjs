// Claude Code's native project files, as the optional `projectInventory` adapter group describes
// them. Patterns follow Claude Code's project memory, settings, and skills docs: CLAUDE.md (root,
// .claude/, nested), CLAUDE.local.md, .claude/rules/, .claude/skills/<name>/SKILL.md (root and
// nested), .claude/settings*.json, .mcp.json, .claude/agents/, and .claude/commands/.
//
// Claude Code also reads AGENTS.md, but by default only where no CLAUDE.md, .claude/CLAUDE.md, or
// CLAUDE.local.md sits in the working directory or above it, and its "Project instructions" setting
// can change that. Whether it loads is not computed here, so AGENTS.md is listed for Claude as
// potentially conditional, alongside its Codex entry.

import {
  LOADING, segmentsOf, isRootLevel, matchSkillPath, matchLinkedFolder, describeMarkdown, parseJsonObject, safeName, countLabel,
  hookSections, mcpServerSummary, namedList,
} from "../project-inventory.mjs";

const HOOK_EVENTS = new Set([
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification",
  "UserPromptSubmit", "Stop", "SubagentStart", "SubagentStop", "PreCompact", "SessionStart", "SessionEnd",
]);
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"]);
const MCP_TRANSPORTS = new Set(["stdio", "http", "sse", "ws"]);
// Top-level settings named by label only. Anything else counts as "other settings".
const SETTING_LABELS = {
  model: "Model",
  outputStyle: "Output style",
  statusLine: "Status line",
  apiKeyHelper: "API key helper",
  enabledPlugins: "Plugins",
  extraKnownMarketplaces: "Plugin marketplaces",
  includeCoAuthoredBy: "Commit attribution",
  cleanupPeriodDays: "Transcript retention",
  forceLoginMethod: "Login method",
  disableAllHooks: "Hooks disabled",
  spinnerTipsEnabled: "Spinner tips",
  alwaysThinkingEnabled: "Extended thinking",
};
const HANDLED_SETTINGS = new Set([
  "permissions", "hooks", "env", "sandbox", "enableAllProjectMcpServers", "enabledMcpjsonServers",
  "disabledMcpjsonServers", "$schema", ...Object.keys(SETTING_LABELS),
]);

const LINKED_FOLDERS = {
  ".claude/skills": { area: "skills", label: "Skills folder" },
  ".claude/rules": { area: "instructions", label: "Rules folder" },
  ".claude/agents": { area: "config", label: "Custom agents folder" },
  ".claude/commands": { area: "config", label: "Commands folder" },
  ".claude": { area: "config", label: "Claude Code folder" },
};

export function classifyClaudeProjectPath(relPath, { symlink = false } = {}) {
  const folder = matchLinkedFolder(relPath, LINKED_FOLDERS, { symlink });
  if (folder) return folder;
  const skill = matchSkillPath(relPath, ".claude", { symlink });
  if (skill) {
    return { area: "skills", kind: "skill", label: "Skill", loading: LOADING.onDemand, format: "text", name: skill.name };
  }
  const parts = segmentsOf(relPath);
  const base = parts.at(-1);
  if (base === "CLAUDE.md" || base === "CLAUDE.local.md") {
    const atRoot = isRootLevel(relPath) || (parts.length === 2 && parts[0] === ".claude" && base === "CLAUDE.md");
    if (parts.includes(".claude") && !atRoot) return null;
    return {
      area: "instructions",
      kind: base === "CLAUDE.md" ? "claude-md" : "claude-local-md",
      label: base === "CLAUDE.md" ? "Project instructions" : "Local instructions",
      loading: atRoot ? LOADING.rootLevel : LOADING.conditional,
      format: "text",
    };
  }
  if (base === "AGENTS.md") {
    if (parts.some((part) => part === ".claude" || part === ".codex" || part === ".agents")) return null;
    return {
      area: "instructions",
      kind: "agents-md",
      label: "AGENTS.md instructions",
      loading: LOADING.conditional,
      format: "text",
      note: "Claude Code reads AGENTS.md by default only where no CLAUDE.md or CLAUDE.local.md is in the working directory or above it; its Project instructions setting can change that.",
    };
  }
  if (parts[0] !== ".claude" && !(parts.length === 1 && base === ".mcp.json")) return null;
  if (parts.length === 1 && base === ".mcp.json") {
    return { area: "config", kind: "mcp", label: "MCP servers", loading: LOADING.rootLevel, format: "json" };
  }
  if (parts.length === 2 && (base === "settings.json" || base === "settings.local.json")) {
    return {
      area: "config",
      kind: base === "settings.json" ? "settings" : "settings-local",
      label: base === "settings.json" ? "Project settings" : "Local project settings",
      loading: LOADING.rootLevel,
      format: "json",
    };
  }
  if (parts.length >= 3 && base.endsWith(".md")) {
    if (parts[1] === "rules") {
      return { area: "instructions", kind: "rule", label: "Rule", loading: LOADING.rootLevel, format: "text" };
    }
    if (parts[1] === "agents") {
      return { area: "config", kind: "agent", label: "Custom agent", loading: LOADING.onDemand, format: "text" };
    }
    if (parts[1] === "commands") {
      return { area: "config", kind: "command", label: "Command", loading: LOADING.onDemand, format: "text" };
    }
  }
  return null;
}

export function describeClaudeProjectFile(entry, text) {
  if (entry.kind === "settings" || entry.kind === "settings-local") return describeSettings(text);
  if (entry.kind === "mcp") return describeMcpJson(text);
  const { name, description, meta } = describeMarkdown(text, { fallbackName: entry.name ?? null });
  // A rule with `paths:` loads only for matching files.
  if (entry.kind === "rule") return { name, description, loading: meta.paths ? LOADING.conditional : LOADING.rootLevel };
  return { name, description };
}

function describeSettings(text) {
  const parsed = parseJsonObject(text);
  if (!parsed.ok) return { diagnostic: parsed.diagnostic };
  const settings = parsed.value;
  const sections = [];
  const permissions = settings.permissions;
  if (permissions && typeof permissions === "object" && !Array.isArray(permissions)) {
    const counts = ["allow", "ask", "deny"]
      .filter((bucket) => Array.isArray(permissions[bucket]) && permissions[bucket].length > 0)
      .map((bucket) => `${permissions[bucket].length} ${bucket}`);
    sections.push(`Permissions: ${counts.length ? `${counts.join(", ")} rules` : "declared"}`);
    if (PERMISSION_MODES.has(permissions.defaultMode)) sections.push(`Default permission mode: ${permissions.defaultMode}`);
    if (Array.isArray(permissions.additionalDirectories) && permissions.additionalDirectories.length) {
      sections.push(`Additional directories: ${permissions.additionalDirectories.length}`);
    }
  }
  sections.push(...hookSections(settings.hooks, HOOK_EVENTS));
  if (settings.env && typeof settings.env === "object") {
    sections.push(`Environment variables: ${Object.keys(settings.env).length}`);
  }
  if (settings.sandbox && typeof settings.sandbox === "object") sections.push("Sandbox settings");
  if (settings.enableAllProjectMcpServers === true) sections.push("Approves every project MCP server");
  for (const [key, label] of [["enabledMcpjsonServers", "Approved MCP servers"], ["disabledMcpjsonServers", "Rejected MCP servers"]]) {
    if (Array.isArray(settings[key]) && settings[key].length) sections.push(namedList(label, settings[key]));
  }
  const labeled = Object.keys(settings).filter((key) => SETTING_LABELS[key]).map((key) => SETTING_LABELS[key]);
  if (labeled.length) sections.push(`Also declares: ${labeled.join(", ")}`);
  const other = Object.keys(settings).filter((key) => !HANDLED_SETTINGS.has(key)).length;
  if (other) sections.push(countLabel(other, "other setting"));
  return { sections };
}

function describeMcpJson(text) {
  const parsed = parseJsonObject(text);
  if (!parsed.ok) return { diagnostic: parsed.diagnostic };
  const servers = parsed.value.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { sections: ["No MCP servers declared"] };
  const names = Object.entries(servers).map(([name, server]) => {
    const safe = safeName(name);
    if (!safe) return null;
    const transport = MCP_TRANSPORTS.has(server?.type) ? server.type : server?.command ? "stdio" : server?.url ? "remote" : null;
    return transport ? `${safe} (${transport})` : safe;
  });
  return { sections: [mcpServerSummary(names)] };
}

export const claudeProjectInventory = Object.freeze({
  classify: classifyClaudeProjectPath,
  describe: describeClaudeProjectFile,
});
