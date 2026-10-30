import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readAppendedLines } from "../cli/jsonl-tail.mjs";

// Reads a harness transcript (JSONL) and derives the session-level context that explains token
// spikes: cumulative token usage, turn/tool counts, and which tools/MCP servers were exercised.
// Pure local file read — never throws to callers (telemetry hooks must not fail a session).
//
// Incremental by session: a long session's transcript grows every turn, and this used to be called
// on every PreToolUse/PostToolUse with a full read+reparse from byte 0 — O(n) per call, O(n^2) over
// a session. A per-session cursor (byte offset + carried-forward counters) lets each call parse only
// the bytes appended since the last capture. `collectorDir` is required for the cursor to persist;
// omit it (or pass no sessionId) to fall back to a full one-shot parse with no cursor.

const MCP_TOOL_PREFIX = "mcp__";

function cursorPath(collectorDir, sessionId) {
  const key = createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 24);
  return path.join(collectorDir, `transcript-${key}.json`);
}

function emptyCounters() {
  return {
    byteOffset: 0,
    tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
    totalTokensOverride: null,
    tokenSchemaSeen: false,
    unsupportedUsageSeen: false,
    codexRateLimits: null,
    codexReasoningOutputTokens: 0,
    toolCounts: {},
    mcpServers: {},
    assistantTurns: 0,
    toolCalls: 0,
    mcpCalls: 0,
    maxOutputTokens: 0,
    model: null,
    biggestResult: null,
    // tool_use ids seen but not yet matched to a tool_result — carried forward so a result landing
    // in the NEXT chunk can still resolve back to the tool that produced it.
    pendingToolNameById: {},
  };
}

function loadCursor(collectorDir, sessionId) {
  if (!collectorDir || !sessionId) return null;
  try {
    return JSON.parse(fs.readFileSync(cursorPath(collectorDir, sessionId), "utf8"));
  } catch {
    return null;
  }
}

function saveCursor(collectorDir, sessionId, cursor) {
  if (!collectorDir || !sessionId) return;
  try {
    fs.mkdirSync(collectorDir, { recursive: true });
    fs.writeFileSync(cursorPath(collectorDir, sessionId), JSON.stringify(cursor));
  } catch {
    // Best-effort; a failed write just means the next call re-parses from this call's offset (or 0).
  }
}

export function transcriptStats(transcriptPath, { sessionId, collectorDir } = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;

  const cursor = loadCursor(collectorDir, sessionId);
  // Read only the bytes appended since the cursor's offset (shrink/rotation restarts from 0, flagged
  // by `rebuilt`; the partial trailing line is held back inside readAppendedLines). Shared with the
  // spool store's incremental read — see jsonl-tail.mjs.
  const { lines, nextOffset, rebuilt, ok } = readAppendedLines(
    transcriptPath,
    cursor?.byteOffset ?? 0,
  );
  if (!ok) return null; // No transcript yet (e.g. SessionStart) or unreadable; capture metadata only.
  const counters = cursor && !rebuilt && cursor.byteOffset > 0 ? hydrateCounters(cursor) : emptyCounters();

  let lastResult = null;
  let lastResultFailureText = null;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Skip partial/corrupt lines; a half-written tail must not break capture.
    }
    const message = entry.message;
    const codexResult = applyCodexEntry(counters, entry);
    if (codexResult?.last_result) {
      lastResult = codexResult.last_result;
      if (codexResult.last_result.is_error) lastResultFailureText = codexResult.failure_text ?? null;
      if (!counters.biggestResult || codexResult.last_result.chars > counters.biggestResult.chars) {
        counters.biggestResult = codexResult.last_result;
      }
    }
    if (!message) continue;

    if (entry.type === "assistant") {
      counters.assistantTurns += 1;
      if (message.model) counters.model = message.model;
      if (message.usage) {
        counters.tokenSchemaSeen = true;
        addUsage(counters.tokens, message.usage);
        counters.maxOutputTokens = Math.max(counters.maxOutputTokens, message.usage.output_tokens || 0);
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type !== "tool_use" || typeof block.name !== "string") continue;
        counters.toolCalls += 1;
        bump(counters.toolCounts, block.name);
        if (typeof block.id === "string") counters.pendingToolNameById[block.id] = block.name;
        const server = mcpServerOf(block.name);
        if (server) {
          counters.mcpCalls += 1;
          bump(counters.mcpServers, server);
        }
      }
      continue;
    }

    // tool_result blocks come back on `user` entries, keyed to the tool_use that produced them.
    if (entry.type === "user") {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type !== "tool_result") continue;
        const tool = counters.pendingToolNameById[block.tool_use_id] ?? null;
        delete counters.pendingToolNameById[block.tool_use_id];
        const isError = block.is_error === true;
        const result = { tool, chars: resultChars(block.content), is_error: isError };
        lastResult = result;
        // Bounded failure text lives only on the return value, never on `result`/`lastResult` (which
        // get persisted to the spool as last_result/biggest_result) — capture.mjs must hash this
        // immediately and never store it. Only computed on the error path since success text is
        // never needed for a failure signature.
        if (isError) lastResultFailureText = resultText(block.content);
        if (!counters.biggestResult || result.chars > counters.biggestResult.chars) counters.biggestResult = result;
      }
    }
  }

  counters.byteOffset = nextOffset;
  saveCursor(collectorDir, sessionId, counters);

  const computedTotal = counters.tokens.input + counters.tokens.output + counters.tokens.cache_creation + counters.tokens.cache_read;
  const tokens = { ...counters.tokens, total: counters.totalTokensOverride ?? computedTotal };
  return {
    model: counters.model,
    tokens,
    max_output_tokens: counters.maxOutputTokens,
    assistant_turns: counters.assistantTurns,
    tool_calls: counters.toolCalls,
    mcp_calls: counters.mcpCalls,
    tools: { ...counters.toolCounts },
    mcp_servers: { ...counters.mcpServers },
    details: {
      token_schema_seen: counters.tokenSchemaSeen,
      unsupported_usage_seen: counters.unsupportedUsageSeen,
      codex_reasoning_output_tokens: counters.codexReasoningOutputTokens,
      codex_rate_limits: counters.codexRateLimits,
    },
    // Freshest result this call saw (likely driver of this capture's delta); null when this call's
    // chunk had no new tool_result (e.g. two hook fires between one tool's use and its result).
    last_result: lastResult,
    biggest_result: counters.biggestResult,
    // Bounded, transient-only failure text for telemetry-capture.mjs to hash into
    // operation.failure_signature — never persisted itself and never part of last_result/biggest_result.
    last_result_failure_text: lastResultFailureText,
  };
}

function hydrateCounters(cursor) {
  return {
    byteOffset: cursor.byteOffset || 0,
    tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0, ...cursor.tokens },
    totalTokensOverride: typeof cursor.totalTokensOverride === "number" ? cursor.totalTokensOverride : null,
    tokenSchemaSeen: cursor.tokenSchemaSeen === true,
    unsupportedUsageSeen: cursor.unsupportedUsageSeen === true,
    codexRateLimits: cursor.codexRateLimits || null,
    codexReasoningOutputTokens: cursor.codexReasoningOutputTokens || 0,
    toolCounts: { ...cursor.toolCounts },
    mcpServers: { ...cursor.mcpServers },
    assistantTurns: cursor.assistantTurns || 0,
    toolCalls: cursor.toolCalls || 0,
    mcpCalls: cursor.mcpCalls || 0,
    maxOutputTokens: cursor.maxOutputTokens || 0,
    model: cursor.model || null,
    biggestResult: cursor.biggestResult || null,
    pendingToolNameById: { ...cursor.pendingToolNameById },
  };
}

// Size a tool_result's content without retaining it: results are either a plain string or an array
// of content blocks (text/image). We count characters of text and approximate non-text blocks by
// their serialized length, so an oversized result is visible even if it isn't plain prose.
function resultChars(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : safeLen(block)), 0);
  }
  return safeLen(content);
}

// Bounded text for the failure-signature hash only (telemetry-classify.mjs's failureSignature()
// itself truncates to 2000 chars and hashes; this cap just avoids building a huge intermediate
// string first). Callers must hash this immediately and never persist it — see the is_error branches
// above, which set this only transiently before returning it up to telemetry-capture.mjs.
const FAILURE_TEXT_CAP = 4000;
function resultText(content) {
  if (typeof content === "string") return content.slice(0, FAILURE_TEXT_CAP);
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join(" ")
      .slice(0, FAILURE_TEXT_CAP);
  }
  return "";
}

function applyCodexEntry(counters, entry) {
  // Model location has moved across Codex CLI versions: older releases (verified cli_version
  // 0.118.0) put it at session_meta.payload.model, a one-time session-start entry; newer releases
  // (verified 0.140.0) omit it there and instead carry it at turn_context.payload.model, emitted
  // once per turn (collaboration_mode.settings.model can differ per-turn in some modes, but
  // payload.model is the turn's actual active model). Check both shapes rather than assuming one —
  // a transcript recorded by either CLI version must still resolve a model. This must run before
  // the event_msg/response_item gate below, which returns early for every other entry type.
  if (entry.type === "session_meta" || entry.type === "turn_context") {
    const model = entry.payload?.model;
    if (typeof model === "string" && model) counters.model = model;
    return null;
  }
  if (entry.type !== "event_msg" && entry.type !== "response_item") return null;
  const payload = entry.payload || {};
  const eventName = payload.type || entry.name;
  if (entry.type === "event_msg" && eventName === "token_count") {
    const info = payload.info || {};
    const usage = info.total_token_usage || {};
    const total = numberOrNull(usage.total_tokens);
    if (total !== null) {
      counters.tokenSchemaSeen = true;
      counters.totalTokensOverride = total;
      const input = numberOrNull(usage.input_tokens) || 0;
      const cached = numberOrNull(usage.cached_input_tokens) || 0;
      counters.tokens.input = Math.max(0, input - cached);
      counters.tokens.cache_read = cached;
      counters.tokens.output = numberOrNull(usage.output_tokens) || 0;
      counters.tokens.cache_creation = numberOrNull(usage.cache_creation_input_tokens)
        ?? numberOrNull(usage.cache_write_input_tokens)
        ?? 0;
      counters.codexReasoningOutputTokens = numberOrNull(usage.reasoning_output_tokens) || counters.codexReasoningOutputTokens;
      counters.maxOutputTokens = Math.max(counters.maxOutputTokens, counters.tokens.output);
    } else {
      counters.unsupportedUsageSeen = true;
    }
    if (payload.rate_limits) counters.codexRateLimits = privacySafeRateLimits(payload.rate_limits);
    return null;
  }

  if (entry.type === "event_msg" && eventName === "mcp_tool_call_end") {
    recordCodexToolCall(counters, payload.tool_name || payload.name || payload.tool);
    return null;
  }

  if (entry.type !== "response_item") return null;
  const item = payload.type ? payload : entry.item || {};
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    recordCodexToolCall(counters, item.name || item.tool_name);
    if (typeof item.call_id === "string") counters.pendingToolNameById[item.call_id] = item.name || item.tool_name;
    if (typeof item.id === "string") counters.pendingToolNameById[item.id] = item.name || item.tool_name;
    return null;
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    const tool = counters.pendingToolNameById[item.call_id] || counters.pendingToolNameById[item.id] || null;
    delete counters.pendingToolNameById[item.call_id];
    delete counters.pendingToolNameById[item.id];
    const isError = item.is_error === true;
    return {
      last_result: { tool, chars: resultChars(item.output), is_error: isError },
      failure_text: isError ? resultText(item.output) : null,
    };
  }
  return null;
}

function recordCodexToolCall(counters, toolName) {
  if (typeof toolName !== "string" || !toolName) return;
  counters.toolCalls += 1;
  bump(counters.toolCounts, toolName);
  const server = mcpServerOf(toolName);
  if (server) {
    counters.mcpCalls += 1;
    bump(counters.mcpServers, server);
  }
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Codex's telemetry-rate-limits capability adapter (parseRateLimits): strips a raw rate_limits
// payload down to the privacy-safe fields captured at parse time — same function transcriptStats
// already calls inline via applyCodexEntry, exported here so the capability contract has a real
// standalone method rather than a notYetMigrated stub.
export function privacySafeRateLimits(rateLimits) {
  if (rateLimits && typeof rateLimits === "object" && !Array.isArray(rateLimits)
    && ("primary" in rateLimits || "secondary" in rateLimits)) {
    return ["primary", "secondary"]
      .filter((name) => rateLimits[name] && typeof rateLimits[name] === "object")
      .map((name) => privacySafeRateLimit(rateLimits[name], name));
  }
  if (!Array.isArray(rateLimits)) return rateLimits && typeof rateLimits === "object" ? privacySafeRateLimit(rateLimits) : null;
  return rateLimits.map((limit) => privacySafeRateLimit(limit)).filter(Boolean);
}

function privacySafeRateLimit(limit, fallbackName = null) {
  if (!limit || typeof limit !== "object") return null;
  const reset = numberOrNull(limit.resets_at);
  const resetDate = reset === null ? null : new Date(reset * 1000);
  return {
    name: typeof limit.name === "string" ? limit.name : fallbackName,
    used_percent: numberOrNull(limit.used_percent),
    window_minutes: numberOrNull(limit.window_minutes),
    resets_at: typeof limit.resets_at === "string" ? limit.resets_at
      : resetDate && !Number.isNaN(resetDate.getTime()) ? resetDate.toISOString() : null,
  };
}

function safeLen(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

// The MCP server a tool belongs to, or null for a native tool. Handles both the prefixed wire name
// (mcp__server__tool).
export function mcpServerOf(toolName) {
  if (typeof toolName !== "string" || !toolName) return null;
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return toolName.slice(MCP_TOOL_PREFIX.length).split("__")[0] || null;
  return null;
}

function addUsage(tokens, usage) {
  if (!usage) return;
  tokens.input += usage.input_tokens || 0;
  tokens.output += usage.output_tokens || 0;
  tokens.cache_creation += usage.cache_creation_input_tokens || 0;
  tokens.cache_read += usage.cache_read_input_tokens || 0;
}

function bump(obj, key) {
  obj[key] = (obj[key] ?? 0) + 1;
}
