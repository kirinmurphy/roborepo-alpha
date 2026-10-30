import { conditionDemoEvidence } from "./telemetry-conditions-demo.mjs";
import { writeSnapshot } from "./telemetry-schemas/persistence.mjs";
import fs from "node:fs";
import path from "node:path";
import { privacyHash } from "./telemetry-schemas/hash.mjs";
import { telemetrySpoolDir } from "./state-paths.mjs";

// Seeds the telemetry spool with synthetic demo sessions so `roborepo web` shows the
// full range of dashboard outputs (quiet sessions, Bash/MCP-heavy sessions, token spikes, multiple
// repos and models) without needing real conversations. Records are schema v3 and match the shape
// telemetryCapture() writes, so the analyze/dashboard path treats them exactly like real captures.
//
// All demo records land in a dedicated DEMO_FILE inside the spool dir. readSpoolEvents() globs every
// *.jsonl in that dir, so the file is picked up automatically and can be removed in one delete to
// undo the seed (run with `--clear`). This never touches the real claude.jsonl / codex.jsonl spools.

const SCHEMA_VERSION = 3;
const DEMO_FILE = "demo.jsonl";

// Demo records must hash identically to real captures, or the dashboard treats them as a separate
// repository — hence the shared helper rather than a local copy.
const hash = privacyHash;

// Base timestamp the demo sessions are spread back from, so the timeline has spacing and ordering.
const BASE = Date.parse("2026-06-15T18:00:00.000Z");
const ts = (minutesAgo) => new Date(BASE - minutesAgo * 60_000).toISOString();

function repo(label) {
  return {
    label,
    branch: "main",
  };
}

function tool(name, { command = null } = {}) {
  const isMcp = typeof name === "string" && name.startsWith("mcp__");
  const mcpServer = isMcp ? name.slice("mcp__".length).split("__")[0] || null : null;
  return {
    name,
    is_mcp: isMcp,
    mcp_server: mcpServer,
    command_hash: command ? hash(command) : null,
    command_chars: command ? command.length : 0,
    command_lines: command ? command.split("\n").length : 0,
  };
}

// One capture record. `session` carries the running session-level rollup; `delta` is the marginal
// token cost the dashboard plots and uses to classify spikes.
function capture({ minutesAgo, harness, event, sessionId, repoLabel, model, tokensTotal, delta, toolName, toolCalls, mcpCalls, command, resultChars, biggestResult }) {
  const lastResult = toolName ? { tool: toolName, chars: resultChars ?? 0, is_error: false } : null;
  return {
    schema: SCHEMA_VERSION,
    ts: ts(minutesAgo),
    harness,
    event,
    session_id: sessionId,
    cwd_hash: hash(`/Users/demo/projects/${repoLabel}`),
    repo: repo(repoLabel),
    tool: tool(toolName, { command }),
    prompt: { chars: 0, hash: null },
    tokens: {
      input: Math.round(tokensTotal * 0.02),
      output: Math.round(tokensTotal * 0.01),
      cache_creation: Math.round(tokensTotal * 0.05),
      cache_read: Math.round(tokensTotal * 0.92),
      total: tokensTotal,
    },
    delta_tokens: delta,
    session: {
      model,
      assistant_turns: Math.max(1, Math.round(toolCalls / 2)),
      tool_calls: toolCalls,
      mcp_calls: mcpCalls,
      max_output_tokens: 4096,
    },
    // Drives the spike-cause classifier: a heavy last_result is what the dashboard attributes the
    // delta to. ~4 chars/token, so result chars track the step's delta.
    last_result: lastResult,
    biggest_result: biggestResult ?? lastResult,
  };
}

// Builds a session as a sequence of captures whose running token total grows by each step's delta.
// The largest deltas are what trip the spike classifier, so MCP/refactor sessions read as spikes.
function session({ harness, sessionId, repoLabel, model, startMinutesAgo, steps }) {
  const records = [];
  let total = 0;
  let toolCalls = 0;
  let mcpCalls = 0;
  let biggest = null;
  // Result size that landed in context for each step. ~4 chars/token, so a heavy delta implies a
  // heavy tool result — which is exactly what the spike-cause classifier keys off.
  const stepChars = (step) => (step.tool ? Math.round(step.delta * 4) : 0);
  steps.forEach((step, index) => {
    total += step.delta;
    toolCalls += 1;
    if (typeof step.tool === "string" && step.tool.startsWith("mcp__")) mcpCalls += 1;
    const chars = stepChars(step);
    if (step.tool && (!biggest || chars > biggest.chars)) biggest = { tool: step.tool, chars, is_error: false };
    records.push(
      capture({
        minutesAgo: startMinutesAgo - index,
        harness,
        event: index === 0 ? "SessionStart" : "PreToolUse",
        sessionId,
        repoLabel,
        model,
        tokensTotal: total,
        delta: step.delta,
        toolName: step.tool ?? null,
        toolCalls,
        mcpCalls,
        command: step.command ?? null,
        resultChars: chars,
        biggestResult: biggest ? { ...biggest } : null,
      }),
    );
  });
  return records;
}

// Five sessions chosen to populate every dashboard panel with contrasting shapes.
function demoRecords() {
  const records = [];

  // 1. Quiet docs edit — tiny deltas, Read/Edit only. Anchors the "normal" cohort and keeps the
  //    spike threshold meaningful (mean stays low so the big sessions clearly stand out).
  records.push(
    ...session({
      harness: "claude",
      sessionId: "demo-quiet-docs-0001",
      repoLabel: "marketing-site",
      model: "claude-haiku-4-5",
      startMinutesAgo: 600,
      steps: [
        { tool: "Read", delta: 18_000 },
        { tool: "Edit", delta: 9_000 },
        { tool: "Read", delta: 7_500 },
        { tool: "Edit", delta: 11_000 },
      ],
    }),
  );

  // 2. Bash-heavy build/test loop — mid-sized deltas concentrated on Bash, so "token by tool" shows
  //    Bash dominating without any MCP usage.
  records.push(
    ...session({
      harness: "claude",
      sessionId: "demo-bash-ci-0002",
      repoLabel: "payments-api",
      model: "claude-sonnet-4-6",
      startMinutesAgo: 480,
      steps: [
        { tool: "Bash", delta: 40_000, command: "npm ci" },
        { tool: "Bash", delta: 55_000, command: "npm run build" },
        { tool: "Read", delta: 22_000 },
        // Verbose test run dumped to context — the classic unbounded-bash-output spike.
        { tool: "Bash", delta: 1_150_000, command: "npm test -- --verbose 2>&1" },
        { tool: "Edit", delta: 30_000 },
      ],
    }),
  );

  // 3. MCP-heavy exploration — large code-search/doc-search MCP deltas that trip the spike threshold and
  //    fill the "token by MCP server" panel and the spike-vs-normal MCP rate.
  records.push(
    ...session({
      harness: "claude",
      sessionId: "demo-mcp-explore-0003",
      repoLabel: "platform-core",
      model: "claude-opus-4-8",
      startMinutesAgo: 360,
      steps: [
        { tool: "mcp__code-search__resolve_repo", delta: 120_000 },
        // Oversized context bundle pulled the whole module tree in — an mcp-bundle spike.
        { tool: "mcp__code-search__get_context_bundle", delta: 1_120_000 },
        { tool: "mcp__code-search__find_references", delta: 260_000 },
        { tool: "mcp__doc-search__search_sections", delta: 340_000 },
        { tool: "Read", delta: 60_000 },
      ],
    }),
  );

  // 4. Long Opus refactor — many captures with one runaway spike (a huge context bundle) so the
  //    timeline shows a clear spike bar and the spikes table has a standout row.
  records.push(
    ...session({
      harness: "claude",
      sessionId: "demo-refactor-0004",
      repoLabel: "platform-core",
      model: "claude-opus-4-8",
      startMinutesAgo: 240,
      steps: [
        { tool: "Read", delta: 45_000 },
        { tool: "Grep", delta: 38_000 },
        // Read of a generated/minified file — the large-file-read spike.
        { tool: "Read", delta: 1_180_000 },
        { tool: "mcp__code-search__get_blast_radius", delta: 1_200_000 },
        { tool: "Edit", delta: 61_000 },
        { tool: "Bash", delta: 47_000, command: "npm run typecheck" },
      ],
    }),
  );

  // 5. Codex session in a different repo/model — exercises the multi-harness and multi-repo views so
  //    "top sessions" isn't single-repo.
  records.push(
    ...session({
      harness: "codex",
      sessionId: "demo-codex-feature-0005",
      repoLabel: "mobile-app",
      model: "gpt-5-codex",
      startMinutesAgo: 120,
      steps: [
        { tool: "Read", delta: 26_000 },
        { tool: "Bash", delta: 33_000, command: "yarn install" },
        { tool: "Edit", delta: 41_000 },
        { tool: "Edit", delta: 29_000 },
      ],
    }),
  );

  return records;
}

function main() {
  const clear = process.argv.includes("--clear");
  fs.mkdirSync(telemetrySpoolDir, { recursive: true });
  const target = path.join(telemetrySpoolDir, DEMO_FILE);
  if (clear) {
    fs.rmSync(target, { force: true });
    console.log(`removed ${target}`);
    return;
  }
  const evidence = conditionDemoEvidence(demoRecords());
  const records = evidence.events;
  for (const snapshot of evidence.snapshots) writeSnapshot(snapshot);
  const body = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  fs.writeFileSync(target, body);
  const sessionCount = new Set(records.map((record) => JSON.stringify([record.harness, record.session_id]))).size;
  console.log(`seeded ${records.length} demo captures across ${sessionCount} sessions (including a synthetic baseline/focused comparison cohort) -> ${target}`);
  console.log("run `roborepo web` to view; rerun with --clear to remove.");
}

main();
