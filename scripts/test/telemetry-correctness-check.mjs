#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcriptStats } from "../harnesses/transcript-parse.mjs";
import { analyzeTelemetry } from "../cli/telemetry-analyze.mjs";

const FIXTURES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "telemetry");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-telemetry-correctness-"));

function fixture(name) {
  return path.join(FIXTURES_DIR, name);
}

try {
  testClaudeTranscript();
  testClaudeTranscriptFailureText();
  testCodexTranscript();
  testCodexTranscriptTurnContextModel();
  testAnalyzerWarnings();
  testAnalyzerRateLimitPresent();
  testAnalyzerIndexedSummaries();
  console.log("telemetry correctness checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function testClaudeTranscript() {
  const stats = transcriptStats(fixture("claude-basic.jsonl"), { sessionId: "claude-session", collectorDir: tmp });
  assert.equal(stats.tokens.total, 135);
  assert.equal(stats.model, "claude-test");
  assert.equal(stats.tool_calls, 1);
  assert.equal(stats.last_result.tool, "Read");
  assert.equal(stats.last_result.chars, 120);
  assert.equal(stats.last_result.is_error, false);
  // A successful result must never populate the bounded failure-text field — only the
  // is_error branch does, and only telemetry-capture.mjs's failureSignature() call consumes it.
  assert.equal(stats.last_result_failure_text, null);
}

function testClaudeTranscriptFailureText() {
  const stats = transcriptStats(fixture("claude-failure.jsonl"), { sessionId: "claude-failure-session", collectorDir: tmp });
  assert.equal(stats.last_result.is_error, true);
  assert.equal(stats.last_result_failure_text, "AssertionError: expected 1 to equal 2");
}

function testCodexTranscript() {
  const stats = transcriptStats(fixture("codex-basic.jsonl"), { sessionId: "codex-session", collectorDir: tmp });
  assert.equal(stats.model, "gpt-5.4");
  assert.equal(stats.tokens.total, 500);
  assert.equal(stats.tokens.input, 220);
  assert.equal(stats.tokens.cache_read, 80);
  assert.equal(stats.tokens.output, 120);
  assert.equal(stats.mcp_calls, 1);
  assert.equal(stats.mcp_servers.jcodemunch, 1);
  assert.equal(stats.last_result.tool, "mcp__jcodemunch__get_context_bundle");
  assert.equal(stats.details.codex_reasoning_output_tokens, 40);
  assert.equal(stats.details.codex_rate_limits[0].used_percent, 12.5);
}

// Newer Codex CLI releases (verified cli_version 0.140.0 against a real transcript) omit `model`
// from session_meta entirely and instead carry it at turn_context.payload.model — a real transcript
// on disk exposed this: the session_meta-only fix from an earlier session left every session
// recorded by a newer Codex CLI with model: null. Both shapes must resolve a model.
function testCodexTranscriptTurnContextModel() {
  const stats = transcriptStats(fixture("codex-turn-context-model.jsonl"), { sessionId: "codex-turn-context-session", collectorDir: tmp });
  assert.equal(stats.model, "gpt-5.5");
}

function testAnalyzerWarnings() {
  const events = [
    baseEvent({ session_id: "doc-session", tool: tool("Read", ".md", "doc-hash"), chars: 12000 }),
    baseEvent({ session_id: "doc-session", tool: tool("Read", ".md", "doc-hash"), chars: 11000 }),
    baseEvent({ session_id: "doc-session", tool: tool("Read", ".md", "large-hash"), chars: 25000 }),
    baseEvent({ session_id: "code-session", tool: tool("mcp__jcodemunch__get_context_bundle", null, null), chars: 2000 }),
    baseEvent({ session_id: "code-session", tool: tool("Read", ".js", "a"), chars: 1000 }),
    baseEvent({ session_id: "code-session", tool: tool("Read", ".js", "b"), chars: 1000 }),
    baseEvent({ session_id: "code-session", tool: tool("Read", ".ts", "c"), chars: 1000 }),
    baseEvent({ session_id: "code-session", tool: tool("Bash", null, null, 20), chars: 1000 }),
    {
      schema: 2,
      ts: "2026-01-01T00:00:09.000Z",
      harness: "codex",
      event: "PostToolUse",
      session_id: "bad-session",
      tokens: { total: 0 },
      details: { unsupported_usage_seen: true },
    },
  ];

  const report = analyzeTelemetry(events);
  assert(report.read_warnings.some((warning) => warning.type === "repeated_document_read"));
  assert(report.read_warnings.some((warning) => warning.type === "large_document_read"));
  assert(report.read_warnings.some((warning) => warning.type === "stale_doc_lookup"));
  assert(report.read_warnings.some((warning) => warning.type === "mixed_code_lookup"));
  assert(report.data_quality_warnings.some((warning) => warning.type === "unsupported_usage_schema"));
  // All codex events above carry nonzero tokens but no details.codex_rate_limits.
  assert(report.data_quality_warnings.some((warning) => warning.type === "rate_limit_unavailable" && warning.harness === "codex"));
}

function testAnalyzerRateLimitPresent() {
  const events = [
    baseEvent({
      session_id: "b",
      tool: tool("mcp__jcodemunch__get_context_bundle", null, null),
      chars: 400,
      harness: "codex",
      details: { codex_rate_limits: [{ name: "weekly", used_percent: 60, window_minutes: 10080 }] },
    }),
  ];
  const report = analyzeTelemetry(events);
  assert(!report.data_quality_warnings.some((warning) => warning.type === "rate_limit_unavailable"));
}

function testAnalyzerIndexedSummaries() {
  const events = [
    baseEvent({ session_id: "a", tool: tool("Read", ".js", "a"), chars: 80, ts: "2026-01-01T00:00:00.000Z", delta_tokens: 20, harness: "codex" }),
    baseEvent({ session_id: "a", tool: tool("Bash", null, null), chars: 40, ts: "2026-01-01T01:00:00.000Z", delta_tokens: 5, harness: "claude" }),
    baseEvent({
      session_id: "b",
      tool: tool("mcp__jcodemunch__get_context_bundle", null, null),
      chars: 400,
      ts: "2026-01-01T04:30:00.000Z",
      delta_tokens: 100,
      harness: "codex",
      details: { codex_rate_limits: [{ name: "weekly", used_percent: 60, window_minutes: 10080 }] },
    }),
    baseEvent({
      session_id: "b",
      tool: tool("mcp__jdocmunch__search_docs", null, null),
      chars: 160,
      ts: "2026-01-01T08:00:00.000Z",
      delta_tokens: 30,
      harness: "codex",
      details: { codex_rate_limits: [{ name: "weekly", used_percent: 75, window_minutes: 10080 }] },
    }),
  ];

  const report = analyzeTelemetry(events);
  assert.deepEqual(report.harnesses, ["claude", "codex"]);
  assert.deepEqual(
    report.top_repos.map((row) => [row.key, row.captures, row.tokens]),
    [["repo", 4, 155]],
  );
  assert.deepEqual(
    report.top_tools.map((row) => [row.key, row.captures, row.tokens]),
    [
      ["mcp__jcodemunch__get_context_bundle", 1, 100],
      ["mcp__jdocmunch__search_docs", 1, 30],
      ["Read", 1, 20],
      ["Bash", 1, 5],
    ],
  );
  assert.deepEqual(report.top_mcp.map((row) => [row.key, row.captures, row.tokens]), [["jcodemunch", 1, 100], ["jdocmunch", 1, 30]]);
  assert.equal(report.timeline.at(-1).ts, "2026-01-01T08:00:00.000Z");
  assert.equal(report.usage_windows.as_of, "2026-01-01T08:00:00.000Z");
  assert.equal(report.usage_windows.five_hour, 130);
  assert.equal(report.usage_windows.seven_day, 155);
  assert.equal(report.codex_provider_rate_limits[0].used_percent, 75);
}

function baseEvent({ session_id, tool, chars, ts = "2026-01-01T00:00:00.000Z", delta_tokens = 10, harness = "codex", details = {} }) {
  return {
    schema: 2,
    ts,
    harness,
    event: "PostToolUse",
    session_id,
    repo: { label: "repo" },
    tool,
    tokens: { total: 100, input: 80, output: 20, cache_creation: 0, cache_read: 0 },
    delta_tokens,
    session: { tool_calls: 1, mcp_calls: tool.is_mcp ? 1 : 0 },
    last_result: { tool: tool.name, chars, is_error: false },
    details,
  };
}

function tool(name, ext, hash, commandChars = 0) {
  const parts = typeof name === "string" ? name.split("__") : [];
  return {
    name,
    is_mcp: name?.startsWith("mcp__") || false,
    mcp_server: parts.length > 2 ? parts[1] : null,
    mcp_tool: parts.length > 2 ? parts.slice(2).join("__") : null,
    file_ext: ext,
    file_path_hash: hash,
    command_chars: commandChars,
  };
}
