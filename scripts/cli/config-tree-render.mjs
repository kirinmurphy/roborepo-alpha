// Readable view of a parsed JSON or TOML config file for the portal's config popup: a nested list
// of every key with only safe values shown. Live harness configs hold secrets next to ordinary
// settings (env values, MCP headers and launch commands, hook shell commands, API key helpers), so
// the popup shows names everywhere and values only where they cannot carry a credential. Hidden
// values never reach the HTML, not even in an attribute: the popup is plain innerHTML.
import { escapeHtml } from "./config-source-render.mjs";
import { parseTomlDocument, UNPARSED } from "../harnesses/toml-document.mjs";

// Every value below one of these keys is hidden (keys still show). They hold environment values,
// request headers, process launch lines, or endpoints. Matched case-insensitively.
const HIDDEN_SUBTREE_KEYS = new Set([
  "env",
  "environment",
  "headers",
  "http_headers",
  "env_http_headers",
  "args",
  "command",
  "url",
  "apikeyhelper",
  "headershelper",
  "otelheadershelper",
  "awsauthrefresh",
  "awscredentialexport",
  "notify",
  "query_params",
]);
// A key ending in "url" (base_url, serverUrl) names an endpoint, which can embed a credential.
const URL_KEY = /url$/i;
// Codex sets environment values under shell_environment_policy.set.
const HIDDEN_CHILD_KEYS = [["shell_environment_policy", "set"]];
// A key that names a credential hides its string values; booleans and numbers stay visible.
const SECRET_KEY = /token|secret|password|passwd|credential|api[_-]?key|auth|cookie|bearer|private/i;
// Strings that carry a credential whatever key holds them: auth headers, `name=value` secrets, and
// well-known token prefixes. Permission rules can quote a whole shell command, so this applies there too.
const SECRET_TEXT = /bearer\s|authorization:|(?:token|secret|password|passwd|api[_-]?key)\s*[=:]|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\./i;
export const LONG_TEXT_LIMIT = 200;

export const HIDDEN_LABELS = Object.freeze({
  hidden: "hidden",
  long: "long text, not shown",
  unparsed: "could not be read",
});

// Whether one scalar at keyPath (string keys and array indexes from the root) may be shown.
// Returns { shown: true, text, type } or { shown: false, reason } with reason a HIDDEN_LABELS key.
export function safeConfigValue(keyPath, value) {
  if (value === UNPARSED) return { shown: false, reason: "unparsed" };
  if (typeof value === "boolean") return { shown: true, text: String(value), type: "boolean" };
  if (typeof value === "number") return { shown: true, text: String(value), type: "number" };
  if (value === null || value === undefined) return { shown: true, text: "null", type: "null" };
  if (typeof value !== "string") return { shown: false, reason: "hidden" };
  if (inHiddenSubtree(keyPath) || keyPath.some(isSecretKey)) return { shown: false, reason: "hidden" };
  if (value.includes("://") || SECRET_TEXT.test(value)) return { shown: false, reason: "hidden" };
  if (value.length > LONG_TEXT_LIMIT) return { shown: false, reason: "long" };
  return { shown: true, text: value, type: "string" };
}

function inHiddenSubtree(keyPath) {
  const keys = keyPath.filter((segment) => typeof segment === "string").map((segment) => segment.toLowerCase());
  if (keys.some((key) => HIDDEN_SUBTREE_KEYS.has(key) || URL_KEY.test(key))) return true;
  return HIDDEN_CHILD_KEYS.some(([parent, child]) => keys.some((key, index) => key === parent && keys[index + 1] === child));
}

function isSecretKey(segment) {
  return typeof segment === "string" && SECRET_KEY.test(segment);
}

// Plain nodes for a parsed config value, so the policy is testable without HTML:
//   { kind: "object", key?, children }   { kind: "array", key?, count, children }
//   { kind: "value", key?, text, type }  { kind: "hidden", key?, reason, count? }
//   { kind: "empty", key?, of: "object" | "array" }
// key is the object key, or the 1-based position for an array item that is itself a group.
export function configTree(value, keyPath = []) {
  if (Array.isArray(value)) {
    if (!value.length) return { kind: "empty", of: "array" };
    const children = value.map((item, index) => {
      const node = configTree(item, [...keyPath, index]);
      return isGroup(node) ? { ...node, key: `#${index + 1}` } : node;
    });
    // An all-hidden list of scalars (an MCP server's args) is one hidden row, not a column of them.
    if (children.every((child) => child.kind === "hidden")) {
      return { kind: "hidden", reason: children[0].reason, count: children.length };
    }
    return { kind: "array", count: value.length, children };
  }
  if (value && typeof value === "object" && value !== UNPARSED) {
    const entries = Object.entries(value);
    if (!entries.length) return { kind: "empty", of: "object" };
    return {
      kind: "object",
      children: entries.map(([key, child]) => ({ ...configTree(child, [...keyPath, key]), key })),
    };
  }
  const safe = safeConfigValue(keyPath, value);
  return safe.shown
    ? { kind: "value", text: safe.text, type: safe.type }
    : { kind: "hidden", reason: safe.reason };
}

function isGroup(node) {
  return node.kind === "object" || node.kind === "array" || node.kind === "empty";
}

export function renderConfigTreeHtml(value, { format } = {}) {
  const root = configTree(value);
  const formatAttr = format === "json" || format === "toml" ? ` data-format="${format}"` : "";
  const body = root.kind === "object" || root.kind === "array"
    ? renderList(root.children)
    : `<ul class="config-tree-list">${renderItem(root)}</ul>`;
  return `<div class="config-tree"${formatAttr}>\n${body}\n</div>`;
}

// Parses file text and renders it; a file that does not parse gets a short message, never its raw
// text. `pick` narrows the parsed value first (the `hooks` object of a settings file).
export function renderConfigFileHtml(text, { format = "json", pick = (value) => value } = {}) {
  let value;
  let diagnostic = null;
  if (format === "toml") {
    ({ value, diagnostic } = parseTomlDocument(text));
  } else {
    try {
      value = JSON.parse(text);
    } catch {
      // JSON.parse messages quote the text around the error, which can be a secret.
      return configMessageHtml("Could not parse this JSON file, so its settings are not shown.");
    }
  }
  const tree = renderConfigTreeHtml(pick(value) ?? {}, { format });
  return diagnostic ? `${configMessageHtml(diagnostic)}\n${tree}` : tree;
}

function configMessageHtml(message) {
  return `<p class="config-tree-message">${escapeHtml(message)}</p>`;
}

function renderList(nodes) {
  return `<ul class="config-tree-list">\n${nodes.map(renderItem).join("\n")}\n</ul>`;
}

function renderItem(node) {
  const key = node.key === undefined ? "" : `<span class="config-tree-key">${escapeHtml(node.key)}</span>`;
  if (node.kind === "object") return `<li class="config-tree-item">${key}\n${renderList(node.children)}</li>`;
  if (node.kind === "array") {
    return `<li class="config-tree-item">${key}${countHtml(node.count)}\n${renderList(node.children)}</li>`;
  }
  if (node.kind === "empty") return `<li class="config-tree-item">${key}<span class="config-tree-empty">empty</span></li>`;
  if (node.kind === "hidden") {
    const count = node.count === undefined ? "" : countHtml(node.count);
    return `<li class="config-tree-item">${key}${count}<span class="config-tree-hidden">${escapeHtml(HIDDEN_LABELS[node.reason])}</span></li>`;
  }
  return `<li class="config-tree-item">${key}<span class="config-tree-value config-tree-${node.type}">${escapeHtml(node.text)}</span></li>`;
}

function countHtml(count) {
  return `<span class="config-tree-count">${count} ${count === 1 ? "item" : "items"}</span>`;
}
