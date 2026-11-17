// Codex's native project files, as the optional `projectInventory` adapter group describes them.
// Patterns follow the Codex AGENTS.md, configuration, skills, hooks, and subagent docs: AGENTS.md and
// AGENTS.override.md (root and nested), .agents/skills/<name>/SKILL.md (root and nested),
// .codex/config.toml, .codex/hooks.json, and .codex/agents/*.toml.
//
// .codex/skills/<name>/SKILL.md is an older location that RoboRepo itself links skills into. The
// docs no longer list it, but codex-cli 0.166.0 still reads it, so it loads on demand like
// .agents/skills.

import {
  LOADING, segmentsOf, isRootLevel, matchSkillPath, matchLinkedFolder, describeMarkdown, parseJsonObject, scanTomlStructure,
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

const LINKED_FOLDERS = {
  ".agents/skills": { area: "skills", label: "Skills folder" },
  ".codex/skills": { area: "skills", label: "Skills folder (legacy location)", legacy: true },
  ".codex/agents": { area: "config", label: "Custom agents folder", fileExtension: ".toml" },
  ".agents": { area: "skills", label: "Agents folder" },
  ".codex": { area: "config", label: "Codex folder" },
};

export function classifyCodexProjectPath(relPath, { symlink = false } = {}) {
  const folder = matchLinkedFolder(relPath, LINKED_FOLDERS, { symlink });
  if (folder) return folder;
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
      loading: LOADING.onDemand,
      format: "text",
      name: legacy.name,
      legacy: true,
      note: "An older skill location that Codex still reads; new skills belong in .agents/skills.",
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
    const { diagnostic, rootKeys, strings } = scanTomlStructure(text, { rootStrings: ["name"] });
    const name = strings.name;
    const keys = rootKeys.map((key) => key.join("."));
    const sections = ["description", "model", "developer_instructions", "sandbox_mode"]
      .filter((key) => keys.includes(key))
      .map((key) => `Declares ${key.replace(/_/g, " ")}`);
    return { name: safeName(name) || null, sections, ...(diagnostic ? { diagnostic } : {}) };
  }
  return describeMarkdown(text, { fallbackName: entry.name ?? null });
}

function describeConfigToml(text) {
  const { rootKeys, tables, keys, diagnostic } = scanTomlStructure(text);
  // Every declared path, whether spelled as a [table], a dotted key, or an inline table.
  const paths = [...tables, ...keys];
  const namesUnder = (section) => unique(paths.filter((entry) => entry[0] === section && entry.length >= 2).map((entry) => entry[1]));
  const sections = [];
  const rootLabels = rootKeys
    .filter((key) => key.length === 1 && ROOT_KEY_LABELS[key[0]])
    .map((key) => ROOT_KEY_LABELS[key[0]]);
  if (rootLabels.length) sections.push(`Declares: ${[...new Set(rootLabels)].join(", ")}`);

  const mcpNames = namesUnder("mcp_servers");
  if (mcpNames.length) sections.push(mcpServerSummary(mcpNames.map(safeName)));

  if (paths.some((entry) => entry[0] === "hooks")) {
    sections.push(...hookSections(Object.fromEntries(namesUnder("hooks").map((event) => [event, true])), HOOK_EVENTS));
  }
  const profiles = namesUnder("profiles");
  if (profiles.length) sections.push(`Profiles: ${profiles.map((name) => safeName(name) ?? "(unnamed)").join(", ")}`);

  // From every declared path, so `[features]`, `features.x = 1`, and `features = { x = 1 }` agree.
  const labeled = unique(paths.map((entry) => TABLE_LABELS[entry[0]]).filter(Boolean));
  if (labeled.length) sections.push(`Also declares: ${labeled.join(", ")}`);
  return { sections, ...(diagnostic ? { diagnostic } : {}) };
}

function unique(values) {
  return [...new Set(values)];
}

// What a session started at the repo root reads before its first message: the root AGENTS.md (or
// the AGENTS.override.md that takes its place) in full, and each root skill's name and description.
// Codex reads root skills from .agents/skills and from the older .codex/skills (confirmed with
// codex-cli 0.166.0). A .codex/skills skill whose name is also in .agents/skills is left out, so a
// skill linked into both folders is not doubled; how Codex itself handles that duplicate is not
// verified.
export function codexStartupEntries(entries) {
  const instructions = entries.filter((entry) => entry.area === "instructions" && entry.loading === LOADING.rootLevel);
  const override = instructions.find((entry) => entry.kind === "agents-override-md");
  const rootSkills = (root) => entries.filter((entry) => entry.kind === "skill" && entry.path.startsWith(root));
  const current = rootSkills(".agents/skills/");
  const currentNames = new Set(current.map((entry) => entry.name));
  const older = rootSkills(".codex/skills/").filter((entry) => !currentNames.has(entry.name));
  return [
    ...(override ? [override] : instructions).map((entry) => ({ entry, basis: "instructions" })),
    ...[...current, ...older].map((entry) => ({ entry, basis: "skill-discovery" })),
  ];
}

export const codexProjectInventory = Object.freeze({
  classify: classifyCodexProjectPath,
  describe: describeCodexProjectFile,
  startupEntries: codexStartupEntries,
});
