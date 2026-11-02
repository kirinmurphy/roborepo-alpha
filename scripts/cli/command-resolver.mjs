import { childEntries, displayTokens, isAvailableHere } from "./command-catalog.mjs";

export function resolveCommand(catalog, args) {
  const normalized = normalizeHelpArgs(args);
  if (normalized.help) return resolveHelpPath(catalog, normalized.path);
  if (normalized.path.length === 0) return { kind: "root-menu", tokens: [] };

  const match = matchPath(catalog, normalized.path);
  if (!match) return invalid(catalog, normalized.path);
  if (match.node.kind === "namespace" && match.rest.length === 0) {
    return { kind: "menu", node: match.node, tokens: match.tokens };
  }
  if (match.node.kind === "namespace" && match.node.execution) {
    return { kind: "command", node: match.node, tokens: match.tokens, args: match.rest };
  }
  if (match.node.kind === "command" || match.node.kind === "internal") {
    return { kind: "command", node: match.node, tokens: match.tokens, args: match.rest };
  }
  return invalid(catalog, normalized.path);
}

export function normalizeHelpArgs(args) {
  if (args.length === 0) return { help: false, path: [] };
  if (args[0] === "help") return { help: true, path: args.slice(1) };
  if (args[0] === "--help" || args[0] === "-h") return { help: true, path: [] };
  const helpAt = args.findIndex((arg) => arg === "help" || arg === "--help" || arg === "-h");
  if (helpAt >= 0) return { help: true, path: args.slice(0, helpAt) };
  return { help: false, path: args };
}

export function matchPath(catalog, args) {
  let children = catalog.nodes;
  let node = null;
  let tokens = [];
  let consumed = 0;
  while (consumed < args.length) {
    const next = children[args[consumed]];
    if (!next) break;
    // Resolution walks raw children rather than childEntries, so an unavailable node would still
    // resolve and open its menu even though every listing hides it. Stopping here makes
    // `roborepo dev` on an npm install take the ordinary unknown-command path instead.
    if (!isAvailableHere(next)) break;
    node = next;
    tokens = displayTokens(args[consumed], next, tokens);
    consumed += 1;
    if (!next.children) break;
    children = next.children;
  }
  if (!node) return null;
  return { node, tokens, rest: args.slice(consumed) };
}

function resolveHelpPath(catalog, path) {
  if (path.length === 0) return { kind: "help", node: null, tokens: [] };
  const match = matchPath(catalog, path);
  if (!match || match.rest.length > 0) return invalid(catalog, path);
  return { kind: "help", node: match.node, tokens: match.tokens };
}

function invalid(catalog, tokens) {
  return { kind: "invalid", tokens, suggestions: suggest(catalog, tokens) };
}

function suggest(catalog, args) {
  const prefix = args.slice(0, -1);
  const partial = args.at(-1) || "";
  const parent = prefix.length === 0 ? { children: catalog.nodes } : matchPath(catalog, prefix)?.node;
  if (!parent?.children && prefix.length > 0) return [];
  return childEntries(parent || { children: catalog.nodes }, { includeInternal: false })
    .map(({ key }) => key)
    .filter((key) => key.startsWith(partial))
    .slice(0, 5);
}
