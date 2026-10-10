// Turns raw spool events into the views that explain token spikes: per-session rollups, a spike
// classifier, top token contributors, and a spike-vs-normal comparison. Shared by the terminal
// report and the dashboard JSON API so both speak the same numbers. Pure functions over arrays —
// no I/O — so the server and CLI can each read the spool their own way.

import { buildConditionsReport } from "./telemetry-conditions.mjs";
import { createHash } from "node:crypto";
import { normalizeObservations, canonicalFlowRows } from "./telemetry-observations.mjs";
import { mcpServerOf } from "../harnesses/transcript-parse.mjs";
import { deriveInsights } from "./telemetry-insights.mjs";
import { computeMetric, isFullSuite } from "./telemetry-metrics.mjs";
import { createWasteLedger } from "./telemetry-waste.mjs";
import { applyCohortFilter, normalizeCohortFilter, describeCohortFilter, activeFilterCount } from "./telemetry-cohort.mjs";
import { compareAcrossMarker, describeMarkerComparison } from "./telemetry-compare.mjs";
import { hasHarnessProvider, getHarnessProvider } from "../harnesses/registry.mjs";

// Whether `harness` declares the telemetry-rate-limits capability — Codex today, potentially other
// providers later. Namespaced field name (event.details.codex_rate_limits) stays as-is (see the
// field-shape note above hasRateLimits' call sites): either normalizing the field or
// namespacing it as a provider extension was acceptable, and the field was already namespaced. What was still hardcoded was the *check* (`harness === "codex"`), not the data shape —
// this makes the check capability-driven so a future rate-limited provider doesn't need a new
// literal string added here.
function hasRateLimitsCapability(harness) {
  return hasHarnessProvider(harness) && getHarnessProvider(harness).manifest.capabilities.includes("telemetry-rate-limits");
}

// A capture counts as a spike when its token delta exceeds the mean by this many standard
// deviations. Tunable, but kept conservative so quiet sessions never trip the threshold.
const SPIKE_SIGMA = 2;
// Minimum absolute delta (tokens) to ever count as a spike — prevents statistical noise from
// flagging trivially small events in very quiet sessions.
const MIN_SPIKE_THRESHOLD = 50_000;

const LARGE_DOCUMENT_READ_CHARS = 20000;
const REPEATED_DOCUMENT_READ_COUNT = 2;
const MIXED_CODE_LOOKUP_NATIVE_READS = 4;
const DOC_EXTS = new Set([".md", ".mdx", ".rst", ".txt"]);
const SOURCE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".css", ".scss", ".sh", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".php", ".cs", ".cpp", ".c", ".h", ".hpp", ".toml", ".yaml", ".yml"]);

// `options` (fully optional so every existing call site keeps working unchanged):
//   - cohortFilter: a normalized (or raw, pre-normalization) cohort filter object (telemetry-cohort.mjs).
//     Applied on top of `events` before every downstream computation, so cohort-scoped callers (the
//     portal's Analysis explorer, a future CLI --filter flag) get one filtered event set feeding every
//     panel — same principle the existing time/harness window already followed for /api/data.
//   - markers: the marker timeline, needed for outcome-aware metrics and marker-relative comparison.
//   - markerId: when set (and found in `markers`), triggers a marker-relative comparison for
//     `compareMetric` (default "tokens.total") and demotes the existing midpoint regression() to a
//     labeled exploratory fallback in the report.
//   - compareMetric: metric id for the marker-relative comparison (only used when markerId is set).
export function analyzeTelemetry(events, options = {}) {
  const { cohortFilter = null, markers = [], repositoryHashIndex = null } = options;
  const normalizedFilter = cohortFilter ? normalizeCohortFilter(cohortFilter) : null;
  const scopedEvents = normalizedFilter ? applyCohortFilter(events, normalizedFilter, { markers, repositoryHashIndex }) : events;
  // One representative row per operation, so mirrored captures never double-count.
  const observations = normalizeObservations(scopedEvents, { repositoryHashIndex });
  const report = analyzeRows(canonicalFlowRows(observations), scopedEvents, events, normalizedFilter, options);
  report.conditions = buildConditionsReport(scopedEvents, report, options, observations);
  for (const [key, kind] of [["spikes", "spike"], ["loops", "loop"], ["read_warnings", "read-warning"]]) {
    for (const finding of report[key]) finding.condition_context = report.conditions.ledger.find((row) => row.kind === kind && row.session_id === finding.session_id && row.harness === finding.harness)?.context ?? null;
  }
  report.version += ":" + createHash("sha256").update(JSON.stringify(report.conditions)).digest("hex").slice(0, 16);
  return report;
}

function analyzeRows(rows, scopedEvents, events, normalizedFilter, { markers = [], markerId = null, compareMetric = "tokens.total" }) {
  const scopedIndex = indexScopedEvents(rows);
  const captures = scopedIndex.captures;
  const captureIndex = indexCaptures(captures);
  const sessions = rollupSessions(captures);
  const spikeThreshold = deltaSpikeThreshold(captures);
  const spikeCaptures = captures.filter((event) => (event.delta_tokens || 0) >= spikeThreshold && spikeThreshold > 0);
  // Waste ledger: loops and reads nominate their turns from inside detectLoops/readWarnings below;
  // spike excess and testing are nominated here. Each turn is counted once (see telemetry-waste.mjs).
  const wasteLedger = createWasteLedger();
  for (const event of spikeCaptures) wasteLedger.add(event, "spikes", (event.delta_tokens || 0) - spikeThreshold);
  // Over-testing is only the redundant part of testing: a full-suite rerun with no edit since the
  // previous test run (same definition as test.full_suite_without_intervening_edit).
  for (const event of captures) {
    if (isFullSuite(event) && event.intervening?.edit_since_last_test === false) wasteLedger.add(event, "testing", event.delta_tokens || 0);
  }
  // Session-context lookup so every flagged event (spike, loop) can carry the same "which chat was
  // this" markers the sessions table shows — title (first prompt), activity summary, repo/branch.
  const sessionsById = new Map(sessions.map((s) => [sessionKeyOf(s), s]));
  // Deduplicate spikes: show only the worst spike per session, with count so the user sees how
  // many turns exceeded the threshold without seeing the same session repeated on every row.
  const spikeCountBySess = new Map();
  for (const event of spikeCaptures) {
    const id = sessionKeyOf(event);
    spikeCountBySess.set(id, (spikeCountBySess.get(id) || 0) + 1);
  }
  const bestSpikeBySess = new Map();
  for (const event of spikeCaptures) {
    const id = sessionKeyOf(event);
    if (!bestSpikeBySess.has(id) || (event.delta_tokens || 0) > (bestSpikeBySess.get(id)?.delta_tokens ?? 0)) {
      bestSpikeBySess.set(id, event);
    }
  }
  const report = {
    // Cheap change token for the dashboard's poll loop: spool is append-only, so event count plus the
    // newest timestamp changes whenever a capture lands. The client redraws only when this differs.
    // Cohort-scoped so a filter change is always reflected, matching the existing time/harness window
    // behavior this token already covered.
    version: `${scopedEvents.length}:${scopedEvents[scopedEvents.length - 1]?.ts ?? "0"}`,
    event_count: scopedEvents.length,
    capture_count: captures.length,
    sessions,
    spike_threshold: spikeThreshold,
    // One row per session (worst spike), with spike_count showing how many turns crossed the threshold.
    spikes: [...bestSpikeBySess.values()]
      .map((event) => ({ ...spikeRow(event, sessionsById), spike_count: spikeCountBySess.get(sessionKeyOf(event)) || 1 }))
      .sort((a, b) => b.delta_tokens - a.delta_tokens),
    // Also expose harnesses present in the data so the dashboard can render a filter.
    harnesses: scopedIndex.harnesses,
    // Computed concern threshold for the cumulative chart: 2× the 90th-percentile session total,
    // floored at 10M so it is always a visible limit even in low-activity installs.
    cumulative_concern: computeCumulativeConcern(sessions),
    top_repos: rankedTop(captureIndex.topRepos),
    top_tools: rankedTop(captureIndex.topTools),
    top_mcp: rankedTop(captureIndex.topMcp),
    top_events: rankedTop(captureIndex.topEvents),
    comparison: compareSpikeVsNormal(captures, spikeThreshold),
    // The actionable view: every spike tagged with the pattern that drove it, then rolled up so the
    // user sees "doing X blows up my tokens" rather than a wall of per-capture numbers.
    spike_causes: rollupCauses(spikeCaptures),
    usage_windows: usageWindows(captures, captureIndex.latestTs),
    codex_provider_rate_limits: captureIndex.latestCodexRateLimits,
    // Per-capture series for the timeline chart. Carries the context the dashboard tooltip needs
    // (tool, event, cause, sizes, duration) so hover can explain a bar without a second request.
    timeline: captureIndex.timeline,
    // --- conclusions: actionable rollups, not raw rows -------------------------------------------
    // Attribution note: per-tool cost is measured by the SIZE of the result a tool put into context
    // (last_result.chars → approx tokens), NOT by delta_tokens-by-hook (which mis-credits whichever
    // hook fired). This answers "what does a Read/Grep/MCP call put into my context".
    tool_cost: toolCost(captures),
    group_cost: groupCost(captures),
    spike_anatomy: spikeAnatomy(captures, spikeCaptures),
    package_cost: packageCost(captures),
    // Midpoint regression is a labeled EXPLORATORY fallback when no marker is selected —
    // marker_comparison below is the
    // PREFERRED path once a change marker exists to compare across. regression() itself is untouched.
    regression: { ...regression(captures), exploratory: true, label: "midpoint (exploratory — not tied to any specific change)" },
    loops: detectLoops(captures, sessionsById, wasteLedger),
    data_quality_warnings: dataQualityWarnings(scopedEvents),
    read_warnings: readWarnings(rows, sessionsById, wasteLedger),
    // Testing-efficiency summary, computed from the same
    // metrics registry the CLI report and portal both read — see telemetry-metrics.mjs.
    testing_efficiency: testingEfficiencySummary(captures),
    // Identifiable waste, per turn and counted once — built after loops/read_warnings ran above so
    // their nominations are in the ledger. Filled in just below (object literal order matters).
    waste: null,
    // Cohort context so a filtered response can describe itself and its sample size.
    cohort: normalizedFilter
      ? { filter: normalizedFilter, summary: describeCohortFilter(normalizedFilter), active_filter_count: activeFilterCount(normalizedFilter) }
      : null,
  };
  report.waste = wasteLedger.summarize(captureIndex.latestTs);
  // Marker-relative comparison (the preferred path) — only computed when the caller selected a
  // marker. Uses the FULL (pre-cohort-filter) event set so the marker's own before/after split isn't
  // additionally restricted by the same filter that might have selected this marker's sessions; a
  // caller wanting both should pass a marker whose surrounding sessions remain visible in `events`.
  const marker = markerId ? markers.find((m) => m.marker_id === markerId) : null;
  if (marker) {
    const comparison = compareAcrossMarker(events.filter(hasTokens), marker, compareMetric, { markers });
    report.marker_comparison = describeMarkerComparison(comparison, marker);
  } else {
    report.marker_comparison = null;
  }
  // Ranked plain-English conclusions derived from the facts above — the "what this means" headline.
  report.insights = deriveInsights(report);
  return report;
}

// Plan: "Derived testing findings" — full-suite runs per session/debugging phase, redundant reruns,
// testing share of tool time, targeted-to-full ratio, and the token cost of testing activity. Reads
// straight from the metrics registry so the CLI report and portal never diverge on the formula.
function testingEfficiencySummary(captures) {
  const metricIds = [
    "test.full_suite_calls_per_session",
    "test.full_suite_calls_per_testing_session",
    "test.full_suite_calls_per_debug_phase",
    "test.full_suite_without_intervening_edit",
    "test.full_suite_unchanged_failure_signature",
    "test.targeted_to_full_ratio",
    "test.share_of_tool_time",
    "test.token_share",
    "test.time_failure_to_targeted_repro_ms",
    "test.time_first_failure_to_verification_ms",
    "test.finalization_full_suite_count",
    "test.tokens_during_testing",
  ];
  const summary = {};
  for (const id of metricIds) summary[id] = computeMetric(id, captures);
  return summary;
}

function indexScopedEvents(scopedEvents) {
  const harnesses = new Set();
  const captures = [];
  for (const event of scopedEvents) {
    if (event.harness) harnesses.add(event.harness);
    if (hasTokens(event)) captures.push(event);
  }
  return { captures, harnesses: [...harnesses].sort() };
}

function indexCaptures(captures) {
  const index = {
    latestTs: captures[0]?.ts ?? new Date().toISOString(),
    latestCodexRateLimits: null,
    timeline: [],
    topRepos: new Map(),
    topTools: new Map(),
    topMcp: new Map(),
    topEvents: new Map(),
  };
  for (const event of captures) {
    if (event.ts > index.latestTs) index.latestTs = event.ts;
    if (hasRateLimitsCapability(event.harness) && event.details?.codex_rate_limits) index.latestCodexRateLimits = event.details.codex_rate_limits;
    countTop(index.topRepos, event.repo?.label ?? "unknown", event.delta_tokens || 0);
    countTop(index.topTools, event.tool?.name ?? event.event ?? "unknown", event.delta_tokens || 0);
    if (event.tool?.is_mcp) countTop(index.topMcp, event.tool?.mcp_server ?? "unknown", event.delta_tokens || 0);
    countTop(index.topEvents, event.event ?? "unknown", event.delta_tokens || 0);
    index.timeline.push({
      ts: event.ts,
      total: event.tokens?.total ?? 0,
      delta: event.delta_tokens ?? 0,
      event: event.event ?? null,
      tool: event.tool?.name ?? null,
      mcp_tool: event.tool?.mcp_tool ?? null,
      file_ext: event.tool?.file_ext ?? null,
      duration_ms: event.duration_ms ?? null,
      repo: event.repo?.label ?? "unknown",
      session_id: event.session_id ?? null,
      result_chars: event.last_result?.chars ?? null,
      prompt: event.prompt?.preview ?? null,
      cause: spikeCause(event).cause,
      // Functional group, computed server-side (with bare-MCP-name resolution) so the
      // cumulative-by-group chart doesn't re-derive it client-side and diverge.
      group: toolGroup(event.last_result?.tool ?? event.tool?.name ?? null),
    });
  }
  index.timeline.sort((a, b) => a.ts.localeCompare(b.ts));
  return index;
}

function countTop(counts, key, tokens) {
  const current = counts.get(key) ?? { key, captures: 0, tokens: 0 };
  current.captures += 1;
  current.tokens += tokens;
  counts.set(key, current);
}

function rankedTop(counts) {
  return [...counts.values()].sort((a, b) => b.tokens - a.tokens || b.captures - a.captures);
}

// A tool result this many characters or larger is treated as the likely cause of a spike. ~1 token
// per 4 chars, so 40k chars ≈ 10k tokens of context — well above an incidental small result.
const HEAVY_RESULT_CHARS = 40_000;

// Classifies one spike capture into a cause bucket and the actionable change it implies. Keys off
// the size of the tool result that most recently entered context (the likely driver of the delta);
// degrades to tool name for older records that predate result-size capture, so pre-attribution
// captures still classify (just without the size gate). Deliberately conservative: anything we can't
// attribute to a concrete oversized result falls through to "other" rather than guessing — a wrong
// cause is worse than an honest "look at the transcript".
export function spikeCause(event) {
  const result = event.last_result ?? null;
  const tool = result?.tool ?? event.tool?.name ?? null;
  const chars = result?.chars ?? 0;
  // hasSizes distinguishes "small result, not the cause" from "old record with no size data".
  const hasSizes = result != null && typeof result.chars === "number";
  const heavy = chars >= HEAVY_RESULT_CHARS || (!hasSizes && tool);
  const isMcp = event.tool?.is_mcp === true || (typeof tool === "string" && tool.startsWith("mcp__"));

  if (heavy) {
    if (isMcp) return { cause: "mcp-bundle", hint: "scope the MCP query (narrower bundle / fewer refs)" };
    if (tool === "Bash") return { cause: "unbounded-bash-output", hint: "pipe through `roborepo run` or limit output" };
    if (tool === "Read" || tool === "Grep" || tool === "Glob") return { cause: "large-file-read", hint: "read a line range, not the whole file" };
    if (tool) return { cause: "large-tool-output", hint: `limit what ${tool} returns into context` };
  }
  if ((event.prompt?.chars ?? 0) >= 8_000) {
    return { cause: "big-prompt", hint: "trim pasted context from the prompt" };
  }
  // Delta is large but no oversized result or prompt: context is accumulating across many turns.
  // Check the transcript to see which earlier turns are still inflating the window.
  return { cause: "context-accumulation", hint: "context growing through many turns — use /compact or start a fresh session" };
}

function rollupCauses(spikeCaptures) {
  const byCause = new Map();
  for (const event of spikeCaptures) {
    const { cause, hint } = spikeCause(event);
    const delta = event.delta_tokens ?? 0;
    const current = byCause.get(cause) ?? { cause, hint, spikes: 0, total_delta: 0, worst_delta: 0, worst_repo: null };
    current.spikes += 1;
    current.total_delta += delta;
    if (delta > current.worst_delta) {
      current.worst_delta = delta;
      current.worst_repo = event.repo?.label ?? "unknown";
    }
    byCause.set(cause, current);
  }
  return [...byCause.values()]
    .map((row) => ({ ...row, avg_delta: Math.round(row.total_delta / row.spikes) }))
    .sort((a, b) => b.total_delta - a.total_delta);
}

// Rolling token consumption over trailing 5h / 7d windows, reconstructed from capture timestamps and
// per-capture deltas. This is a LOCAL ESTIMATE of how much you've spent recently — not your real
// server-side Claude rate limit, which telemetry cannot see. Useful for spotting that you're
// trending toward a wall before you hit it.
function usageWindows(captures, now = captures[0]?.ts ?? new Date().toISOString()) {
  const nowMs = Date.parse(now);
  const sumSince = (windowMs) =>
    captures.reduce((sum, event) => (nowMs - Date.parse(event.ts) <= windowMs ? sum + (event.delta_tokens ?? 0) : sum), 0);
  return {
    as_of: now,
    estimate: true,
    five_hour: sumSince(5 * 60 * 60 * 1000),
    seven_day: sumSince(7 * 24 * 60 * 60 * 1000),
  };
}

function rollupSessions(captures) {
  const bySession = new Map();
  for (const event of captures) {
    const id = sessionKeyOf(event);
    const current = bySession.get(id) ?? {
      session_id: event.session_id || "unknown",
      repo: event.repo?.label ?? "unknown",
      harness: event.harness,
      branch: event.repo?.branch ?? null,
      sha: event.repo?.sha ?? null,
      first_ts: event.ts,
      last_ts: event.ts,
      total_tokens: 0,
      tool_calls: 0,
      mcp_calls: 0,
      captures: 0,
      // Human-readable identity: the session's opening prompt (preview), plus a tool-use tally and
      // the file types touched, so a session reads as "what it was about" not just a UUID.
      title: null,
      title_ts: null,
      tool_counts: {},
      ext_counts: {},
    };
    current.first_ts = minStr(current.first_ts, event.ts);
    current.last_ts = maxStr(current.last_ts, event.ts);
    // Branch/sha can change mid-session (checkout); keep the most recent non-null.
    if (event.repo?.branch) current.branch = event.repo.branch;
    if (event.repo?.sha) current.sha = event.repo.sha;
    current.total_tokens = Math.max(current.total_tokens, event.tokens?.total ?? 0);
    current.tool_calls = Math.max(current.tool_calls, event.session?.tool_calls ?? 0);
    current.mcp_calls = Math.max(current.mcp_calls, event.session?.mcp_calls ?? 0);
    current.captures += 1;
    // Title = the earliest prompt preview seen for the session (the opening ask).
    const preview = event.prompt?.preview ?? null;
    if (preview && (current.title_ts == null || event.ts < current.title_ts)) {
      current.title = preview;
      current.title_ts = event.ts;
    }
    // Activity tallies, keyed off PostToolUse so each tool call counts once.
    if (event.event === "PostToolUse" && event.tool?.name) {
      const t = event.tool.mcp_tool || event.tool.name;
      current.tool_counts[t] = (current.tool_counts[t] || 0) + 1;
      if (event.tool.file_ext) current.ext_counts[event.tool.file_ext] = (current.ext_counts[event.tool.file_ext] || 0) + 1;
    }
    bySession.set(id, current);
  }
  // Derive a one-line activity summary per session from the tallies.
  for (const s of bySession.values()) s.activity = activitySummary(s.tool_counts, s.ext_counts);
  return [...bySession.values()].sort((a, b) => b.total_tokens - a.total_tokens);
}

// "12 Read · 6 Write · 3 Bash · mostly .mjs, .json" — a compact, content-free description of what a
// session actually did, for sessions with no prompt preview (or as a subtitle for those that have).
function activitySummary(toolCounts, extCounts) {
  const tools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => n + " " + k);
  const exts = Object.entries(extCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => "." + k);
  const parts = [];
  if (tools.length) parts.push(tools.join(" · "));
  if (exts.length) parts.push("mostly " + exts.join(", "));
  return parts.join(" · ") || null;
}

function deltaSpikeThreshold(captures) {
  const deltas = captures.map((event) => event.delta_tokens || 0).filter((value) => value > 0);
  if (deltas.length < 2) return MIN_SPIKE_THRESHOLD;
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const variance = deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / deltas.length;
  return Math.max(MIN_SPIKE_THRESHOLD, Math.round(mean + SPIKE_SIGMA * Math.sqrt(variance)));
}

function computeCumulativeConcern(sessions) {
  if (!sessions.length) return 20_000_000;
  const totals = sessions.map((s) => s.total_tokens).filter((t) => t > 0).sort((a, b) => a - b);
  if (!totals.length) return 20_000_000;
  const p90 = totals[Math.floor(totals.length * 0.9)] ?? totals[totals.length - 1];
  return Math.max(10_000_000, Math.round(p90 * 2));
}

function compareSpikeVsNormal(captures, threshold) {
  const spike = captures.filter((event) => (event.delta_tokens || 0) >= threshold && threshold > 0);
  const normal = captures.filter((event) => (event.delta_tokens || 0) < threshold);
  return {
    spike: cohortStats(spike),
    normal: cohortStats(normal),
  };
}

function cohortStats(cohort) {
  if (cohort.length === 0) return { count: 0, avg_delta: 0, avg_tool_calls: 0, mcp_rate: 0 };
  const sum = (pick) => cohort.reduce((total, event) => total + pick(event), 0);
  const mcpEvents = cohort.filter((event) => event.tool?.is_mcp).length;
  return {
    count: cohort.length,
    avg_delta: Math.round(sum((event) => event.delta_tokens || 0) / cohort.length),
    avg_tool_calls: Math.round(sum((event) => event.session?.tool_calls || 0) / cohort.length),
    mcp_rate: Number((mcpEvents / cohort.length).toFixed(3)),
  };
}

function spikeRow(event, sessionsById) {
  const { cause, hint } = spikeCause(event);
  return {
    ts: event.ts,
    session_id: event.session_id,
    repo: event.repo?.label ?? "unknown",
    event: event.event,
    tool: event.tool?.name ?? null,
    delta_tokens: event.delta_tokens || 0,
    total_tokens: event.tokens?.total ?? 0,
    harness: event.harness ?? null,
    cause,
    hint,
    context: sessionContext(event, sessionsById),
  };
}

// The "which chat was this" markers, pulled from the session rollup so every flagged event speaks
// the same language as the sessions table: opening prompt, activity summary, repo/branch/harness.
function sessionContext(event, sessionsById) {
  const s = sessionsById?.get(sessionKeyOf(event));
  if (!s) return null;
  return { title: s.title ?? null, activity: s.activity ?? null, repo: s.repo, branch: s.branch ?? null, harness: s.harness ?? null };
}

// =================================================================================================
// Conclusions layer. All keyed off the SIZE of the result each tool put into context
// (last_result.chars), converted to approximate tokens. This is the honest "what did this tool cost
// my context" signal — independent of the delta-by-hook attribution used for the timeline.
// =================================================================================================

// ~4 characters per token. Approximate by design; labeled as such everywhere it surfaces.
function approxTokens(chars) {
  return Math.round((chars || 0) / 4);
}

// The display name a result attributes to. Transcript results carry the raw tool name; for MCP that
// is mcp__<server>__<tool>, which we render as "<server> · <tool>".
function resultToolLabel(toolName) {
  const server = mcpServerOf(toolName);
  if (!server) return toolName;
  const tool = String(toolName).split("__").slice(2).join("__");
  return tool ? server + " · " + tool : server;
}

// Functional bucket for the native-vs-MCP comparison. Keyed off the result's tool name so it works
// for both the live tool metadata and the transcript-attributed result.
function toolGroup(toolName) {
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

// Captures that carry an attributed result (the tool that produced it + its size). The basis for
// every cost rollup below.
function resultCaptures(captures) {
  return captures.filter((event) => event.last_result && typeof event.last_result.chars === "number" && event.last_result.tool);
}

// Per-tool cost: how much context an average call of each tool drops in. The Read-vs-MCP table.
function toolCost(captures) {
  const byTool = new Map();
  for (const event of resultCaptures(captures)) {
    const name = event.last_result.tool;
    const chars = event.last_result.chars;
    const cur = byTool.get(name) ?? { tool: resultToolLabel(name), group: toolGroup(name), calls: 0, total_chars: 0, max_chars: 0 };
    cur.calls += 1;
    cur.total_chars += chars;
    cur.max_chars = Math.max(cur.max_chars, chars);
    byTool.set(name, cur);
  }
  return [...byTool.values()]
    .map((r) => ({ tool: r.tool, group: r.group, calls: r.calls, avg_tokens: approxTokens(r.total_chars / r.calls), max_tokens: approxTokens(r.max_chars), total_tokens: approxTokens(r.total_chars) }))
    .sort((a, b) => b.avg_tokens - a.avg_tokens);
}

// Per functional group: the head-to-head (native-read vs mcp-code vs …) on avg tokens per call.
// Also tracks calls per session to make high-call-count groups comparable to high-avg groups.
function groupCost(captures) {
  const byGroup = new Map();
  const groupSessions = new Map();
  const totalSessions = new Set(captures.filter((e) => e.session_id).map(sessionKeyOf)).size || 1;
  for (const event of resultCaptures(captures)) {
    const g = toolGroup(event.last_result.tool);
    const cur = byGroup.get(g) ?? { group: g, calls: 0, total_chars: 0 };
    cur.calls += 1;
    cur.total_chars += event.last_result.chars;
    byGroup.set(g, cur);
    if (!groupSessions.has(g)) groupSessions.set(g, new Set());
    if (event.session_id) groupSessions.get(g).add(sessionKeyOf(event));
  }
  return [...byGroup.values()]
    .map((r) => {
      const sessions = (groupSessions.get(r.group) || new Set()).size || 1;
      return {
        group: r.group,
        calls: r.calls,
        avg_tokens: approxTokens(r.total_chars / r.calls),
        total_tokens: approxTokens(r.total_chars),
        calls_per_session: Math.round(r.calls / sessions),
      };
    })
    // Attach each group's SHARE of all attributed tool tokens, then sort by share (not avg) —
    // share answers "where does my context budget go", avg-per-call is the secondary detail.
    .map((row, _i, all) => {
      const total = all.reduce((s, g) => s + g.total_tokens, 0);
      return { ...row, total_tokens: row.total_tokens, share_of_tokens: total > 0 ? row.total_tokens / total : 0 };
    })
    .sort((a, b) => b.total_tokens - a.total_tokens);
}

// What is over-represented in spikes vs normal turns. Lift = group's share of spike captures ÷ its
// share of normal captures. Lift > 1 means that group drives spikes more than its baseline rate.
function spikeAnatomy(captures, spikeCaptures) {
  const spikeSet = new Set(spikeCaptures);
  const spike = resultCaptures(spikeCaptures);
  const normal = resultCaptures(captures).filter((event) => !spikeSet.has(event));
  if (spike.length === 0) return { spike_count: 0, normal_count: normal.length, groups: [] };
  const shareByGroup = (rows) => {
    const m = new Map();
    for (const e of rows) m.set(toolGroup(e.last_result.tool), (m.get(toolGroup(e.last_result.tool)) || 0) + 1);
    return m;
  };
  const spikeShare = shareByGroup(spike);
  const normalShare = shareByGroup(normal);
  const groups = [];
  for (const [group, n] of spikeShare) {
    const sFrac = n / spike.length;
    const nFrac = (normalShare.get(group) || 0) / Math.max(1, normal.length);
    const avgChars = spike.filter((e) => toolGroup(e.last_result.tool) === group).reduce((s, e) => s + e.last_result.chars, 0) / n;
    groups.push({
      group,
      spike_share: Number(sFrac.toFixed(3)),
      normal_share: Number(nFrac.toFixed(3)),
      lift: nFrac > 0 ? Number((sFrac / nFrac).toFixed(2)) : null, // null = appears in spikes but never normally
      avg_tokens: approxTokens(avgChars),
    });
  }
  groups.sort((a, b) => (b.lift ?? Infinity) - (a.lift ?? Infinity));
  return { spike_count: spike.length, normal_count: normal.length, groups };
}

// Per package (MCP server, plus a synthetic "native" bucket): calls, avg tokens/call, total, and the
// time span it was seen. Answers "what is this package costing me".
function packageCost(captures) {
  const byPkg = new Map();
  for (const event of resultCaptures(captures)) {
    const pkg = mcpServerOf(event.last_result.tool) || "native";
    const cur = byPkg.get(pkg) ?? { package: pkg, calls: 0, total_chars: 0, first_seen: event.ts, last_seen: event.ts };
    cur.calls += 1;
    cur.total_chars += event.last_result.chars;
    cur.first_seen = minStr(cur.first_seen, event.ts);
    cur.last_seen = maxStr(cur.last_seen, event.ts);
    byPkg.set(pkg, cur);
  }
  return [...byPkg.values()]
    .map((r) => ({ package: r.package, calls: r.calls, avg_tokens: approxTokens(r.total_chars / r.calls), total_tokens: approxTokens(r.total_chars), first_seen: r.first_seen, last_seen: r.last_seen }))
    .sort((a, b) => b.total_tokens - a.total_tokens);
}

// Earlier-vs-later regression: split result captures at the time midpoint and compare avg tokens per
// call per group. A positive delta means that group got more expensive in the later half — the
// signal for "did the thing I changed make context heavier".
function regression(captures) {
  const rows = resultCaptures(captures).slice().sort((a, b) => a.ts.localeCompare(b.ts));
  if (rows.length < 4) return { split_ts: null, groups: [] };
  const mid = Math.floor(rows.length / 2);
  const splitTs = rows[mid].ts;
  const avgByGroup = (slice) => {
    const m = new Map();
    for (const e of slice) {
      const g = toolGroup(e.last_result.tool);
      const cur = m.get(g) ?? { calls: 0, chars: 0 };
      cur.calls += 1;
      cur.chars += e.last_result.chars;
      m.set(g, cur);
    }
    return m;
  };
  const before = avgByGroup(rows.slice(0, mid));
  const after = avgByGroup(rows.slice(mid));
  // Total result tokens per half — the denominator for each group's SHARE of tool tokens.
  // Share (not raw delta) is the comparable unit: a group can only gain share by growing
  // relative to everything else, which is the actual "got more expensive" question.
  const halfTotal = (slice) => slice.reduce((s, e) => s + (e.last_result.chars || 0), 0);
  const totalBefore = halfTotal(rows.slice(0, mid));
  const totalAfter = halfTotal(rows.slice(mid));
  // This-week share: same formula, trailing-7-day window — the third column the table shows,
  // aligned with the waste cards' week window.
  const latestTs = rows[rows.length - 1].ts;
  const weekCutoff = new Date(Date.parse(latestTs) - 7 * 86400000).toISOString();
  const weekRows = rows.filter((e) => e.ts >= weekCutoff);
  const weekAgg = avgByGroup(weekRows);
  const totalWeek = halfTotal(weekRows);
  const groups = [];
  for (const g of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(g), a = after.get(g);
    const bAvg = b ? approxTokens(b.chars / b.calls) : 0;
    const aAvg = a ? approxTokens(a.chars / a.calls) : 0;
    const bChars = b?.chars ?? 0;
    const aChars = a?.chars ?? 0;
    groups.push({
      group: g,
      before_avg_tokens: bAvg,
      after_avg_tokens: aAvg,
      delta_tokens: aAvg - bAvg,
      before_calls: b?.calls ?? 0,
      after_calls: a?.calls ?? 0,
      // Share of all tool tokens (result chars) in each window, as 0..1 fractions. A group absent
      // from a window has share 0 there. These feed the % primary display and the trend framing.
      before_share: totalBefore > 0 ? bChars / totalBefore : 0,
      after_share: totalAfter > 0 ? aChars / totalAfter : 0,
      week_share: totalWeek > 0 ? (weekAgg.get(g)?.chars ?? 0) / totalWeek : 0,
    });
  }
  groups.sort((a, b) => Math.abs(b.after_share - b.before_share) - Math.abs(a.after_share - a.before_share));
  return { split_ts: splitTs, groups };
}

// Runaway detection: per session, the longest run of the SAME tool fired consecutively (from the
// ordered PostToolUse captures). A long run is the "this skill went off on endless lookups" signal.
const LOOP_REPEAT_THRESHOLD = 8;
function detectLoops(captures, sessionsById, ledger) {
  const bySession = new Map();
  for (const event of captures) {
    if (event.event !== "PostToolUse" || !event.tool?.name) continue;
    const id = sessionKeyOf(event);
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(event);
  }
  const loops = [];
  for (const events of bySession.values()) {
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    let runTool = null, run = 0, bestTool = null, best = 0, bestStartTs = null, runStartTs = null;
    // Wasted tokens for a run = every repeat turn's delta beyond the first (the first call did
    // the work; each consecutive repeat re-spent tokens for the same answer).
    let runWasted = 0, bestWasted = 0;
    let runRepeats = [], bestRepeats = [];
    for (const e of events) {
      const t = e.tool.mcp_tool || e.tool.name;
      if (t === runTool) { run += 1; runWasted += e.delta_tokens || 0; runRepeats.push(e); }
      else { runTool = t; run = 1; runStartTs = e.ts; runWasted = 0; runRepeats = []; }
      if (run > best) { best = run; bestTool = t; bestStartTs = runStartTs; bestWasted = runWasted; bestRepeats = runRepeats.slice(); }
    }
    if (best >= LOOP_REPEAT_THRESHOLD) {
      for (const e of bestRepeats) ledger.add(e, "loops", e.delta_tokens || 0);
      loops.push({
        session_id: events[0].session_id || "unknown",
        repo: events[0].repo?.label ?? "unknown",
        harness: events[0].harness ?? null,
        tool: bestTool,
        max_repeat: best,
        ts: bestStartTs,
        wasted_tokens: bestWasted,
        hint: mcpServerOf(events.find((e) => (e.tool.mcp_tool || e.tool.name) === bestTool)?.tool?.name)
          ? "MCP tool firing in a tight loop — check the agent/skill that calls it"
          : bestTool + " repeated " + best + "× in a row — likely a runaway loop",
        context: sessionContext(events[0], sessionsById),
      });
    }
  }
  return loops.sort((a, b) => b.max_repeat - a.max_repeat);
}

function dataQualityWarnings(events) {
  const warnings = [];
  const byHarness = new Map();
  for (const event of events) {
    const harness = event.harness || "unknown";
    const cur = byHarness.get(harness) || { events: 0, tokenRecords: 0, nonzeroTokenRecords: 0, unsupported: 0, rateLimited: 0 };
    cur.events += 1;
    if (hasTokens(event)) {
      cur.tokenRecords += 1;
      if ((event.tokens?.total || 0) > 0) cur.nonzeroTokenRecords += 1;
    }
    if (event.details?.unsupported_usage_seen) cur.unsupported += 1;
    if (hasRateLimitsCapability(harness) && event.details?.codex_rate_limits) cur.rateLimited += 1;
    byHarness.set(harness, cur);
  }
  for (const [harness, cur] of byHarness) {
    if (cur.events > 0 && cur.nonzeroTokenRecords === 0) {
      warnings.push({
        type: "missing_token_data",
        harness,
        events: cur.events,
        token_records: cur.tokenRecords,
        hint: "events exist but no nonzero token records were parsed",
      });
    }
    if (cur.unsupported > 0) {
      warnings.push({
        type: "unsupported_usage_schema",
        harness,
        events: cur.unsupported,
        hint: "transcript usage records were present but not in a supported schema",
      });
    }
    if (hasRateLimitsCapability(harness) && cur.nonzeroTokenRecords > 0 && cur.rateLimited === 0) {
      warnings.push({
        type: "rate_limit_unavailable",
        harness,
        events: cur.nonzeroTokenRecords,
        hint: "Codex token data present but no provider rate-limit records were captured",
      });
    }
  }
  return warnings;
}

function readWarnings(events, sessionsById, ledger) {
  const warnings = [];
  const byDoc = new Map();
  const bySession = new Map();
  for (const event of events) {
    const id = sessionKeyOf(event);
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(event);
    const result = event.last_result;
    const fileHash = event.tool?.file_path_hash;
    const ext = event.tool?.file_ext;
    if (event.event === "PostToolUse" && result?.chars >= LARGE_DOCUMENT_READ_CHARS && DOC_EXTS.has(ext)) {
      ledger.add(event, "reads", approxTokens(result.chars));
      warnings.push(readWarningRow("large_document_read", event, sessionsById, {
        file_ext: ext,
        file_path_hash: fileHash,
        read_count: 1,
        result_chars: result.chars,
        approx_tokens: approxTokens(result.chars),
        hint: "large document read — prefer a section-level lookup over loading the whole file",
      }));
    }
    if (event.event === "PostToolUse" && fileHash && DOC_EXTS.has(ext)) {
      const key = `${id}:${fileHash}`;
      const cur = byDoc.get(key) || { event, count: 0, chars: 0, rereads: [] };
      cur.count += 1;
      cur.chars += result?.chars || 0;
      // Re-reads (every read after the first) are the redundant part of a repeated read.
      if (cur.count > 1) cur.rereads.push(event);
      byDoc.set(key, cur);
    }
  }
  for (const cur of byDoc.values()) {
    if (cur.count >= REPEATED_DOCUMENT_READ_COUNT && cur.chars >= LARGE_DOCUMENT_READ_CHARS) {
      for (const event of cur.rereads) ledger.add(event, "reads", approxTokens(event.last_result?.chars || 0));
      warnings.push(readWarningRow("repeated_document_read", cur.event, sessionsById, {
        file_ext: cur.event.tool?.file_ext,
        file_path_hash: cur.event.tool?.file_path_hash,
        read_count: cur.count,
        result_chars: cur.chars,
        approx_tokens: approxTokens(cur.chars),
        hint: "same document read repeatedly — reuse the earlier result or look up only the needed section",
      }));
    }
  }
  for (const sessionEvents of bySession.values()) {
    const repeatedDocs = warnings.filter((warning) => warning.type === "repeated_document_read" && sessionKeyOf(warning) === sessionKeyOf(sessionEvents[0])).length;
    const jdocCalls = sessionEvents.filter((event) => mcpServerOf(event.last_result?.tool || event.tool?.name) === "jdocmunch").length;
    if (repeatedDocs > 0 && jdocCalls === 0) {
      warnings.push(readWarningRow("stale_doc_lookup", sessionEvents[0], sessionsById, {
        read_count: repeatedDocs,
        jdocmunch_calls: jdocCalls,
        hint: "docs were read repeatedly with no doc-index lookups observed",
      }));
    }
    const jcodeCalls = sessionEvents.filter((event) => mcpServerOf(event.last_result?.tool || event.tool?.name) === "jcodemunch").length;
    const nativeSourceReads = sessionEvents.filter((event) => isNativeSourceRead(event)).length;
    if (jcodeCalls > 0 && nativeSourceReads >= MIXED_CODE_LOOKUP_NATIVE_READS) {
      warnings.push(readWarningRow("mixed_code_lookup", sessionEvents[0], sessionsById, {
        read_count: nativeSourceReads,
        jcodemunch_calls: jcodeCalls,
        hint: "jcodemunch was used but many native source reads still occurred",
      }));
    }
  }
  return warnings.filter(Boolean).sort((a, b) => (b.result_chars || 0) - (a.result_chars || 0));
}

function readWarningRow(type, event, sessionsById, extra) {
  const sessionId = event.session_id || "unknown";
  return {
    type,
    session_id: sessionId,
    session_short_id: sessionId.slice(0, 8),
    harness: event.harness || null,
    repo: event.repo?.label || "unknown",
    ts: event.ts,
    context: sessionContext(event, sessionsById),
    ...extra,
  };
}

function isNativeSourceRead(event) {
  const toolName = event.tool?.name || event.last_result?.tool;
  if (toolName !== "Read" && toolName !== "Grep" && toolName !== "Glob" && toolName !== "Bash") return false;
  if (SOURCE_EXTS.has(event.tool?.file_ext)) return true;
  return toolName === "Bash" && (event.tool?.command_chars || 0) > 0 && (event.last_result?.chars || 0) > 0;
}

function hasTokens(event) {
  return event && event.tokens && typeof event.tokens.total === "number";
}

// Provider session ids are only unique within a harness; every per-session rollup keys on both.
function sessionKeyOf(event) {
  return JSON.stringify([event.harness ?? null, event.session_id || "unknown"]);
}

const minStr = (a, b) => (a <= b ? a : b);
const maxStr = (a, b) => (a >= b ? a : b);
