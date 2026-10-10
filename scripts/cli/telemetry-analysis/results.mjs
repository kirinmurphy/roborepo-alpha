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

export function toolGroup(toolName) {
  const server = mcpServerOf(toolName);
  // Groups named by the REAL package when the bucket is a single known server (the user reads
  // "jcodemunch", not a made-up category); generic bucket only for other/unrecognized servers.
  if (server === "jcodemunch" || server === "jdocmunch") return server;
  if (server) return "mcp-other";
  if (toolName === "Read" || toolName === "Grep" || toolName === "Glob") return "native-read";
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") return "edit";
  if (toolName === "Bash") return "bash";
  return "other";
}

export function resultCaptures(captures) {
  return captures.filter((event) => event.last_result && typeof event.last_result.chars === "number" && event.last_result.tool);
}
