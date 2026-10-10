import { sessionContext } from "./sessions.mjs";
import { resultCaptures, toolGroup, approxTokens } from "./results.mjs";
import { SPIKE_SIGMA, MIN_SPIKE_THRESHOLD, HEAVY_RESULT_CHARS } from "./policy.mjs";
// Thresholds and result attribution explain spikes; unsupported attribution stays conservative.
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

export function rollupCauses(spikeCaptures) {
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

export function deltaSpikeThreshold(captures) {
  const deltas = captures.map((event) => event.delta_tokens || 0).filter((value) => value > 0);
  if (deltas.length < 2) return MIN_SPIKE_THRESHOLD;
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const variance = deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / deltas.length;
  return Math.max(MIN_SPIKE_THRESHOLD, Math.round(mean + SPIKE_SIGMA * Math.sqrt(variance)));
}

export function compareSpikeVsNormal(captures, threshold) {
  const spike = captures.filter((event) => (event.delta_tokens || 0) >= threshold && threshold > 0);
  const normal = captures.filter((event) => (event.delta_tokens || 0) < threshold);
  return {
    spike: cohortStats(spike),
    normal: cohortStats(normal),
  };
}

export function spikeRow(event, sessionsById) {
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

export function spikeAnatomy(captures, spikeCaptures) {
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
