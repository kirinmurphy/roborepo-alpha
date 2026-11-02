import { privacyHash } from "./telemetry-schemas/hash.mjs";

// Pure semantic classification of a tool command into an operation category (test/lint/build/...)
// plus, for tests specifically, a runner and scope (targeted vs full). Deliberately has zero
// dependency on telemetry-capture.mjs's state/IO so it stays cheap enough to import from the hot
// capture path and to unit
// test in isolation.
//
// Store this version alongside every classification result so historical data stays interpretable
// if the rules change later.
//
// v2: adds the "read" category (file reads and searches through the shell), classifies each
// `&&`/`;`/`||` segment instead of the whole string, and is applied to shell tools only. v1 matched
// "test" anywhere in a command, so reading or grepping a test file counted as a test run.
export const CLASSIFIER_VERSION = 2;

// Hook-side names of the tools whose `command` input is a shell command line. Codex reports its
// exec_command calls to hooks as "Bash"; other tools with a `command` field (Codex's apply_patch
// carries the patch text there) are not shell commands and must not be classified as one.
export const SHELL_TOOL_NAMES = new Set(["Bash", "run_shell_command"]);

// Transcript-side names of the tool calls whose results are shell output. Codex's transcript names
// the whole call "exec" (or "exec_command"/"shell" in older rollouts) even though its hooks see each
// inner command as "Bash".
export const SHELL_RESULT_TOOL_NAMES = new Set(["Bash", "exec", "exec_command", "shell", "run_shell_command"]);

// An event's operation counts only when it came from a shell tool; an event with no tool name is
// trusted as-is.
export function shellOperation(event) {
  const operation = event?.operation ?? null;
  const toolName = event?.tool?.name ?? null;
  return operation && (!toolName || SHELL_TOOL_NAMES.has(toolName)) ? operation : null;
}

// Commands that only read or search files. Matched on a segment's first word; an in-place sed or a
// find that executes or deletes is a mutation, not a read.
const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "nl", "wc", "ls", "tree", "stat", "du", "file", "sed", "find", "rg", "grep", "egrep", "fgrep", "fd", "jq"]);

const RUNNERS = ["pnpm", "npm", "yarn", "bun", "vitest", "jest", "playwright", "pytest"];

// Repository-declared command knowledge takes precedence over guessing from the raw string (plan
// rule #1). Only `package.json`'s own `scripts` map is consulted — Makefiles/CI config are out of
// scope for this pass; ambiguous commands fall through to the pattern-based classifier below and
// ultimately to "unknown" rather than a guess.
export function classifyCommand(rawCommand, { packageScripts = null } = {}) {
  if (typeof rawCommand !== "string" || !rawCommand.trim()) {
    return unknownOperation();
  }
  const normalized = normalizeCommand(rawCommand);
  const signature = commandSignature(normalized);
  // `cd app && npm test` runs a test; `sed -n 1,40p x && npm test` too. The first segment that is
  // neither a read nor unrecognized decides; otherwise a read segment makes the command a read.
  const segments = commandSegments(normalized).map((segment) => classifySegment(segment, packageScripts, signature));
  return segments.find((result) => result.category !== "read" && result.category !== "other")
    ?? segments.find((result) => result.category === "read")
    ?? unknownOperation();
}

function classifySegment(segment, packageScripts, signature) {
  const npmScriptName = extractNpmScriptInvocation(segment);
  if (npmScriptName && packageScripts && Object.prototype.hasOwnProperty.call(packageScripts, npmScriptName)) {
    const scriptBody = packageScripts[npmScriptName];
    const fromScript = classifyNormalized(normalizeCommand(scriptBody), { scriptName: npmScriptName, signature });
    if (fromScript.category !== "other") return fromScript;
  }
  return classifyNormalized(segment, { scriptName: npmScriptName, signature });
}

// Splits on the sequencing operators, not on pipes: `npm test 2>&1 | tail -30` is one test run.
// A `cd` segment only changes directory and is dropped.
function commandSegments(normalized) {
  return normalized.split(/\s*(?:&&|\|\||;)\s*/)
    .filter((segment) => segment && !/^cd(\s|$)/.test(segment))
    .map(normalizeCommand);
}

function unknownOperation() {
  return {
    category: "other",
    runner: null,
    scope: "unknown",
    target: null,
    signature: null,
    classifier_version: CLASSIFIER_VERSION,
  };
}

// Collapse whitespace and strip common indirection wrappers (`roborepo run`, leading `npx`) so the
// pattern matchers below see the underlying command (plan rule #2: "normalize wrappers").
function normalizeCommand(command) {
  let normalized = command.replace(/\s+/g, " ").trim();
  normalized = normalized.replace(/^roborepo\s+run\s+/, "");
  normalized = normalized.replace(/^npx\s+/, "");
  return normalized;
}

function extractNpmScriptInvocation(normalized) {
  const match = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([a-zA-Z0-9_:.-]+)/.exec(normalized);
  return match ? match[1] : null;
}

function detectRunner(normalized) {
  for (const runner of RUNNERS) {
    if (new RegExp(`(^|[\\s/])${runner}(\\s|$)`).test(normalized)) return runner;
  }
  if (/\.sh(\s|$)/.test(normalized) || /^(bash|sh)\s/.test(normalized)) return "shell script";
  if (/^node\s/.test(normalized)) return "node-test";
  return "unknown";
}

// Explicit test files/paths/filters/projects/selectors named on the command line count as
// targeted/affected (plan rule #3); a bare repo-wide test script without any selector is full
// (plan rule #4). Ambiguous shapes fall back to "unknown" (plan rule #5) rather than guessing.
function detectTestScope(normalized, { scriptName } = {}) {
  const hasSelector = /(--grep|--filter|--project|--testPathPattern|--test-name-pattern|-t\s|--shard)/.test(normalized)
    || /\.(test|spec)\.[jt]sx?/.test(normalized)
    || /\btest\/[\w/-]+\.[a-z]+/.test(normalized)
    || /\btests?\/[\w/-]+\.[a-z]+\b/.test(normalized);
  if (hasSelector) return "targeted";
  if (/--affected|--changed|--since/.test(normalized)) return "affected";
  // A known repo-wide script name (e.g. this repo's own `npm test` -> test-cli.sh) run with no
  // selector is the canonical full-suite shape.
  if (scriptName === "test" || /^(npm|pnpm|yarn|bun)\s+(run\s+)?test$/.test(normalized)) return "full";
  if (/\btest(s)?\b/.test(normalized) && !hasSelector) return "unknown";
  return "unknown";
}

function safeTarget(normalized) {
  // Only surface a target when it looks like a repo-relative test path/selector already visible in
  // the command — never a full filesystem path, which could leak machine-specific structure.
  const match = /\b((?:test|tests|spec|specs)\/[\w./-]+|[\w./-]+\.(?:test|spec)\.[jt]sx?)\b/.exec(normalized);
  return match ? match[1] : null;
}

function classifyNormalized(normalized, { scriptName, signature = commandSignature(normalized) } = {}) {
  if (isReadCommand(normalized)) {
    return { category: "read", runner: null, scope: "unknown", target: null, signature, classifier_version: CLASSIFIER_VERSION };
  }
  if (/\b(vitest|jest|playwright|pytest|mocha|ava)\b/.test(normalized) || /\btest(s)?\b/.test(normalized) || scriptName === "test" || /^test:/.test(scriptName || "")) {
    return {
      category: "test",
      runner: detectRunner(normalized),
      scope: detectTestScope(normalized, { scriptName }),
      target: safeTarget(normalized),
      signature,
      classifier_version: CLASSIFIER_VERSION,
    };
  }
  if (/\b(eslint|lint)\b/.test(normalized) || /^lint:/.test(scriptName || "")) {
    return { category: "lint", runner: detectRunner(normalized), scope: "unknown", target: null, signature, classifier_version: CLASSIFIER_VERSION };
  }
  if (/\b(tsc|typecheck|type-check)\b/.test(normalized)) {
    return { category: "typecheck", runner: detectRunner(normalized), scope: "unknown", target: null, signature, classifier_version: CLASSIFIER_VERSION };
  }
  if (/\b(build|webpack|vite build|rollup|tsup)\b/.test(normalized)) {
    return { category: "build", runner: detectRunner(normalized), scope: "unknown", target: null, signature, classifier_version: CLASSIFIER_VERSION };
  }
  if (/\b(prettier|format)\b/.test(normalized)) {
    return { category: "format", runner: detectRunner(normalized), scope: "unknown", target: null, signature, classifier_version: CLASSIFIER_VERSION };
  }
  if (/^(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b/.test(normalized) || /^pip\s+install\b/.test(normalized)) {
    return { category: "install", runner: detectRunner(normalized), scope: "unknown", target: null, signature, classifier_version: CLASSIFIER_VERSION };
  }
  if (/^git\s/.test(normalized)) {
    return { category: "git", runner: null, scope: "unknown", target: null, signature, classifier_version: CLASSIFIER_VERSION };
  }
  if (/\b(serve|dev|start)\b/.test(normalized) && /^(npm|pnpm|yarn|bun|node)\s/.test(normalized)) {
    return { category: "serve", runner: detectRunner(normalized), scope: "unknown", target: null, signature, classifier_version: CLASSIFIER_VERSION };
  }
  return unknownOperation();
}

function isReadCommand(normalized) {
  const [program] = normalized.split(" ");
  if (!READ_COMMANDS.has(program)) return false;
  if (program === "sed" && /\s-[a-zA-Z]*i/.test(normalized)) return false;
  if (program === "find" && /\s-(exec|execdir|delete|ok)\b/.test(normalized)) return false;
  return true;
}

function commandSignature(normalized) {
  return privacyHash(normalized);
}

// Failure-signature hashing for redundant-rerun detection (reruns
// whose failure signature did not change). Callers pass whatever privacy-safe failure text they already have
// (e.g. a bounded stderr tail) — this module never sees or stores raw output.
export function failureSignature(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const normalized = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  return privacyHash(normalized);
}
