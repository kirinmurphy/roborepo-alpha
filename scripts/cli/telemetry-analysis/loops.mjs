import { mcpServerOf } from "../../harnesses/transcript-parse.mjs";
import { sessionKeyOf } from "./captures.mjs";
import { sessionContext } from "./sessions.mjs";
import { LOOP_REPEAT_THRESHOLD } from "./policy.mjs";
// Consecutive repeated calls are detected independently within each harness-scoped session.
export function detectLoops(captures, sessionsById, ledger) {
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
