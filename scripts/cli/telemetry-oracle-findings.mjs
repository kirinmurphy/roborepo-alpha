import { hasTokens, sessionKey, mcpServer } from "./telemetry-oracle-observations.mjs";

const LOOP_REPEAT_THRESHOLD = 8;
const LARGE_DOCUMENT_READ_CHARS = 20_000;
const REPEATED_DOCUMENT_READ_COUNT = 2;
const MIXED_CODE_LOOKUP_NATIVE_READS = 4;
const DOC_EXTS = new Set([".md", ".mdx", ".rst", ".txt"]);
const SOURCE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".css", ".scss", ".sh", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".php", ".cs", ".cpp", ".c", ".h", ".hpp", ".toml", ".yaml", ".yml"]);

export function spikeSessions(operations) {
  const captures = operations.filter(hasTokens);
  const deltas = captures.map((row) => row.delta_tokens || 0).filter((value) => value > 0);
  let threshold = 50_000;
  if (deltas.length >= 2) {
    const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    const variance = deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / deltas.length;
    threshold = Math.max(threshold, Math.round(mean + 2 * Math.sqrt(variance)));
  }
  return new Set(captures.filter((row) => threshold > 0 && (row.delta_tokens || 0) >= threshold).map(sessionKey));
}

export function loopSessions(operations) {
  const groups = new Map();
  for (const row of operations.filter(hasTokens)) {
    if (row.event !== "PostToolUse" || !row.tool?.name) continue;
    const key = sessionKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const affected = new Set();
  for (const [key, rows] of groups) {
    let previous = null, run = 0, best = 0;
    for (const row of rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
      const tool = row.tool.mcp_tool || row.tool.name;
      run = tool === previous ? run + 1 : 1;
      previous = tool;
      best = Math.max(best, run);
    }
    if (best >= LOOP_REPEAT_THRESHOLD) affected.add(key);
  }
  return affected;
}

function isNativeSourceRead(row) {
  const name = row.tool?.name || row.last_result?.tool;
  if (!["Read", "Grep", "Glob", "Bash"].includes(name)) return false;
  if (SOURCE_EXTS.has(row.tool?.file_ext)) return true;
  return name === "Bash" && (row.tool?.command_chars || 0) > 0 && (row.last_result?.chars || 0) > 0;
}

export function readWarningSessions(operations) {
  const affected = new Set(), byDocument = new Map(), bySession = new Map();
  for (const row of operations) {
    const key = sessionKey(row);
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(row);
    const fileHash = row.tool?.file_path_hash, extension = row.tool?.file_ext;
    if (row.event === "PostToolUse" && row.last_result?.chars >= LARGE_DOCUMENT_READ_CHARS && DOC_EXTS.has(extension)) affected.add(key);
    if (row.event === "PostToolUse" && fileHash && DOC_EXTS.has(extension)) {
      const documentKey = `${key}:${fileHash}`;
      const current = byDocument.get(documentKey) ?? { key, count: 0, chars: 0 };
      current.count += 1;
      current.chars += row.last_result?.chars || 0;
      byDocument.set(documentKey, current);
    }
  }
  const repeated = new Set();
  for (const row of byDocument.values()) if (row.count >= REPEATED_DOCUMENT_READ_COUNT && row.chars >= LARGE_DOCUMENT_READ_CHARS) {
    affected.add(row.key); repeated.add(row.key);
  }
  for (const [key, rows] of bySession) {
    const jdoc = rows.filter((row) => mcpServer(row.last_result?.tool || row.tool?.name) === "jdocmunch").length;
    if (repeated.has(key) && jdoc === 0) affected.add(key);
    const jcode = rows.filter((row) => mcpServer(row.last_result?.tool || row.tool?.name) === "jcodemunch").length;
    if (jcode > 0 && rows.filter(isNativeSourceRead).length >= MIXED_CODE_LOOKUP_NATIVE_READS) affected.add(key);
  }
  return affected;
}

