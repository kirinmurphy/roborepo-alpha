import { mcpServerOf } from "../../harnesses/transcript-parse.mjs";
import { approxTokens, resultToolLabel, toolGroup, resultCaptures } from "./results.mjs";
import { sessionKeyOf, minStr, maxStr } from "./captures.mjs";
// Cost rollups use attributed result sizes, not token deltas from whichever hook fired.
export function toolCost(captures) {
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

export function groupCost(captures) {
  const byGroup = new Map();
  const groupSessions = new Map();
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

export function packageCost(captures) {
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
