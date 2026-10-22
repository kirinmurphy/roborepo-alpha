import { sessionKeyOf, minStr, maxStr } from "./captures.mjs";
// Session identity, activity summaries, and context shared by every finding.
export function rollupSessions(captures) {
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

export function computeCumulativeConcern(sessions) {
  if (!sessions.length) return 20_000_000;
  const totals = sessions.map((s) => s.total_tokens).filter((t) => t > 0).sort((a, b) => a - b);
  if (!totals.length) return 20_000_000;
  const p90 = totals[Math.floor(totals.length * 0.9)] ?? totals[totals.length - 1];
  return Math.max(10_000_000, Math.round(p90 * 2));
}

export function sessionContext(event, sessionsById) {
  const s = sessionsById?.get(sessionKeyOf(event));
  if (!s) return null;
  return { title: s.title ?? null, activity: s.activity ?? null, repo: s.repo, branch: s.branch ?? null, harness: s.harness ?? null };
}

function activitySummary(toolCounts, extCounts) {
  const tools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => n + " " + k);
  const exts = Object.entries(extCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => "." + k);
  const parts = [];
  if (tools.length) parts.push(tools.join(" · "));
  if (exts.length) parts.push("mostly " + exts.join(", "));
  return parts.join(" · ") || null;
}
