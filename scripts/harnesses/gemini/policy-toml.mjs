// Pure Gemini CLI Policy Engine TOML render, mirroring permissions-render.mjs's
// claudePermissions/renderCodexConfig for the third provider. No file I/O, no path resolution —
// the provider adapter (scripts/harnesses/gemini/index.mjs) supplies the target directory/paths.
//
// Gemini's Policy Engine (~/.gemini/policies/*.toml, User tier) is the only one of the three
// providers with a real native 3-state decision (allow/deny/ask_user) at the config layer — no
// approximation or session-wide fallback needed, unlike Codex's binary prefix_rule + approval_policy
// fallback. Each manifest behavior/command resolves to exactly one [[rule]].
//
// Tool-name mapping lives in the PROVIDER manifest's extensions.app.toolNameMap
// (globals/harnesses/gemini/provider.json) rather than hardcoded here — it's data (a
// string-to-string translation table), not logic. Distinct from the BEHAVIOR manifest
// (manifests/inventory/agent-permissions.json) every render function below also takes: the
// provider manifest describes Gemini itself, the behavior manifest describes what to render.
// Verified against the installed @google/gemini-cli@0.53.1 bundle's own tool-name constants
// (chunk-2NH5AG3B.js: WRITE_FILE_TOOL_NAME="write_file", EDIT_TOOL_NAME="replace",
// READ_FILE_TOOL_NAME="read_file"), not guessed from docs — this is the complete, exhaustive set
// of write/read tool names Gemini ships, sourced from the binary itself.
function geminiToolNames(providerManifest, claudeToolNames) {
  const map = providerManifest.extensions?.app?.toolNameMap ?? {};
  return claudeToolNames.map((name) => map[name]).filter(Boolean);
}

function quoteToml(value) {
  return JSON.stringify(String(value));
}

function tomlToolNameField(names) {
  if (names.length === 1) return quoteToml(names[0]);
  return `[${names.map(quoteToml).join(", ")}]`;
}

// User tier priority: 0-999 range per rule, tier base (4) applied by the engine itself at load
// time (final_priority = 4 + priority/1000) — the TOML file only ever writes the 0-999 value.
const RULE_PRIORITY = 500;

// Manifest buckets are "allow"/"deny"/"ask" (shared vocabulary with Claude/Codex); the Policy
// Engine's own decision enum is "allow"/"deny"/"ask_user" (bundle/docs/reference/policy-engine.md).
function toGeminiDecision(bucket) {
  return bucket === "ask" ? "ask_user" : bucket;
}

function renderToolRule(names, bucket) {
  return [
    "[[rule]]",
    `toolName = ${tomlToolNameField(names)}`,
    `decision = ${quoteToml(toGeminiDecision(bucket))}`,
    `priority = ${RULE_PRIORITY}`,
  ].join("\n");
}

function renderShellCommandRule(pattern, bucket) {
  const commandPrefix = pattern.map(String).join(" ");
  return [
    "[[rule]]",
    `toolName = ${quoteToml("run_shell_command")}`,
    `commandPrefix = ${quoteToml(commandPrefix)}`,
    `decision = ${quoteToml(toGeminiDecision(bucket))}`,
    `priority = ${RULE_PRIORITY}`,
  ].join("\n");
}

// Flat model shared with Claude/Codex: behaviorManifest.behaviors resolves via overrides, then each
// behavior/arbitrary command maps to one rule. "network" kind (go-online) is Codex-only — Gemini
// has no sandbox network gate, same reason Claude's claudePermissions skips it. providerManifest is
// only consulted for the tools-kind tool-name mapping (see geminiToolNames above).
export function renderGeminiPolicyRules(providerManifest, behaviorManifest, overrides = {}) {
  const behaviors = (behaviorManifest.behaviors ?? []).map((b) => ({
    ...b,
    bucket: overrides.behaviors?.[b.id] ?? b.bucket,
  }));

  const commandsByKey = new Map();
  for (const tokens of behaviorManifest.commands?.allow ?? []) {
    commandsByKey.set(tokens.map(String).join(" "), { tokens, bucket: "allow" });
  }
  for (const [key, entry] of Object.entries(overrides.commands ?? {})) {
    commandsByKey.set(key, { tokens: entry.tokens, bucket: entry.bucket });
  }

  const rules = [];

  for (const b of behaviors) {
    if (b.kind === "network") continue;
    // "tools-gate" is the on/off master for a tool set whose WHERE is expressed by a companion
    // "tools-scoped" behavior. Gemini's Policy Engine matches on tool name only — it has no path
    // predicate — so the scoped rules cannot be represented here. Rendering the gate as a plain
    // whole-tool rule is the correct degradation: Gemini keeps the allow/ask/deny decision and
    // simply applies it everywhere, rather than losing the gate entirely.
    if (b.kind === "tools" || b.kind === "tools-gate") {
      const names = geminiToolNames(providerManifest, b.tools ?? []);
      if (names.length > 0) rules.push(renderToolRule(names, b.bucket));
      continue;
    }
    // Skipped deliberately: a path-scoped allow rendered as an unscoped allow would be strictly
    // MORE permissive than the manifest says. The governing gate above already carries the
    // decision, so dropping these loses no restriction.
    if (b.kind === "tools-scoped") continue;
    // Skipped deliberately: "repo-scope" states a boundary that is the repository the session is
    // working in, which no static rule can express — Claude enforces it with a PreToolUse hook,
    // Codex with a permission profile. Gemini's Policy Engine has neither a path predicate nor a hook
    // surface to decide it at tool-call time, so there is nothing to render. Rendering the
    // governing tools-gate everywhere (above) remains the correct degradation, and Gemini is
    // deprecated here, so no parity work is planned.
    if (b.kind === "repo-scope") continue;
    if (b.kind !== "commands") continue;
    for (const pattern of b.commands ?? []) rules.push(renderShellCommandRule(pattern, b.bucket));
  }

  for (const [, c] of commandsByKey) {
    rules.push(renderShellCommandRule(c.tokens, c.bucket));
  }

  for (const [server, tools] of Object.entries(behaviorManifest.mcp ?? {})) {
    if (tools.length === 0) continue;
    rules.push(renderToolRule(tools.map((tool) => `mcp_${server}_${tool}`), "allow"));
  }

  return `${rules.join("\n\n")}\n`;
}

// Gemini's policy directory loads every *.toml file it contains and combines their rules — no
// single generated-block-inside-existing-file merge like Claude/Codex's rootConfig. roborepo owns
// one whole file (generated-permissions.toml) inside that directory; anything else present is a
// user's own untouched rule file, never read or merged.
export const GENERATED_POLICY_FILENAME = "generated-permissions.toml";

export function renderGeminiPolicyFile(providerManifest, behaviorManifest, overrides = {}) {
  const header = "# Generated by roborepo. Source: manifests/inventory/agent-permissions.json\n";
  return `${header}\n${renderGeminiPolicyRules(providerManifest, behaviorManifest, overrides)}`;
}
