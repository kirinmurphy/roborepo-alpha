// Shared vocabulary for the optional `projectInventory` adapter group: how a provider names the
// native agent files it recognizes inside a repo checkout. Providers only classify relative paths and
// describe text the caller already read; they never touch the filesystem. The caller
// (scripts/cli/repository-agent-config.mjs) owns checkout selection, the bounded walk, confinement,
// Git classification, and token estimates.
//
// classify(relPath, { symlink }) -> null | {
//   area: "instructions" | "skills" | "config",
//   kind: short machine label (e.g. "claude-md", "skill", "settings"),
//   label: human label for the kind,
//   loading: one of LOADING,
//   format: "text" | "json" | "toml" — text bodies are previewable as text, the others are summarized,
//   name?, override?, legacy?, note?
// }
// describe(entry, text) -> { name?, description?, loading?, sections?: string[], diagnostic? }
//   `sections` are allowlisted labels only. Raw values (commands, URLs, env, headers, credentials)
//   never leave describe.

export const LOADING = Object.freeze({
  rootLevel: "root-level",
  conditional: "potentially-conditional",
  onDemand: "on-demand",
  unknown: "unknown",
});

export const INVENTORY_AREAS = Object.freeze(["instructions", "skills", "config"]);

// Names a repo chose (MCP servers, agents) are shown only when they look like identifiers, so a
// value pasted into a key position cannot reach the browser.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function safeName(value) {
  return typeof value === "string" && SAFE_NAME.test(value) ? value : null;
}

// Splits a relative POSIX path into its segments. Inputs are produced by the caller's walk, which
// always uses "/" separators.
export function segmentsOf(relPath) {
  return String(relPath).split("/").filter(Boolean);
}

export function isRootLevel(relPath) {
  return segmentsOf(relPath).length === 1;
}

// The `<prefix>/<base>/skills/<name>/SKILL.md` shape (or the `<name>` directory itself when it is a
// symlink), with `base` like ".claude" or ".agents". Returns { name, nested } or null.
// A symlink may be either the skill folder or its SKILL.md file.
export function matchSkillPath(relPath, base, { symlink = false } = {}) {
  const parts = segmentsOf(relPath);
  const shapes = symlink && parts.at(-1) !== "SKILL.md" ? [3] : [4];
  for (const tail of shapes) {
    if (parts.length < tail) continue;
    const at = parts.length - tail;
    if (parts[at] !== base || parts[at + 1] !== "skills") continue;
    if (tail === 4 && parts[at + 3] !== "SKILL.md") continue;
    return { name: parts[at + 2], nested: at > 0 };
  }
  return null;
}

// YAML-ish frontmatter as skills and rules use it: `key: value` pairs and `>`/`|` blocks. Returns {}
// when there is none. Values stay strings; nothing is evaluated.
export function parseMarkdownFrontmatter(content) {
  const normalized = String(content ?? "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return {};
  const meta = {};
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const keyValue = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(lines[i]);
    if (!keyValue) continue;
    const [, key, rawValue = ""] = keyValue;
    if (rawValue === ">" || rawValue === "|") {
      const block = [];
      while (i + 1 < lines.length && /^(?:\s{2,}|\t)/.test(lines[i + 1])) {
        i += 1;
        block.push(lines[i].replace(/^(?:\s{2}|\t)/, ""));
      }
      meta[key] = block.join(rawValue === ">" ? " " : "\n").trim();
      continue;
    }
    if (rawValue === "" && i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
      const items = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        i += 1;
        items.push(lines[i].replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, "").trim());
      }
      meta[key] = items;
      continue;
    }
    meta[key] = rawValue.replace(/^["']|["']$/g, "").trim();
  }
  return meta;
}

// Display metadata for a Markdown body with frontmatter: a name and a one-line description, capped
// so a long description stays a summary.
export function describeMarkdown(text, { fallbackName = null } = {}) {
  const meta = parseMarkdownFrontmatter(text);
  const name = typeof meta.name === "string" && meta.name ? meta.name.slice(0, 120) : fallbackName;
  const description = typeof meta.description === "string" && meta.description
    ? meta.description.replace(/\s+/g, " ").slice(0, 400)
    : null;
  return { name, description, meta };
}

export function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, value: parsed };
    return { ok: false, diagnostic: "Expected a JSON object." };
  } catch {
    // The engine's message quotes the source around the error, which can be a secret value.
    return { ok: false, diagnostic: "Could not parse JSON." };
  }
}

// TOML structure without values: root key names and table headers, line by line. Enough to say
// which sections a file declares; a header with unbalanced brackets is reported, not guessed at.
export function scanTomlStructure(text) {
  const rootKeys = [];
  const tables = [];
  let inTable = false;
  let diagnostic = null;
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("[")) {
      const header = /^\[\[?\s*([^\[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (!header) {
        diagnostic ??= `Could not parse TOML table header on line ${index + 1}.`;
        return;
      }
      tables.push(splitTomlKey(header[1]));
      inTable = true;
      return;
    }
    const key = /^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+)\s*=/.exec(line);
    if (key && !inTable) rootKeys.push(splitTomlKey(key[1]));
  });
  return { rootKeys, tables, diagnostic };
}

function splitTomlKey(source) {
  const parts = [];
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\s*(?:\.|$)/gy;
  let match;
  while ((match = pattern.exec(source)) && match[0] !== "") parts.push(match[1] ?? match[2]);
  return parts;
}

export function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// Hook event names from an allowlist, with the rest counted. Handlers and commands are never read.
export function hookSections(hooks, knownEvents) {
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const events = Object.keys(hooks);
  const known = events.filter((event) => knownEvents.has(event));
  const unknown = events.length - known.length;
  const parts = [...known];
  if (unknown) parts.push(countLabel(unknown, "other event"));
  return [`Hooks: ${parts.length ? parts.join(", ") : "none"}`];
}

export function mcpServerSummary(names) {
  const shown = names.filter(Boolean);
  const hidden = names.length - shown.length;
  const parts = [...shown];
  if (hidden) parts.push(countLabel(hidden, "unnamed server"));
  return `MCP servers: ${parts.length ? parts.join(", ") : "none"}`;
}

export function namedList(label, values) {
  const shown = values.map(safeName).filter(Boolean);
  const hidden = values.length - shown.length;
  return `${label}: ${[...shown, ...(hidden ? [countLabel(hidden, "other")] : [])].join(", ")}`;
}
