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

// Names a repo chose (MCP servers, agents) are shown only when they look like identifiers, which
// keeps URLs, commands, and spaced text out of the browser. It is not a secret detector: a
// token-shaped string used as a name still matches and is shown as written.
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

// A symlinked native folder (`folders` maps its trailing path, like ".claude/skills", to a record)
// is listed as a reference, so files behind it show as unread rather than as an empty scan. A record
// with `fileExtension` also covers any symlink deeper inside that folder whose name lacks the
// extension: a linked subfolder of rules, say, rather than a linked rule file.
export function matchLinkedFolder(relPath, folders, { symlink = false } = {}) {
  if (!symlink) return null;
  const parts = segmentsOf(relPath);
  const containsAt = (tail, at) => tail.every((part, index) => parts[at + index] === part);
  for (const [suffix, record] of Object.entries(folders)) {
    const tail = suffix.split("/");
    const exact = parts.length >= tail.length && containsAt(tail, parts.length - tail.length);
    const inside = record.fileExtension && !parts.at(-1).endsWith(record.fileExtension)
      && parts.slice(0, -tail.length).some((_, at) => containsAt(tail, at));
    if (exact || inside) {
      const { fileExtension, ...shown } = record;
      return {
        ...shown,
        kind: "linked-folder",
        loading: LOADING.unknown,
        format: "text",
        note: "A symbolic link to a folder; the files behind it are not read.",
      };
    }
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

// TOML structure without values, line by line: table headers, root key names, and `keys` — every
// declared key as a full path (table prefix + dotted key; bare, "basic", and 'literal' segments),
// plus the top-level names of a one-line inline table (`mcp_servers = { docs = {...} }` gives
// ["mcp_servers", "docs"]). A header or key line that does not parse is reported, not guessed at.
// Lines inside a value that spans lines (a """ or ''' string, or an array or inline table left
// open) are never read as keys or headers. Values are not returned, except a one-line string for a
// root key the caller names in `rootStrings` (a Codex agent's `name`).
export function scanTomlStructure(text, { rootStrings = [] } = {}) {
  const rootKeys = [];
  const tables = [];
  const keys = [];
  const strings = {};
  let current = null;
  let diagnostic = null;
  let openValue = null;
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const report = (index) => { diagnostic ??= `Could not parse TOML on line ${index + 1}.`; };
  lines.forEach((raw, index) => {
    if (openValue) {
      openValue = continueValue(openValue, raw);
      return;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("[")) {
      const array = line.startsWith("[[");
      const key = readTomlKey(line.slice(array ? 2 : 1));
      const close = key && new RegExp(`^\\s*\\]${array ? "\\]" : ""}\\s*(?:#.*)?$`).test(key.rest);
      if (!close) return report(index);
      current = key.parts;
      tables.push(current);
      return;
    }
    const key = readTomlKey(line);
    const assignment = key && /^\s*=\s*(.*)$/.exec(key.rest);
    if (!assignment) {
      report(index);
      // An unparseable key may still open a multi-line value; its lines stay unread. After a key
      // that parsed, the delimiter is searched past it, so an `=` inside a quoted key is not it.
      const remainder = key ? key.rest : line;
      const equals = remainder.indexOf("=");
      if (equals !== -1) openValue = continueValue({ depth: 0, quote: null }, remainder.slice(equals + 1));
      return;
    }
    const value = assignment[1];
    const keyPath = [...(current || []), ...key.parts];
    if (!current) {
      rootKeys.push(key.parts);
      if (key.parts.length === 1 && rootStrings.includes(key.parts[0])) {
        const string = /^(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)')\s*(?:#.*)?$/.exec(value);
        if (string) strings[key.parts[0]] = string[1] ?? string[2];
      }
    }
    keys.push(keyPath);
    for (const name of inlineTableKeys(value)) keys.push([...keyPath, name]);
    openValue = continueValue({ depth: 0, quote: null }, value);
  });
  // A value still open at the end means everything after it went unread.
  if (openValue) diagnostic ??= "Could not parse TOML: a value is never closed.";
  return { rootKeys, tables, keys, strings, diagnostic };
}

// A dotted TOML key at the start of `source`: { parts, rest } or null. Segments are bare
// (A-Za-z0-9_-), "basic" (with escapes), or 'literal', separated by dots with optional spaces.
function readTomlKey(source) {
  const parts = [];
  let i = 0;
  const skipSpace = () => { while (source[i] === " " || source[i] === "\t") i += 1; };
  for (;;) {
    skipSpace();
    const char = source[i];
    if (char === "\"") {
      let j = i + 1;
      let value = "";
      while (j < source.length && source[j] !== "\"") {
        if (source[j] === "\\") { value += source[j + 1] ?? ""; j += 2; } else { value += source[j]; j += 1; }
      }
      if (j >= source.length) return null;
      parts.push(value);
      i = j + 1;
    } else if (char === "'") {
      const end = source.indexOf("'", i + 1);
      if (end === -1) return null;
      parts.push(source.slice(i + 1, end));
      i = end + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(source.slice(i));
      if (!bare) return null;
      parts.push(bare[0]);
      i += bare[0].length;
    }
    skipSpace();
    if (source[i] !== ".") return { parts, rest: source.slice(i) };
    i += 1;
  }
}

// Scans one line of a value and returns what is still open after it ({ depth, quote }), or null when
// the value is complete. `quote` is a multi-line string delimiter; `depth` counts open [ and {.
function continueValue(state, line) {
  let { depth, quote } = state;
  for (let i = 0; i < line.length; i += 1) {
    if (quote) {
      if (line.startsWith(quote, i)) {
        i += quote.length - 1;
        quote = null;
      } else if (line[i] === "\\" && quote === "\"\"\"") {
        i += 1;
      }
      continue;
    }
    const char = line[i];
    if (char === "#") break;
    if (line.startsWith("\"\"\"", i) || line.startsWith("'''", i)) {
      quote = line.slice(i, i + 3);
      i += 2;
      continue;
    }
    if (char === "\"" || char === "'") {
      let end = i + 1;
      while (end < line.length && line[end] !== char) end += char === "\"" && line[end] === "\\" ? 2 : 1;
      i = end;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
  }
  return quote || depth > 0 ? { depth, quote } : null;
}

// Top-level key names of a one-line inline table value, skipping nested tables, arrays, and strings.
function inlineTableKeys(value) {
  if (!value.startsWith("{")) return [];
  const names = [];
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    // A """ or ''' string is one value: its `}`, `,`, and quotes are text, never structure.
    if (value.startsWith("\"\"\"", i) || value.startsWith("'''", i)) {
      const delimiter = value.slice(i, i + 3);
      let end = i + 3;
      while (end < value.length && !value.startsWith(delimiter, end)) end += delimiter === "\"\"\"" && value[end] === "\\" ? 2 : 1;
      if (end >= value.length) break;
      // Up to two quotes right before the closing delimiter belong to the string (`"""a"""""`).
      for (let extra = 0; extra < 2 && value[end + 3] === delimiter[0]; extra += 1) end += 1;
      expectKey = false;
      i = end + 2;
      continue;
    }
    if (char === "\"" || char === "'") {
      // Basic strings honor backslash escapes; literal strings have none.
      let end = i + 1;
      while (end < value.length && value[end] !== char) end += char === "\"" && value[end] === "\\" ? 2 : 1;
      if (end >= value.length) break;
      if (depth === 1 && expectKey && /^\s*=/.test(value.slice(end + 1))) names.push(value.slice(i + 1, end));
      expectKey = false;
      i = end;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      continue;
    }
    if (depth === 1 && char === ",") {
      expectKey = true;
      continue;
    }
    if (depth === 1 && expectKey && /[A-Za-z0-9_-]/.test(char)) {
      const bare = /^[A-Za-z0-9_-]+/.exec(value.slice(i))[0];
      if (/^\s*[=.]/.test(value.slice(i + bare.length))) names.push(bare);
      expectKey = false;
      i += bare.length - 1;
    }
  }
  return names;
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
