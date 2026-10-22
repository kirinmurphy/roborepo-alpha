// Deterministic "what happened in this session" prose — the session drill-down's WHAT-HAPPENED
// section. Pure function over the session's own report rows (no I/O, no LLM): templates +
// pipeline numbers, same pattern as deriveInsights' next_action strings. Each rule fires only
// when the data supports it and carries the fields the portal popup needs to render itself:
//
//   { kind, severity, summary, detail, hint, section_key }
//
// - kind: stable rule id (the same vocabulary deriveInsights uses).
// - summary: one plain sentence for the popup's headline ("what went wrong here").
// - detail: the numbers behind it (kept for tooltips / the agent prompt).
// - hint: the fix — same strings the Investigate rows already show.
// - section_key: the Investigate section this finding belongs to (spikes/loops/reads/testing), so
//   the popup can link to the evidence; a finding with no matching section omits it.
//
// The portal NEVER writes prose itself — it renders these rows verbatim. CLI/portal/agent prompt
// all read the same output, so the sentence can't drift between surfaces.

import { clipText, formatCount } from "./telemetry-format.mjs";

const SEVERITY_RANK = { high: 0, warn: 1, info: 2 };

const READ_WARNING_SUMMARY = {
  large_document_read: (agg) =>
    `Loaded a very large document straight into context — ${formatTokenCount(agg.tokens)} tokens across ${agg.reads} read${agg.reads > 1 ? "s" : ""}.`,
  repeated_document_read: (agg) =>
    `Re-read the same large document ${agg.list.length} time${agg.list.length > 1 ? "s" : ""} — ${formatTokenCount(agg.tokens)} tokens spent re-reading content already in context.`,
  stale_doc_lookup: () =>
    "Docs were read repeatedly without any doc-index lookups — the session worked around a missing lookup tool.",
  mixed_code_lookup: (agg) =>
    `Used the code index but still made ${agg.reads} native source reads — the lookup habit isn't sticking yet.`,
};

// One finding per rule, gathered from the session's own rows. Findings are ordered worst-first by
// severity — the popup shows them in order, no re-ranking client-side.
export function deriveSessionFindings({ sessionId, spikes = [], loops = [], read_warnings = [], testing_efficiency = null }) {
  const out = [];

  // --- spikes in this session ---------------------------------------------------------------------
  for (const s of spikes) {
    out.push({
      kind: "session_spike",
      severity: "high",
      summary: `A single turn added ${formatTokenCount(s.delta_tokens)} tokens to the context at once — ${formatCount(s.delta_tokens)} tokens in one step.`,
      detail: `turn at ${s.ts} · ${s.tool || "unknown tool"} · cause: ${s.cause || "unattributed"}`,
      hint: s.hint || null,
      section_key: "spikes",
    });
  }

  // --- runaway tool loops in this session -----------------------------------------------------------
  for (const l of loops) {
    out.push({
      kind: "session_loop",
      severity: "high",
      summary: `${l.tool} fired ${l.max_repeat}× in a row — a runaway loop that re-spent tokens for the same answer.`,
      detail: `${formatCount(l.wasted_tokens || 0)} tokens spent on repeat calls${l.context?.title ? ` · while working on "${clipText(l.context.title, 60)}"` : ""}`,
      hint: l.hint || null,
      section_key: "loops",
    });
  }

  // --- document reads in this session (grouped by warning type, one finding per type) ---------------
  const readByType = new Map();
  for (const w of read_warnings) {
    if (!readByType.has(w.type)) readByType.set(w.type, { list: [], tokens: 0, reads: 0 });
    const cur = readByType.get(w.type);
    cur.list.push(w);
    cur.tokens += w.approx_tokens || 0;
    cur.reads += w.read_count || 1;
  }
  for (const [type, agg] of readByType) {
    out.push({
      kind: "session_read_warning",
      severity: type === "large_document_read" ? "warn" : "high",
      summary: READ_WARNING_SUMMARY[type]
        ? READ_WARNING_SUMMARY[type](agg)
        : `Large or repeated document reads added ${formatTokenCount(agg.tokens)} tokens of context.`,
      detail: `${agg.list.length} instance${agg.list.length > 1 ? "s" : ""} · ${formatTokenCount(agg.tokens)} approx tokens · ${agg.reads} total reads`,
      hint: agg.list[0]?.hint || null,
      section_key: "reads",
    });
  }

  // --- testing share --------------------------------------------------------------------------------
  // NOTE: test.token_share is a REPORT-GLOBAL metric (testing's share of all captured tokens in
  // the report window), not a per-session one. The session drill-down only passes rows already
  // scoped to this session, so the caller supplies the report-global testing summary separately
  // when it wants the popup to mention testing. Kept here so the popup contract stays one shape.
  const tokenShare = testing_efficiency?.["test.token_share"];
  if (tokenShare != null && tokenShare >= 10) {
    const fullSuite = testing_efficiency["test.full_suite_without_intervening_edit"] ?? 0;
    out.push({
      kind: "session_testing",
      severity: "warn",
      summary: `Testing ate ${tokenShare}% of your captured tokens — that's above the over-testing line.`,
      detail: fullSuite >= 1
        ? `includes ${Math.round(fullSuite)} full-suite rerun${Math.round(fullSuite) === 1 ? "" : "s"} without an edit in between`
        : "no full-suite reruns without an edit observed",
      hint: "Run targeted tests (single file or --filter) between edits — save the full suite for the end.",
      section_key: "testing",
    });
  }

  // Order: high before warn; ties by kind for stable output.
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.kind.localeCompare(b.kind));
}

function formatTokenCount(value) {
  if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
  if (value >= 1e3) return Math.round(value / 1e3) + "k";
  return String(Math.round(value || 0));
}
