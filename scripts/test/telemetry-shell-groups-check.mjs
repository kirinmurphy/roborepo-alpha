#!/usr/bin/env node
import assert from "node:assert/strict";
import { analyzeTelemetry } from "../cli/telemetry-analyze.mjs";
import { isTestOperation } from "../cli/telemetry-metrics.mjs";

// Shell results are grouped by the command that produced them, not by tool name. A result reaches
// the spool on a later row than its command (a PreToolUse row carries the PREVIOUS call's result),
// so these fixtures order rows the way the hooks write them.

const base = Date.parse("2026-09-01T00:00:00.000Z");
let n = 0;
const row = (harness, session, event, toolName, { category = null, result = null } = {}) => {
  n += 1;
  return {
    schema: 3, harness, session_id: session, event, capture_id: `cap-${n}`, call_id: `call-${n}`,
    ts: new Date(base + n * 1000).toISOString(), repo: { label: "demo" },
    tool: { name: toolName, is_mcp: false },
    operation: category ? { category, scope: "unknown", classifier_version: 2 } : null,
    tokens: { input: 100, output: 0, cache_creation: 0, cache_read: 0, total: 100 }, delta_tokens: 100,
    last_result: result ? { tool: result[0], chars: result[1], is_error: false } : null,
  };
};

const events = [
  // Claude: Bash read, then Bash test. Each result appears on the next row, and repeats while no new
  // shell result arrives.
  row("claude", "c1", "PreToolUse", "Bash", { category: "read" }),
  row("claude", "c1", "PreToolUse", "Edit", { result: ["Bash", 4000] }),
  row("claude", "c1", "PreToolUse", "Bash", { category: "test", result: ["Bash", 4000] }),
  row("claude", "c1", "PreToolUse", "Edit", { result: ["Bash", 9000] }),
  // A PostToolUse row carries its own call's result. The earlier read's result never reached the
  // spool, so it must not turn this git result into "mixed".
  row("claude", "c2", "PreToolUse", "Bash", { category: "read" }),
  row("claude", "c2", "PostToolUse", "Bash", { category: "git", result: ["Bash", 1200] }),
  // Codex: one exec runs a read and a git command; a historical apply_patch row classified from
  // patch text must not count. The next exec runs only a read.
  row("codex", "x1", "PreToolUse", "Bash", { category: "read" }),
  row("codex", "x1", "PreToolUse", "Bash", { category: "git" }),
  row("codex", "x1", "PreToolUse", "apply_patch", { category: "test", result: ["exec", 8000] }),
  row("codex", "x1", "PreToolUse", "Bash", { category: "read", result: ["exec", 8000] }),
  row("codex", "x1", "Stop", null, { result: ["exec", 2000] }),
  // A shell result with no classified command behind it.
  row("codex", "x2", "Stop", null, { result: ["exec", 500] }),
];

const report = analyzeTelemetry(events, {});
const groupCalls = Object.fromEntries(report.group_cost.map((group) => [group.group, group.calls]));
assert.deepEqual(groupCalls, {
  "shell-read": 3, // Claude's read result on two rows, plus Codex's read-only exec
  "shell-test": 1,
  "shell-git": 1, // a PostToolUse row's own result
  "shell-mixed": 2, // Codex exec that ran a read and a git command, on two rows
  "shell-unclassified": 1,
});
assert.ok(!("bash" in groupCalls) && !("other" in groupCalls), "shell tools never fall back to a tool-name group");

// A shell tool gets one tool_cost row per kind of command, so each group lists the tool behind it.
const toolRows = report.tool_cost.map((tool) => `${tool.tool}|${tool.group}|${tool.calls}`).sort();
assert.deepEqual(toolRows, [
  "Bash|shell-git|1",
  "Bash|shell-read|2",
  "Bash|shell-test|1",
  "exec|shell-mixed|2",
  "exec|shell-read|1",
  "exec|shell-unclassified|1",
]);

// Over-testing metrics count only shell commands; patch text that mentions a test file is not a run.
assert.equal(isTestOperation({ tool: { name: "Bash" }, operation: { category: "test" } }), true);
assert.equal(isTestOperation({ tool: { name: "apply_patch" }, operation: { category: "test" } }), false);

console.log("telemetry shell group checks passed");
