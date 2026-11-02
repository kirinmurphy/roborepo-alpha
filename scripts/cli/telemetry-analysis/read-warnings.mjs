import { sessionKeyOf } from "./captures.mjs";
import { sessionContext } from "./sessions.mjs";
import { approxTokens } from "./results.mjs";
import { LARGE_DOCUMENT_READ_CHARS, REPEATED_DOCUMENT_READ_COUNT, DOC_EXTS } from "./policy.mjs";
export function readWarnings(events, sessionsById, ledger) {
  const warnings = [];
  const byDoc = new Map();
  for (const event of events) {
    const id = sessionKeyOf(event);
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

