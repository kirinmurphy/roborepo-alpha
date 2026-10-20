// Turns the analyzeTelemetry facts into ranked, plain-English conclusions — the "what this means"
// headline so the user doesn't scan tables to reach an actionable read. Pure function over the
// report object (no I/O); shared by the CLI report and the dashboard so both speak the same
// conclusions. Each rule is independent, fires only when its data supports it, and is deliberately
// conservative so the headline never cries wolf.
//
// Actionable finding contract: every finding below still carries its original severity/headline/detail/metric
// fields (existing portal/CLI consumers keep working unchanged) PLUS a `confidence` label and a
// `next_action` string, assembled by attachActionableFields() at the end of deriveInsights(). These
// deterministic-rule findings are direct observations over the full dataset (not a cohort
// comparison), so their confidence is derived from sample size alone (MIN_CALLS-scaled), and
// `next_action` is a short deterministic template per finding shape — never free LLM text.

const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const pct = (n) => Math.round(n * 100);

// Minimum calls before a per-call cost comparison is trustworthy (avoid concluding from 2 samples).
const MIN_CALLS = 20;
// A group whose total tokens exceed this share of all attributed tokens is the "dominant cost".
const DOMINANT_SHARE = 0.4;
// Spike lift at/above this means a group drives spikes far more than its everyday rate (tail risk).
const TAIL_RISK_LIFT = 10;
// Cost-per-call gap that's worth calling out as "cheaper/heavier".
const COST_GAP = 0.15;

export function deriveInsights(report) {
  if (!report || !report.capture_count) return [];
  const out = [];

  // --- native read/grep vs each MCP package (agnostic to which MCP) ----------------------------
  // The "is the MCP cheaper than the read/grep it replaces" question, generalized: compare the
  // native-read group against EVERY MCP package present in the data (keyed by server name, whatever
  // it is), so this fires for jcodemunch today and any future exploration MCP with no code change.
  const groups = indexBy(report.group_cost, "group");
  const nativeRead = groups["native-read"];
  if (nativeRead && nativeRead.calls >= MIN_CALLS) {
    for (const pkg of report.package_cost || []) {
      if (pkg.package === "native" || pkg.calls < MIN_CALLS) continue;
      const gap = nativeRead.avg_tokens > 0 ? (nativeRead.avg_tokens - pkg.avg_tokens) / nativeRead.avg_tokens : 0;
      if (Math.abs(gap) < COST_GAP) continue;
      const cheaper = gap > 0; // MCP cheaper than native
      out.push({
        severity: "info",
        headline: `${pkg.package} (MCP) is ${pct(Math.abs(gap))}% ${cheaper ? "cheaper" : "more expensive"} per call than native read/grep`,
        detail: `${fmt(pkg.avg_tokens)} vs ${fmt(nativeRead.avg_tokens)} tok/call (${fmt(pkg.calls)} ${pkg.package} · ${fmt(nativeRead.calls)} native calls)`,
        metric: Math.abs(gap),
        kind: "mcp_vs_native",
        sample_size: pkg.calls + nativeRead.calls,
        next_action: cheaper
          ? `Prefer ${pkg.package} over native read/grep for this kind of lookup when available.`
          : `Investigate why ${pkg.package} costs more per call than native read/grep here — check for oversized result bundles.`,
      });
    }
  }

  // --- spike tail risk: a group that drives spikes far above its baseline rate -----------------
  for (const g of (report.spike_anatomy?.groups || [])) {
    if (g.lift != null && g.lift >= TAIL_RISK_LIFT) {
      out.push({
        severity: "high",
        headline: `${g.group} is ${Math.round(g.lift)}× more likely to drive a token spike than normal — tail risk`,
        detail: `appears in ${pct(g.spike_share)}% of spike turns; rare but blows up context when used`,
        metric: g.lift,
        kind: "spike_tail_risk",
        sample_size: report.spike_anatomy?.spike_count ?? 0,
        next_action: `Scope ${g.group} calls more narrowly (smaller query, fewer refs) before they land in context.`,
      });
    }
  }

  // --- dominant cost center: the group/package eating most of the tokens -----------------------
  const totalTokens = (report.group_cost || []).reduce((s, g) => s + (g.total_tokens || 0), 0);
  const top = (report.group_cost || []).slice().sort((a, b) => b.total_tokens - a.total_tokens)[0];
  if (top && totalTokens > 0 && top.total_tokens / totalTokens >= DOMINANT_SHARE) {
    out.push({
      severity: "info",
      headline: `${top.group} is your dominant token cost — ${pct(top.total_tokens / totalTokens)}% of all tool tokens`,
      detail: `${fmt(top.total_tokens)} tok across ${fmt(top.calls)} calls (${fmt(top.avg_tokens)}/call)`,
      metric: top.total_tokens / totalTokens,
      kind: "dominant_cost",
      sample_size: top.calls,
      next_action: `If ${top.group} usage can be reduced or scoped tighter, that is the highest-leverage place to cut token cost.`,
    });
  }

  // --- runaway loops ---------------------------------------------------------------------------
  if ((report.loops || []).length) {
    const loops = report.loops;
    const byTool = {};
    for (const l of loops) byTool[l.tool] = (byTool[l.tool] || 0) + 1;
    const topTool = Object.entries(byTool).sort((a, b) => b[1] - a[1])[0]?.[0];
    const worst = loops[0]; // already sorted by max_repeat desc in analyze
    out.push({
      severity: "high",
      headline: `${loops.length} runaway loop${loops.length > 1 ? "s" : ""} detected — mostly ${topTool}`,
      detail: `worst: ${worst.tool} ×${worst.max_repeat} in ${worst.repo}${worst.context?.title ? ` ("${clip(worst.context.title, 50)}")` : ""}`,
      metric: worst.max_repeat,
      kind: "runaway_loop",
      sample_size: loops.length,
      next_action: `Inspect the ${worst.repo} session that repeated ${worst.tool} ${worst.max_repeat}× — likely a skill or agent stuck in a retry loop.`,
    });
  }

  // --- regression: a group that got more expensive over time -----------------------------------
  // Trigger, worst-pick, headline and detail all speak in per-call cost; mixing in share of tool
  // tokens could state a direction opposite to the trigger. Share is context only.
  const reg = (report.regression?.groups || []).filter((g) => g.delta_tokens > 0 && g.after_calls >= MIN_CALLS / 2);
  const worstReg = reg.sort((a, b) => b.delta_tokens - a.delta_tokens)[0];
  if (worstReg && worstReg.before_avg_tokens > 0 && worstReg.delta_tokens / worstReg.before_avg_tokens >= 0.5) {
    const beforeShare = Math.round((worstReg.before_share ?? 0) * 100);
    const afterShare = Math.round((worstReg.after_share ?? 0) * 100);
    out.push({
      severity: "warn",
      headline: `${worstReg.group} calls got ${pct(worstReg.delta_tokens / worstReg.before_avg_tokens)}% heavier: ${fmt(worstReg.before_avg_tokens)} → ${fmt(worstReg.after_avg_tokens)} tok/call`,
      detail: `${worstReg.group} is ${afterShare}% of tool tokens in the later half vs ${beforeShare}% in the earlier half`,
      metric: worstReg.delta_tokens,
      kind: "midpoint_regression",
      sample_size: worstReg.before_calls + worstReg.after_calls,
      next_action: `This is an exploratory midpoint split, not tied to a specific change — mark the change you suspect with \`telemetry mark\` and use the marker-relative comparison instead.`,
    });
  }

  // --- heaviest single tool (cost-per-call outlier) --------------------------------------------
  const heaviest = (report.tool_cost || []).filter((t) => t.calls >= MIN_CALLS / 2).slice().sort((a, b) => b.avg_tokens - a.avg_tokens)[0];
  if (heaviest && heaviest.avg_tokens >= 3000) {
    out.push({
      severity: "info",
      headline: `${heaviest.tool} is your heaviest call at ${fmt(heaviest.avg_tokens)} tok each`,
      detail: `${fmt(heaviest.calls)} calls, up to ${fmt(heaviest.max_tokens)} tok in one — scope it tighter`,
      metric: heaviest.avg_tokens,
      kind: "heaviest_tool",
      sample_size: heaviest.calls,
      next_action: `Narrow what ${heaviest.tool} returns into context (line ranges, filters, or a smaller query) before calling it again.`,
    });
  }

  const rank = { high: 0, warn: 1, info: 2 };
  return out
    .sort((a, b) => (rank[a.severity] - rank[b.severity]) || (b.metric - a.metric))
    .slice(0, 8)
    .map(attachActionableFields);
}

// Below this many contributing calls/sessions, a deterministic finding is still shown (the rule
// already required MIN_CALLS-scale evidence to fire at all) but labeled "emerging pattern" rather
// than "strong signal" — matches telemetry-compare.mjs's STRONG_SIGNAL_MIN_SESSIONS threshold
// philosophy, scaled down since these are per-call rather than per-session findings.
const STRONG_SIGNAL_MIN_CALLS = MIN_CALLS * 2;

// Adds the actionable-finding-contract fields (confidence, analysis_filter_state) to a
// deterministic finding, on top of its existing severity/headline/detail/metric shape. Every finding
// that reaches this point already passed its rule's own evidence threshold, so confidence here only
// distinguishes "solid sample" from "thin but still above the firing threshold" — never
// "insufficient evidence" (a finding below that bar never fires in the first place, per each rule's
// own MIN_CALLS gate above).
function attachActionableFields(finding) {
  const sampleSize = finding.sample_size ?? null;
  const confidence = sampleSize != null && sampleSize >= STRONG_SIGNAL_MIN_CALLS ? "strong signal" : "emerging pattern";
  return {
    ...finding,
    confidence,
    // Reproduces this finding's shape in the Analysis explorer as ready-to-apply filter state.
    // kind maps 1:1 to the metric/cohort dimension the explorer would pre-select;
    // portal-side wiring (analysis-explorer.js) reads this to open the explorer pre-filled.
    analysis_filter_state: { kind: finding.kind ?? null },
  };
}

// Compact text summary of the deterministic findings + key facts, for the optional LLM deeper-read.
// Only computed facts go out — never raw spool lines, prompts, or tool results.
export function insightsSummary(report) {
  const lines = [];
  lines.push(`captures: ${report.capture_count}, sessions: ${report.sessions?.length || 0}`);
  lines.push("cost per call by group (approx tokens):");
  for (const g of report.group_cost || []) lines.push(`  ${g.group}: ${g.avg_tokens}/call, ${g.calls} calls, ${g.total_tokens} total`);
  if (report.spike_anatomy?.groups?.length) {
    lines.push("spike anatomy (lift vs normal):");
    for (const g of report.spike_anatomy.groups.slice(0, 6)) lines.push(`  ${g.group}: lift ${g.lift ?? "only-in-spikes"}, ${pct(g.spike_share)}% of spikes`);
  }
  if (report.loops?.length) lines.push(`loops: ${report.loops.length} (worst ${report.loops[0].tool} x${report.loops[0].max_repeat} in ${report.loops[0].repo})`);
  lines.push("deterministic findings:");
  for (const f of deriveInsights(report)) lines.push(`  [${f.severity}] ${f.headline} — ${f.detail}`);
  return lines.join("\n");
}

function indexBy(arr, key) {
  const m = {};
  for (const x of arr || []) m[x[key]] = x;
  return m;
}
function clip(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : (s || ""); }
