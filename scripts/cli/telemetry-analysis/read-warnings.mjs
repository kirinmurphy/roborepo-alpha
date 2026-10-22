import { mcpServerOf } from "../../harnesses/transcript-parse.mjs";
import { sessionKeyOf } from "./captures.mjs";
import { sessionContext } from "./sessions.mjs";
import { approxTokens } from "./results.mjs";
import { LARGE_DOCUMENT_READ_CHARS, REPEATED_DOCUMENT_READ_COUNT, MIXED_CODE_LOOKUP_NATIVE_READS, DOC_EXTS, SOURCE_EXTS } from "./policy.mjs";
export function readWarnings(events, sessionsById, ledger) {
  const warnings = [];
  const byDoc = new Map();
  const bySession = new Map();
  for (const event of events) {
    const id = sessionKeyOf(event);
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(event);
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
  for (const sessionEvents of bySession.values()) {
    const repeatedDocs = warnings.filter((warning) => warning.type === "repeated_document_read" && sessionKeyOf(warning) === sessionKeyOf(sessionEvents[0])).length;
    const jdocCalls = sessionEvents.filter((event) => mcpServerOf(event.last_result?.tool || event.tool?.name) === "jdocmunch").length;
    if (repeatedDocs > 0 && jdocCalls === 0) {
      warnings.push(readWarningRow("stale_doc_lookup", sessionEvents[0], sessionsById, {
        read_count: repeatedDocs,
        jdocmunch_calls: jdocCalls,
        hint: "docs were read repeatedly with no doc-index lookups observed",
      }));
    }
    const jcodeCalls = sessionEvents.filter((event) => mcpServerOf(event.last_result?.tool || event.tool?.name) === "jcodemunch").length;
    const nativeSourceReads = sessionEvents.filter((event) => isNativeSourceRead(event)).length;
    if (jcodeCalls > 0 && nativeSourceReads >= MIXED_CODE_LOOKUP_NATIVE_READS) {
      warnings.push(readWarningRow("mixed_code_lookup", sessionEvents[0], sessionsById, {
        read_count: nativeSourceReads,
        jcodemunch_calls: jcodeCalls,
        hint: "jcodemunch was used but many native source reads still occurred",
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

function isNativeSourceRead(event) {
  const toolName = event.tool?.name || event.last_result?.tool;
  if (toolName !== "Read" && toolName !== "Grep" && toolName !== "Glob" && toolName !== "Bash") return false;
  if (SOURCE_EXTS.has(event.tool?.file_ext)) return true;
  return toolName === "Bash" && (event.tool?.command_chars || 0) > 0 && (event.last_result?.chars || 0) > 0;
}
