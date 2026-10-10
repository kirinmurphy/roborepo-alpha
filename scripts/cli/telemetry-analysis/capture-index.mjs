import { hasTokens, hasRateLimitsCapability } from "./captures.mjs";
import { spikeCause } from "./spikes.mjs";
import { toolGroup } from "./results.mjs";
// One capture traversal supplies rankings, timeline, and provider limits. Usage windows are local estimates.
export function indexScopedEvents(scopedEvents) {
  const harnesses = new Set();
  const captures = [];
  for (const event of scopedEvents) {
    if (event.harness) harnesses.add(event.harness);
    if (hasTokens(event)) captures.push(event);
  }
  return { captures, harnesses: [...harnesses].sort() };
}

export function indexCaptures(captures) {
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

export function rankedTop(counts) {
  return [...counts.values()].sort((a, b) => b.tokens - a.tokens || b.captures - a.captures);
}

export function usageWindows(captures, now = captures[0]?.ts ?? new Date().toISOString()) {
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

function countTop(counts, key, tokens) {
  const current = counts.get(key) ?? { key, captures: 0, tokens: 0 };
  current.captures += 1;
  current.tokens += tokens;
  counts.set(key, current);
}
