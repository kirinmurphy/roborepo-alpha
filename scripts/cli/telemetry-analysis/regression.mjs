import { resultCaptures, toolGroup, approxTokens } from "./results.mjs";
// Exploratory earlier/later cost comparison, split only at a distinct timestamp.
export function regression(captures) {
  const rows = resultCaptures(captures).slice().sort((a, b) => a.ts.localeCompare(b.ts));
  if (rows.length < 4) return { split_ts: null, groups: [] };
  // Choose the closest real time boundary to the row midpoint. Splitting equal timestamps by an
  // incidental input/flow order would put simultaneous calls on both sides and change the result
  // when the same spool is reordered. With no distinct timestamps there is no earlier/later claim.
  const target = rows.length / 2;
  const boundaries = rows.flatMap((row, index) => index > 0 && rows[index - 1].ts !== row.ts ? [index] : []);
  if (!boundaries.length) return { split_ts: null, groups: [] };
  const mid = boundaries.reduce((best, index) => Math.abs(index - target) < Math.abs(best - target) ? index : best);
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
