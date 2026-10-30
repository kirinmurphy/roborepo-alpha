import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Codex provider adapter for skill-reference observation.
//
// Codex can expose direct file reads as tool_input.file_path, but live smoke testing also showed
// reference reads arriving as shell commands against the roborepo skill cache. Keep both payload
// shapes here, behind the Codex provider adapter.

const SHELL_TOOLS = new Set(["exec_command", "shell", "local_shell"]);
const SED_RANGE_PATTERN = /^[0-9,$]+[a-z]?$/i;

const noop = () => process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  noop();
}

const roots = [
  path.join(os.homedir(), ".codex", "skills"),
  path.join(stateRoot(), "skills"),
];
const observed = firstObservedReference(candidatePaths(input), roots);
if (!observed) noop();

emitObservation(input, observed);

function candidatePaths(payload) {
  const direct = payload?.tool_input?.file_path;
  const candidates = typeof direct === "string" && direct.trim() ? [direct] : [];
  const shell = shellCommand(payload);
  if (shell) {
    const shellPath = pathFromSupportedShellRead(shell);
    if (shellPath) candidates.push(shellPath);
  }
  return candidates;
}

function shellCommand(payload) {
  const toolName = String(payload?.tool_name || "");
  if (toolName && !SHELL_TOOLS.has(toolName)) return null;
  const input = payload?.tool_input || {};
  const command = input.cmd || input.command;
  return typeof command === "string" && command.trim() ? command : null;
}

function pathFromSupportedShellRead(command) {
  const tokens = shellTokens(command);
  if (tokens.length !== 4) return null;
  const [program, flag, range, filePath] = tokens;
  if (program !== "sed" || flag !== "-n" || !SED_RANGE_PATTERN.test(range)) return null;
  if (/[;&|`$<>()[\]{}]/.test(filePath)) return null;
  return filePath;
}

function shellTokens(command) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }
  if (quote || escaped) return [];
  if (token) tokens.push(token);
  return tokens;
}

function firstObservedReference(candidates, roots) {
  for (const candidate of candidates) {
    const abs = normalizeCandidatePath(candidate);
    if (!abs || !fs.existsSync(abs)) continue;
    const root = roots.find((entry) => abs.startsWith(`${entry}${path.sep}`));
    if (!root || !abs.includes(`${path.sep}references${path.sep}`)) continue;
    const rel = path.relative(root, abs);
    const segments = rel.split(path.sep);
    const skill = segments[0];
    const reference = segments.slice(1).join("/");
    if (skill && reference) return { skill, reference };
  }
  return null;
}

function normalizeCandidatePath(candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") return null;
  const expanded = candidate.startsWith("~/")
    ? path.join(os.homedir(), candidate.slice(2))
    : candidate;
  return path.resolve(expanded);
}

function emitObservation(input, observed) {
  const sequence = sessionObservationCount(input.session_id);
  const stamp = sequence === null ? "" : ` (observation ${sequence} this session)`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `[skill-visibility] observed reference read: ${observed.skill}/${observed.reference}${stamp}`,
    },
  }));
}

function stateRoot() {
  return (
    process.env.ROBOREPO_STATE_ROOT ||
    path.join(os.homedir(), ".roborepo")
  );
}

function sessionObservationCount(sessionId) {
  if (!sessionId) return null;
  try {
    const dir = path.join(stateRoot(), "skill-visibility");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "")}.count`);
    let count = 0;
    try {
      count = Number.parseInt(fs.readFileSync(file, "utf8"), 10) || 0;
    } catch {
      count = 0;
    }
    count += 1;
    fs.writeFileSync(file, String(count));
    return count;
  } catch {
    return null;
  }
}
