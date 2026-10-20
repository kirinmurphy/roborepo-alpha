import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpServerOf } from "./transcript-parse.mjs";

// Locate a harness transcript from a session id, then surface the heaviest turns so a flagged event
// (spike, loop) can be tied back to what actually happened in the chat. Read-only, best-effort:
// never throws to the server — a missing/rotated transcript returns a "not found" shape, not an
// error. Sizes + short previews only, consistent with the capture-side privacy posture (no full
// tool results, no full prompts are ever returned).

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");
const CODEX_SESSIONS = path.join(HOME, ".codex", "sessions");
// How many characters of any message/tool text to surface. Enough to recognise the turn; never the
// whole thing.
const PREVIEW_CHARS = 280;

// Find the transcript file for a session. Claude names the file "<session_id>.jsonl" under a
// per-cwd project dir; Codex embeds the uuid in a dated rollout filename. We glob by walking the
// known roots (shallow for Claude, recursive for Codex's date tree) rather than shelling out.
export function locateTranscript(sessionId, harness) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  if (harness === "codex") {
    return findFile(CODEX_SESSIONS, (name) => name.includes(sessionId) && name.endsWith(".jsonl"), 6);
  }
  // Claude (default): exact "<id>.jsonl" one level under projects/<encoded-cwd>/.
  return findFile(CLAUDE_PROJECTS, (name) => name === sessionId + ".jsonl", 2);
}

// Depth-limited file search returning the first match's absolute path, or null. Symlinks are not
// followed beyond the first level; errors (unreadable dirs) are swallowed so a partial tree never
// breaks the lookup.
function findFile(root, matches, maxDepth) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && matches(entry.name)) return full;
    if (entry.isDirectory() && maxDepth > 1) {
      const found = findFile(full, matches, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

// Parse a transcript and return the turns whose tool results were largest — the likely drivers of a
// spike — newest-result-wins for ties. Each turn carries the tool, its result size, and a short
// escaped-free text preview (the caller escapes for HTML). Degrades gracefully: unknown schema or
// unreadable file yields an empty list, never a throw.
export function extractHeavyTurns(transcriptPath, { limit = 8 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const toolById = new Map(); // tool_use id -> { tool, ts }
  const turns = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message;
    if (!message) continue;
    const ts = entry.timestamp || entry.ts || null;

    if (entry.type === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          if (typeof block.id === "string") toolById.set(block.id, { tool: block.name, ts });
        }
      }
    }
    if (entry.type === "user" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const meta = toolById.get(block.tool_use_id) || { tool: null, ts };
        const chars = resultChars(block.content);
        turns.push({
          ts: meta.ts || ts,
          tool: meta.tool,
          is_mcp: meta.tool ? mcpServerOf(meta.tool) !== null : false,
          result_chars: chars,
          approx_tokens: Math.round(chars / 4),
          preview: previewOf(block.content),
        });
      }
    }
  }
  return turns.sort((a, b) => b.result_chars - a.result_chars).slice(0, limit);
}

// A first-prompt title for the session, for the analysis prompt / modal header. Returns null if the
// transcript has no readable user text.
export function transcriptTitle(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "user" || !entry.message) continue;
    const text = userText(entry.message.content);
    if (text) return clip(text, PREVIEW_CHARS);
  }
  return null;
}

function userText(content) {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (Array.isArray(content)) {
    const text = content.find((b) => b?.type === "text" && typeof b.text === "string");
    return text ? text.text.replace(/\s+/g, " ").trim() : "";
  }
  return "";
}

// Short, single-line preview of a tool result — text blocks only, never the full payload.
function previewOf(content) {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map((b) => (typeof b?.text === "string" ? b.text : "")).join(" ");
  return clip(text.replace(/\s+/g, " ").trim(), PREVIEW_CHARS);
}

function resultChars(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : safeLen(block)), 0);
  }
  return safeLen(content);
}

function safeLen(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function clip(str, n) {
  return str && str.length > n ? str.slice(0, n) + "…" : str || "";
}

// A ready-to-paste prompt that points an agent at the transcript and tells it what telemetry flagged
// and what to conclude. The transcript path is included so the agent can read it directly.
export function buildAnalysisPrompt({ sessionId, harness, finding, transcriptPath }) {
  const where = transcriptPath ? ` Its transcript is at ${transcriptPath}.` : "";
  return [
    `Investigate the ${harness || "Claude"} session ${sessionId}.${where}`,
    `Telemetry flagged it: ${finding}.`,
    `Read the transcript, identify the turn(s) that drove the abnormal token use, explain what happened,`,
    `and give one concrete change to avoid it next time.`,
  ].join(" ");
}
