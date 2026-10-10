import { privacyHash } from "./telemetry-schemas/hash.mjs";

// Pure semantic classification of a tool command into an operation category (test/lint/build/...)
// plus, for tests specifically, a runner and scope (targeted vs full). Deliberately has zero
// dependency on telemetry-capture.mjs's state/IO so it stays cheap enough to import from the hot
// capture path and to unit
// test in isolation.
//
// Store this version alongside every classification result so historical data stays interpretable
// if the rules change later (plan requirement: "store a rule/version identifier with the
// classification").
export const CLASSIFIER_VERSION = 1;

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
  const npmScriptName = extractNpmScriptInvocation(normalized);
  if (npmScriptName && packageScripts && Object.prototype.hasOwnProperty.call(packageScripts, npmScriptName)) {
    const scriptBody = packageScripts[npmScriptName];
    const fromScript = classifyNormalized(normalizeCommand(scriptBody), { scriptName: npmScriptName });
    if (fromScript.category !== "other") return fromScript;
  }
  return classifyNormalized(normalized, { scriptName: npmScriptName });
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

function classifyNormalized(normalized, { scriptName } = {}) {
  const signature = commandSignature(normalized);

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
