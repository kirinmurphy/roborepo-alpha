import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Claude provider adapter for skill-reference observation.
//
// Claude exposes file reads directly as tool_input.file_path. Keep that payload knowledge here so
// the skill-visibility rule stays separate from harness-specific hook shapes.

const noop = () => process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  noop();
}

const candidates = directFileCandidates(input);
const observed = firstObservedReference(candidates, [path.join(os.homedir(), ".claude", "skills")]);
if (!observed) noop();

emitObservation(input, observed);

function directFileCandidates(payload) {
  const filePath = payload?.tool_input?.file_path;
  return typeof filePath === "string" && filePath.trim() ? [filePath] : [];
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
