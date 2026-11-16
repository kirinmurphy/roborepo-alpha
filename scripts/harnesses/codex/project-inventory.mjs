// Codex's native project files, as the optional `projectInventory` adapter group describes them.
// Patterns follow the Codex AGENTS.md, configuration, skills, hooks, and subagent docs: AGENTS.md and
// AGENTS.override.md (root and nested), .agents/skills/<name>/SKILL.md (root and nested),
// .codex/config.toml, .codex/hooks.json, and .codex/agents/*.toml.
//
// .codex/skills/<name>/SKILL.md is a location RoboRepo itself links skills into. Whether the
// installed Codex reads it is not verified here, so its loading is reported as unknown.

import {
  LOADING, segmentsOf, isRootLevel, matchSkillPath, describeMarkdown, parseJsonObject, scanTomlStructure,
  safeName, hookSections, mcpServerSummary,
} from "../project-inventory.mjs";

const HOOK_EVENTS = new Set([
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop",
]);
const ROOT_KEY_LABELS = {
  model: "Model",
  model_provider: "Model provider",
  model_reasoning_effort: "Reasoning effort",
  approval_policy: "Approval policy",
  sandbox_mode: "Sandbox mode",
  profile: "Default profile",
  project_doc_max_bytes: "Instruction size limit",
  project_doc_fallback_filenames: "Instruction fallback filenames",
};
const TABLE_LABELS = {
  sandbox_workspace_write: "Sandbox workspace settings",
  shell_environment_policy: "Shell environment policy",
  features: "Feature flags",
  tools: "Tool settings",
  tui: "Terminal UI settings",
  permissions: "Permissions",
  history: "History settings",
};

export function classifyCodexProjectPath(relPath, { symlink = false } = {}) {
  const skill = matchSkillPath(relPath, ".agents", { symlink });
  if (skill) {
    return { area: "skills", kind: "skill", label: "Skill", loading: LOADING.onDemand, format: "text", name: skill.name };
  }
  const legacy = matchSkillPath(relPath, ".codex", { symlink });
  if (legacy) {
    return {
      area: "skills",
      kind: "skill",
      label: "Skill (legacy location)",
      loading: LOADING.unknown,
      format: "text",
      name: legacy.name,
      legacy: true,
      note: "RoboRepo recognizes .codex/skills; whether this Codex version reads it is not verified.",
    };
  }
  const parts = segmentsOf(relPath);
  const base = parts.at(-1);
  if (base === "AGENTS.md" || base === "AGENTS.override.md") {
    if (parts.includes(".codex") || parts.includes(".agents")) return null;
    const override = base === "AGENTS.override.md";
    return {
      area: "instructions",
      kind: override ? "agents-override-md" : "agents-md",
      label: override ? "Instruction override" : "Project instructions",
      loading: isRootLevel(relPath) ? LOADING.rootLevel : LOADING.conditional,
      format: "text",
      ...(override ? { override: true, note: "Takes the place of AGENTS.md in the same folder when both exist." } : {}),
    };
  }
  if (parts[0] !== ".codex") return null;
  if (parts.length === 2 && base === "config.toml") {
    return { area: "config", kind: "config", label: "Project config", loading: LOADING.rootLevel, format: "toml" };
  }
  if (parts.length === 2 && base === "hooks.json") {
    return { area: "config", kind: "hooks", label: "Hooks", loading: LOADING.rootLevel, format: "json" };
  }
  if (parts.length === 3 && parts[1] === "agents" && base.endsWith(".toml")) {
    return { area: "config", kind: "agent", label: "Custom agent", loading: LOADING.onDemand, format: "toml" };
  }
  return null;
}

export function describeCodexProjectFile(entry, text) {
  if (entry.kind === "config") return describeConfigToml(text);
  if (entry.kind === "hooks") {
    const parsed = parseJsonObject(text);
    if (!parsed.ok) return { diagnostic: parsed.diagnostic };
    return { sections: hookSections(parsed.value.hooks, HOOK_EVENTS) };
  }
  if (entry.kind === "agent") {
    const { diagnostic, rootKeys } = scanTomlStructure(text);
    const name = /^\s*name\s*=\s*"([^"\n]*)"/m.exec(String(text ?? ""))?.[1];
    const keys = rootKeys.map((key) => key.join("."));
    const sections = ["description", "model", "developer_instructions", "sandbox_mode"]
      .filter((key) => keys.includes(key))
      .map((key) => `Declares ${key.replace(/_/g, " ")}`);
    return { name: safeName(name) || null, sections, ...(diagnostic ? { diagnostic } : {}) };
  }
  return describeMarkdown(text, { fallbackName: entry.name ?? null });
}

function describeConfigToml(text) {
  const { rootKeys, tables, diagnostic } = scanTomlStructure(text);
  const sections = [];
  const rootLabels = rootKeys
    .filter((key) => key.length === 1 && ROOT_KEY_LABELS[key[0]])
    .map((key) => ROOT_KEY_LABELS[key[0]]);
  if (rootLabels.length) sections.push(`Declares: ${[...new Set(rootLabels)].join(", ")}`);

  const mcpNames = unique(tables.filter((table) => table[0] === "mcp_servers" && table.length >= 2).map((table) => table[1]));
  if (mcpNames.length) sections.push(mcpServerSummary(mcpNames.map(safeName)));

  const hookEvents = new Set(tables.filter((table) => table[0] === "hooks" && table.length >= 2).map((table) => table[1]));
  if (tables.some((table) => table[0] === "hooks")) {
    sections.push(...hookSections(Object.fromEntries([...hookEvents].map((event) => [event, true])), HOOK_EVENTS));
  }
  const profiles = unique(tables.filter((table) => table[0] === "profiles" && table.length >= 2).map((table) => table[1]));
  if (profiles.length) sections.push(`Profiles: ${profiles.map((name) => safeName(name) ?? "(unnamed)").join(", ")}`);

  const labeled = unique(tables.map((table) => TABLE_LABELS[table[0]]).filter(Boolean));
  if (labeled.length) sections.push(`Also declares: ${labeled.join(", ")}`);
  return { sections, ...(diagnostic ? { diagnostic } : {}) };
}

function unique(values) {
  return [...new Set(values)];
}

export const codexProjectInventory = Object.freeze({
  classify: classifyCodexProjectPath,
  describe: describeCodexProjectFile,
});
