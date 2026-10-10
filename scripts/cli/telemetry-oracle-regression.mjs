import { hasTokens, mcpServer } from "./telemetry-oracle-observations.mjs";

export function regression(operations) {
  const rows = operations.filter(hasTokens).filter((row) => row.last_result && typeof row.last_result.chars === "number" && row.last_result.tool)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (rows.length < 4) return { split_ts: null, groups: [] };
  const target = rows.length / 2;
  const boundaries = rows.flatMap((row, index) => index > 0 && rows[index - 1].ts !== row.ts ? [index] : []);
  if (!boundaries.length) return { split_ts: null, groups: [] };
  const middle = boundaries.reduce((best, index) => Math.abs(index - target) < Math.abs(best - target) ? index : best);
  const beforeRows = rows.slice(0, middle), afterRows = rows.slice(middle);
  const aggregate = (items) => {
    const result = new Map();
    for (const row of items) {
      const group = toolGroup(row.last_result.tool), current = result.get(group) ?? { calls: 0, chars: 0 };
      current.calls++; current.chars += row.last_result.chars; result.set(group, current);
    }
    return result;
  };
  const before = aggregate(beforeRows), after = aggregate(afterRows);
  const latest = rows.at(-1).ts, cutoff = new Date(Date.parse(latest) - 7 * 86_400_000).toISOString();
  const weekRows = rows.filter((row) => row.ts >= cutoff), week = aggregate(weekRows);
  const total = (items) => items.reduce((sum, row) => sum + (row.last_result.chars || 0), 0);
  const beforeTotal = total(beforeRows), afterTotal = total(afterRows), weekTotal = total(weekRows);
  const groups = [...new Set([...before.keys(), ...after.keys()])].map((group) => {
    const b = before.get(group), a = after.get(group), w = week.get(group);
    const beforeAverage = b ? Math.round((b.chars / b.calls) / 4) : 0;
    const afterAverage = a ? Math.round((a.chars / a.calls) / 4) : 0;
    return { group, before_avg_tokens: beforeAverage, after_avg_tokens: afterAverage,
      delta_tokens: afterAverage - beforeAverage, before_calls: b?.calls ?? 0, after_calls: a?.calls ?? 0,
      before_share: beforeTotal > 0 ? (b?.chars ?? 0) / beforeTotal : 0,
      after_share: afterTotal > 0 ? (a?.chars ?? 0) / afterTotal : 0,
      week_share: weekTotal > 0 ? (w?.chars ?? 0) / weekTotal : 0 };
  }).sort((a, b) => a.group.localeCompare(b.group));
  return { split_ts: rows[middle].ts, groups };
}

function toolGroup(name) {
  const server = mcpServer(name);
  if (server === "jcodemunch" || server === "jdocmunch") return server;
  if (server) return "mcp-other";
  if (["Read", "Grep", "Glob"].includes(name)) return "native-read";
  if (["Edit", "Write", "NotebookEdit"].includes(name)) return "edit";
  if (name === "Bash") return "bash";
  return "other";
}
