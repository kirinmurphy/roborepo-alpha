// Independent interpretation of persisted evidence. Do not import production normalization.
import { createHash } from "node:crypto";

export function acceptedRows(events) {
  const unique = new Map();
  for (const row of events) {
    if (!row || ![null, 2, 3].includes(row.schema ?? null) || !(row.session_id || row.capture_id || row.tokens || row.tool)) continue;
    unique.set(stableJson(row), row);
  }
  return [...unique.values()].sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
}

function flowIdentity(row) {
  const harness = known(row.harness), session = known(row.session_id), call = known(row.call_id);
  if (row.schema === 3 && harness && session && call && !call.startsWith("derived_")) return JSON.stringify(["flow", harness, session, call]);
  const fallback = known(row.capture_id) || digest(row);
  return JSON.stringify(["capture", harness, session, fallback]);
}

export function canonicalOperations(rows) {
  const flows = new Map();
  for (const row of rows) {
    const id = flowIdentity(row);
    if (!flows.has(id)) flows.set(id, []);
    flows.get(id).push(row);
  }
  const compare = (a, b) => Number(b.event === "PostToolUse") - Number(a.event === "PostToolUse")
    || String(b.ts).localeCompare(String(a.ts))
    || String(a.spool_provenance?.source ?? "").localeCompare(String(b.spool_provenance?.source ?? ""))
    || (b.spool_provenance?.sequence ?? 0) - (a.spool_provenance?.sequence ?? 0)
    || stableJson(a).localeCompare(stableJson(b));
  return { count: flows.size, rows: [...flows.values()].map((group) => [...group].sort(compare)[0]) };
}

function normalizedUsage(tokens) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const values = [tokens.input, tokens.output, tokens.cache_creation ?? 0, tokens.cache_read ?? 0, tokens.total];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  if (!Number.isSafeInteger(values[0] + values[1] + values[2] + values[3])) return null;
  return { input: values[0] + values[2] + values[3], output: values[1], total: values[4] };
}

export function buildSessions(rows, repositoryIndex = new Map()) {
  const groups = new Map();
  for (const row of rows) {
    if (!known(row.harness) || !known(row.session_id)) continue;
    const key = sessionKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((group) => {
    const times = [...new Set(group.map((row) => validTime(row.ts)).filter(Boolean))].sort();
    const latest = times.at(-1) ?? null;
    const lastRows = group.filter((row) => validTime(row.ts) === latest);
    const usages = lastRows.map((row) => normalizedUsage(row.tokens));
    const tokens = group.every((row) => row.schema === 2 || row.schema === 3) && usages.length
      && usages.every((usage) => usage && stableJson(usage) === stableJson(usages[0])) ? usages[0] : null;
    return {
      id: JSON.stringify(["session", group[0].harness, group[0].session_id]), harness: consensus(group, (row) => known(row.harness)),
      session_id: consensus(group, (row) => known(row.session_id)),
      repository_id: consensus(group, (row) => repositoryId(row, repositoryIndex)),
      model: consensus(group, (row) => known(row.session?.model)),
      first_seen: times[0] ?? null, last_seen: latest, tokens, rows: group,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function sessionKey(row) {
  return JSON.stringify([row.harness ?? null, row.session_id || "unknown"]);
}

export function hasTokens(row) {
  return row?.tokens && typeof row.tokens.total === "number";
}

export function mcpServer(name) {
  return typeof name === "string" && name.startsWith("mcp__") ? name.split("__")[1] || null : null;
}

// The input is raw registry evidence, never production's derived hash index.
export function repositoryEvidence(registry) {
  const index = new Map(), issues = [];
  if (registry != null && (!isRecord(registry) || !isRecord(registry.repositories))) {
    return { index, issues: ["malformed_repository_registry"] };
  }
  for (const record of Object.values(registry?.repositories ?? {})) {
    if (!isRecord(record) || !known(record.id) || (record.normalizedRemote != null && typeof record.normalizedRemote !== "string")) {
      issues.push("malformed_repository_registry"); continue;
    }
    if (!record.normalizedRemote) continue;
    const hash = createHash("sha256").update(record.normalizedRemote).digest("hex").slice(0, 24);
    if (index.has(hash) && index.get(hash) !== record.id) issues.push("ambiguous_repository_registry");
    index.set(hash, record.id);
  }
  return { index, issues };
}

// Bare jcodemunch and jdocmunch tool names that Codex logs without the mcp__ prefix. Production
// attributes these to an MCP server; every other bare name is a native tool on both sides. Kept as
// the oracle's own copy rather than imported, so the oracle stays independent of production
// attribution. A name production adds later reads as native here, and the comparison surfaces any
// covered field that attribution changes.
const BARE_MCP_TOOL_NAMES = new Set([
  "resolve_repo", "search_text", "search_symbols", "find_references", "get_file_content",
  "get_file_outline", "get_file_tree", "get_repo_outline", "get_context_bundle", "get_ranked_context",
  "get_symbol_source", "get_symbol_importance", "get_related_symbols", "get_changed_symbols",
  "get_project_intel", "get_session_context", "get_watch_status", "get_pr_risk_profile",
  "index_file", "index_folder", "index_repo", "register_edit", "plan_turn", "list_repos",
  "audit_agent_config", "link_code_to_symbols", "load_workspace_dependencies",
  "search_sections", "get_section", "get_sections", "get_section_context", "get_toc", "get_toc_tree",
  "get_document_outline", "get_doc_coverage", "get_broken_links", "doc_list_repos", "list_docs",
  "list_repo_groups", "index_local", "delete_index",
]);

export function eventSupport(row, repositoryIndex) {
  if (!isRecord(row)) return { issues: ["malformed_event"], comparable: false };
  const issues = [];
  if (![null, 2, 3].includes(row.schema ?? null)) issues.push("unsupported_event_schema");
  if (!known(row.harness) || !known(row.session_id)) issues.push("unidentified_session");
  if (typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts))) issues.push("invalid_timestamp");
  if (row.tokens != null && !normalizedUsage(row.tokens)) issues.push("malformed_tokens");
  if (["repo", "session", "tool", "last_result", "spool_provenance"].some((field) => row[field] != null && !isRecord(row[field]))) issues.push("malformed_event");
  if ((row.repo?.repository_id && !known(row.repo.repository_id))
    || (row.repo?.normalized_remote_hash != null && typeof row.repo.normalized_remote_hash !== "string")) issues.push("malformed_repository");
  if ([row.delta_tokens, row.last_result?.chars, row.tool?.command_chars].some((value) => value != null && (!Number.isFinite(value) || value < 0))) issues.push("malformed_event");
  const names = [row.tool?.name, row.tool?.mcp_tool, row.last_result?.tool].filter((name) => name != null);
  if (names.some((name) => typeof name !== "string")) issues.push("malformed_event");
  // Bare MCP names need an independent attribution the oracle does not have. Never silently call
  // them "other" while production recognizes them as jcodemunch or jdocmunch. Only the tool name
  // and result tool are attributed to a server; `tool.mcp_tool` is the bare suffix of a prefixed
  // name whose server is already known.
  else if ([row.tool?.name, row.last_result?.tool].some((name) => BARE_MCP_TOOL_NAMES.has(name))) issues.push("unsupported_bare_tool");
  const comparable = issues.length === 0;
  if (!repositoryId(row, repositoryIndex)) issues.push("unresolved_repository");
  if (!known(row.session?.model)) issues.push("unknown_model");
  return { issues: [...new Set(issues)], comparable };
}

export function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function repositoryId(row, index) {
  return known(row.repo?.repository_id);
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function known(value) {
  return typeof value === "string" && value && value !== "unknown" ? value : null;
}

function validTime(value) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function consensus(rows, pick) {
  const values = rows.map(pick);
  return values.length && values.every((value) => value != null && value === values[0]) ? values[0] : null;
}
