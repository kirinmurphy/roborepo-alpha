import { SHELL_RESULT_TOOL_NAMES, SHELL_TOOL_NAMES, shellOperation } from "../telemetry-classify.mjs";
import { sessionKeyOf } from "./captures.mjs";
import { mcpServerOf } from "../../harnesses/transcript-parse.mjs";
// Result sizes estimate context cost at four characters per token. MCP names resolve centrally.
export function approxTokens(chars) {
  return Math.round((chars || 0) / 4);
}

export function resultToolLabel(toolName) {
  const server = mcpServerOf(toolName);
  if (!server) return toolName;
  const tool = String(toolName).split("__").slice(2).join("__");
  return tool ? server + " · " + tool : server;
}

export function toolGroup(toolName, shellCategory = null) {
  const server = mcpServerOf(toolName);
  // Groups named by the REAL package when the bucket is a single known server (the user reads
  // "jcodemunch", not a made-up category); generic bucket only for other/unrecognized servers.
  if (server === "jcodemunch" || server === "jdocmunch") return server;
  if (server) return "mcp-other";
  if (toolName === "Read" || toolName === "Grep" || toolName === "Glob") return "native-read";
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") return "edit";
  if (SHELL_RESULT_TOOL_NAMES.has(toolName)) return `shell-${shellCategory ?? "unclassified"}`;
  return "other";
}

export function resultCaptures(captures) {
  return captures.filter((event) => event.last_result && typeof event.last_result.chars === "number" && event.last_result.tool);
}

export function resultGroupOf(rows) {
  const shellCategories = linkShellResultCategories(rows);
  return (event) => toolGroup(event.last_result.tool, shellCategories.get(event));
}

// A shell result reaches the spool on a later row than its command. A PreToolUse row carries the
// operation about to run but the PREVIOUS call's result; a PostToolUse row usually carries its own
// call's result. So each session is walked in time order, collecting the categories of shell calls
// since the last new shell result. One Codex `exec` can run several commands (its hooks see each
// one, with no PostToolUse for the cell): one distinct category names the group, several make it
// "mixed". A PostToolUse row means that call finished, so it replaces pending categories whose
// results never reached the spool. Repeats of the same result (it stays the last result across later
// rows) keep the category already linked. Best-effort: parallel calls can misattribute.
function linkShellResultCategories(rows) {
  const linked = new Map();
  const bySession = new Map();
  for (const row of rows) {
    const key = sessionKeyOf(row);
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(row);
  }
  for (const sessionRows of bySession.values()) {
    sessionRows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    let pending = [];
    let current = null;
    let currentResult = null;
    for (const row of sessionRows) {
      const operation = SHELL_TOOL_NAMES.has(row.tool?.name) ? shellOperation(row) : null;
      const ownResult = row.event === "PostToolUse";
      if (operation && ownResult) pending = [operation.category];
      const result = row.last_result;
      if (result && SHELL_RESULT_TOOL_NAMES.has(result.tool)) {
        const resultKey = `${result.tool}:${result.chars}:${result.is_error}`;
        if (resultKey !== currentResult) {
          const distinct = new Set(pending);
          current = distinct.size === 0 ? null : distinct.size === 1 ? pending[0] : "mixed";
          pending = [];
          currentResult = resultKey;
        }
        linked.set(row, current);
      }
      if (operation && !ownResult) pending.push(operation.category);
    }
  }
  return linked;
}
