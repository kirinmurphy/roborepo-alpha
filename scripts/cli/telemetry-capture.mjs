import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { telemetryCollectorDir, telemetryDir, telemetrySpoolDir } from "./state-paths.mjs";
import { measureLog } from "../../modules/retention/index.mjs";
// Direct leaf-module import, not getHarnessProvider(...).adapters.transcripts.parse: this hot
// PreToolUse/PostToolUse path must not pay to load either provider's full adapter module (root
// config, permissions, MCP, etc.) just to append one JSONL line. The registry dispatch is for
// on-demand callers (portal session drill-down) that already pay for a heavier import graph.
import { mcpServerOf, transcriptStats } from "../harnesses/transcript-parse.mjs";
import { classifyCommand, failureSignature } from "./telemetry-classify.mjs";
import { generateCaptureId } from "./telemetry-schemas/capture-schema-v3.mjs";
import { privacyHash } from "./telemetry-schemas/hash.mjs";
import { inferPhase } from "./telemetry-phase-infer.mjs";
import { categorizeFile } from "./telemetry-task-infer.mjs";
import { normalizeGitRemote, localRepositoryIdForRoot } from "../../modules/repositories/index.mjs";

// Minimal-import capture path, split out of telemetry.mjs so the hot hook (fires on every
// PreToolUse/PostToolUse) doesn't pay to load portal-server/config/presets/telemetry-analyze/
// telemetry-insights just to append one JSONL line. Keep this file's import graph small.
// telemetry-classify.mjs is a pure, dependency-free module (no fs/config imports) so it stays
// cheap enough to import here unconditionally; the config-snapshot builder is NOT imported here —
// see resolveConfigSnapshotId() below, which dynamic-imports config.mjs only on SessionStart.

const SCHEMA_VERSION = 3;

export async function telemetryCaptureCommand(args) {
  const options = parseCaptureArgs(args);
  const state = readTelemetryState();
  if (state.enabled !== true) return;
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf8");
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const sessionId = input.session_id || input.conversation_id || null;
  const transcriptPath = input.transcript_path || input.transcriptPath || null;
  const stats = transcriptStats(transcriptPath, { sessionId, collectorDir: telemetryCollectorDir });
  const event = options.event || input.hook_event_name || input.hookEventName || "unknown";
  const tool = toolMetadata(input);
  // Raw command text never leaves this function scope — classifyCommand() only returns a
  // category/runner/scope/signature-hash, never the command itself, matching the same
  // hash-don't-store discipline as command_hash above.
  const rawCommand = typeof (input.tool_input || input.toolInput || {}).command === "string" ? (input.tool_input || input.toolInput).command : null;
  let operation = rawCommand ? classifyCommand(rawCommand) : null;
  // Exit status/failure signature are only knowable once the tool result is back (PostToolUse), and
  // only for Bash-classified operations — a passing/failing test's transcript result is this
  // operation's outcome. stats.last_result is transcript-derived and best-effort: a PostToolUse whose
  // transcript chunk hasn't caught up yet (rare, but possible under fast successive hooks) leaves
  // exit_status/failure_signature null rather than guessing.
  if (operation && event === "PostToolUse" && stats?.last_result && stats.last_result.tool === tool.name) {
    operation = {
      ...operation,
      exit_status: stats.last_result.is_error ? "fail" : "pass",
      failure_signature: stats.last_result.is_error ? failureSignature(stats.last_result_failure_text) : null,
    };
  }
  const callId = resolveCallId(input, sessionId, tool.name, event);
  const activity = updateSessionActivity(sessionId, event, tool, operation, cwd);
  const record = {
    schema: SCHEMA_VERSION,
    capture_id: generateCaptureId(),
    call_id: callId,
    ts: new Date().toISOString(),
    harness: options.harness,
    event,
    session_id: sessionId,
    cwd_hash: hash(cwd),
    // Trailing path segment of the working dir — orients "where" without exposing the full path
    // (which stays hashed in cwd_hash).
    cwd_name: path.basename(cwd),
    repo: repoMetadata(cwd),
    tool,
    // Wall-clock tool latency: PreToolUse stamps a start cursor keyed by call_id, PostToolUse reads
    // it back by the same call_id. Null for non-tool events or an unmatched pair. call_id (rather
    // than session alone) keeps concurrent/nested tool calls in the same session from clobbering
    // each other's cursor.
    duration_ms: toolDuration(event, callId),
    config_snapshot_id: await resolveConfigSnapshotId(event, sessionId, options.harness, stats),
    operation,
    // Explicit phase markers (`telemetry mark --type phase`) are read at analysis time and
    // take precedence from their timestamp forward — this capture-time field is always the inferred
    // reading from this session's accumulated activity signals, never a lookup against markers (that
    // would require importing marker persistence into the hot path, which capture's performance
    // budget rules out).
    phase: activity ? inferPhase(activity.phaseSignals) : null,
    intervening: activity ? activity.intervening : null,
    prompt: promptMetadata(input),
    tokens: stats ? stats.tokens : null,
    delta_tokens: stats ? deltaTokens(sessionId, stats.tokens.total) : null,
    session: stats
      ? {
          model: stats.model,
          assistant_turns: stats.assistant_turns,
          tool_calls: stats.tool_calls,
          mcp_calls: stats.mcp_calls,
          max_output_tokens: stats.max_output_tokens,
        }
      : null,
    details: stats ? stats.details : null,
    // Likely driver of this capture's delta (freshest tool result to enter context) and the
    // heaviest result seen all session. Sizes/tool names only — no result content is stored.
    last_result: stats ? stats.last_result : null,
    biggest_result: stats ? stats.biggest_result : null,
  };
  ensureTelemetryDirs();
  const spoolFile = path.join(telemetrySpoolDir, `${options.harness}.jsonl`);
  fs.appendFileSync(spoolFile, JSON.stringify(record) + "\n");
  capSpool(spoolFile);
}

// Spool files are append-only and grow forever otherwise. Cap each harness file so an enabled,
// long-lived install can't fill the disk: when it exceeds SPOOL_MAX_BYTES, drop the oldest lines and
// keep the newest tail (records are chronological).
//
// No age dimension: nothing drains the spool (both readers in scripts/cli/telemetry.mjs are
// read-only, and only `telemetry purge --all` deletes), so it is the durable store rather than a
// buffer, and an old record is not stale. Bytes are the only meaningful bound.
//
// Measurement comes from modules/retention, shared with developer-runtime history. The commit stays here
// and stays in-place: jsonl-tail.mjs holds a byte offset between calls and detects this shrink to
// rebuild. An atomic rename — correct for history, whose reader reads whole files — would break
// that cursor.
const SPOOL_MAX_BYTES = 25 * 1024 * 1024; // ~25 MB per harness (tens of thousands of records)
const SPOOL_KEEP_FRACTION = 0.7; // on trim, keep the newest ~70% so trims are infrequent
const SPOOL_POLICY = {
  maxAgeDays: null,
  maxBytes: SPOOL_MAX_BYTES,
  floorBytes: 0,
  keepFraction: SPOOL_KEEP_FRACTION,
};

function capSpool(spoolFile) {
  const verdict = measureLog({ filePath: spoolFile, policy: SPOOL_POLICY });
  if (!verdict.act) return;
  try {
    const lines = fs.readFileSync(spoolFile, "utf8").split("\n").filter((l) => l.trim());
    const keep = lines.slice(Math.min(verdict.dropCount, lines.length - 1));
    fs.writeFileSync(spoolFile, keep.join("\n") + "\n");
  } catch {
    // Best-effort: a failed trim just means the file stays large until the next successful capture.
  }
}

function ensureTelemetryDirs() {
  fs.mkdirSync(telemetrySpoolDir, { recursive: true });
  fs.mkdirSync(telemetryCollectorDir, { recursive: true });
}

function telemetryStatePath() {
  return `${telemetryDir}/state.json`;
}

function readTelemetryState() {
  try {
    return JSON.parse(fs.readFileSync(telemetryStatePath(), "utf8"));
  } catch {
    return { enabled: false };
  }
}

function parseCaptureArgs(args) {
  const options = { harness: "unknown", event: "" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--harness") {
      options.harness = args[++i] || "unknown";
    } else if (arg.startsWith("--harness=")) {
      options.harness = arg.slice("--harness=".length);
    } else if (arg === "--event") {
      options.event = args[++i] || "";
    } else if (arg.startsWith("--event=")) {
      options.event = arg.slice("--event=".length);
    }
  }
  return options;
}

// Cache repo metadata by cwd for the life of the capture process. A single capture resolves one
// cwd, but the cache keeps the capture path cheap if that ever changes and documents intent (doc
// §Telemetry capture: "cache working-directory-to-repository resolution").
const repoMetadataCache = new Map();

function repoMetadata(cwd) {
  if (repoMetadataCache.has(cwd)) return repoMetadataCache.get(cwd);
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const remote = git(cwd, ["remote", "get-url", "origin"]);
  const sha = git(cwd, ["rev-parse", "--short", "HEAD"]);

  // Canonical, cross-domain repository reference. Normalizing the remote BEFORE hashing means
  // equivalent SSH and HTTPS remotes produce the same normalized_remote_hash and the same
  // repository_id — the correlation the legacy raw remote_hash could never provide. repository_id
  // is credential- and path-free (git: id, or an opaque local: id derived from the root), so it is
  // safe to store in the clear. Legacy git_root_hash/remote_hash stay for the migration window.
  // The local: id realpaths the root so it agrees with resolveProjectIdentity (Runtime/Plans)
  // for symlinked repos. The legacy git_root_hash below stays on the RAW toplevel for back-compat.
  const normalizedRemote = remote ? normalizeGitRemote(remote) : null;
  const repositoryId = normalizedRemote || (root ? localRepositoryIdForRoot(root) : null);

  const result = {
    label: root ? path.basename(root) : path.basename(cwd),
    repository_id: repositoryId,
    normalized_remote_hash: normalizedRemote ? hash(normalizedRemote) : null,
    git_root_hash: root ? hash(root) : null,
    remote_hash: remote ? hash(remote) : null,
    branch: branch || null,
    // Short SHA correlates a spike to the code state it happened on; safe to keep in the clear.
    sha: sha || null,
  };
  repoMetadataCache.set(cwd, result);
  return result;
}

// Tool names whose PostToolUse counts as an "edit completed" for phase inference and intervening-work
// tracking. Kept to the tools that mutate repo files —
// Read/Grep/Glob-shaped tools are discovery signals, not edits.
const EDIT_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOL_NAMES = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);

function sessionActivityPath(sessionId) {
  return path.join(telemetryCollectorDir, `activity-${hash(sessionId)}.json`);
}

function emptySessionActivity() {
  return {
    editCount: 0,
    readCount: 0,
    testFailureStreak: 0,
    editSinceLastFailure: false,
    broadCheckRan: false,
    finalizationSignals: false,
    changedFileCategories: [],
    changedFileCount: 0,
    lastDiffFingerprint: null,
    targetedTestRanSinceLastFull: false,
    lastFailureSignature: null,
  };
}

// Session-scoped activity state, read-modify-written on every PostToolUse (the point at which we
// know a tool actually completed, and — for test operations — whether it passed or failed). Feeds
// both phase inference (telemetry-phase-infer.mjs) and the per-capture `intervening` field (plan:
// "Intervening-work analysis"). Best-effort throughout: a cursor read/write failure degrades to an
// empty/stale activity view rather than failing the capture.
function updateSessionActivity(sessionId, event, tool, operation, cwd) {
  if (!sessionId) return null;
  const cursorPath = sessionActivityPath(sessionId);
  let activity = emptySessionActivity();
  try {
    activity = { ...activity, ...JSON.parse(fs.readFileSync(cursorPath, "utf8")) };
  } catch {
    // First activity this session, or a corrupt/missing cursor — start fresh.
  }

  if (event === "PostToolUse") {
    const isEdit = EDIT_TOOL_NAMES.has(tool.name);
    const isRead = READ_TOOL_NAMES.has(tool.name);
    const fileTouched = isEdit && tool.file_ext != null;

    if (isEdit) {
      activity.editCount += 1;
      activity.editSinceLastFailure = activity.testFailureStreak > 0 ? true : activity.editSinceLastFailure;
    }
    if (isRead) activity.readCount += 1;
    if (fileTouched) {
      const category = categorizeFile(tool.file_ext);
      activity.changedFileCategories = dedupe([...activity.changedFileCategories, category]);
      activity.changedFileCount += 1;
    }

    if (operation) {
      const isTestLike = operation.category === "test" || operation.category === "lint" || operation.category === "typecheck";
      if (isTestLike) {
        if (operation.exit_status === "fail") {
          const changed = operation.failure_signature && operation.failure_signature !== activity.lastFailureSignature;
          activity.testFailureStreak += 1;
          activity.lastFailureSignature = operation.failure_signature ?? activity.lastFailureSignature;
          activity._failureSignatureChanged = Boolean(changed);
        } else if (operation.exit_status === "pass") {
          activity.testFailureStreak = 0;
          activity.editSinceLastFailure = false;
          activity._failureSignatureChanged = false;
        } else {
          activity._failureSignatureChanged = false;
        }
        if (operation.scope === "full") {
          activity.broadCheckRan = true;
          activity._targetedSinceLastFull = activity.targetedTestRanSinceLastFull;
          activity.targetedTestRanSinceLastFull = false;
        } else if (operation.scope === "targeted" || operation.scope === "affected") {
          activity.targetedTestRanSinceLastFull = true;
          activity._targetedSinceLastFull = true;
        } else {
          activity._targetedSinceLastFull = activity.targetedTestRanSinceLastFull;
        }
      } else {
        activity._targetedSinceLastFull = activity.targetedTestRanSinceLastFull;
        activity._failureSignatureChanged = false;
      }
      if (operation.category === "git" || /\bcommit\b/.test(operation.signature || "")) {
        activity.finalizationSignals = true;
      }
    } else {
      activity._targetedSinceLastFull = activity.targetedTestRanSinceLastFull;
      activity._failureSignatureChanged = false;
    }
  } else {
    activity._targetedSinceLastFull = activity.targetedTestRanSinceLastFull;
    activity._failureSignatureChanged = false;
  }

  const diffFingerprint = gitDiffFingerprint(cwd);
  const diffChanged = diffFingerprint != null && diffFingerprint !== activity.lastDiffFingerprint;
  const editSinceLastTest = activity.editCount > 0 && (activity.testFailureStreak > 0 || diffChanged);
  const priorDiffFingerprint = activity.lastDiffFingerprint;
  activity.lastDiffFingerprint = diffFingerprint ?? activity.lastDiffFingerprint;

  const intervening = {
    edit_since_last_test: editSinceLastTest,
    changed_file_count: activity.changedFileCount,
    changed_file_categories: activity.changedFileCategories,
    diff_fingerprint: diffFingerprint,
    diff_fingerprint_changed: priorDiffFingerprint != null && diffFingerprint != null ? diffFingerprint !== priorDiffFingerprint : false,
    targeted_test_ran_since_last_full: activity._targetedSinceLastFull ?? activity.targetedTestRanSinceLastFull,
    failure_signature_changed: activity._failureSignatureChanged ?? false,
  };

  const phaseSignals = {
    editCount: activity.editCount,
    readCount: activity.readCount,
    lastTestOperation: operation && event === "PostToolUse" ? operation : null,
    testFailureStreak: activity.testFailureStreak,
    editSinceLastFailure: activity.editSinceLastFailure,
    broadCheckRan: activity.broadCheckRan,
    finalizationSignals: activity.finalizationSignals,
  };

  try {
    fs.mkdirSync(telemetryCollectorDir, { recursive: true });
    const { _failureSignatureChanged, _targetedSinceLastFull, ...persisted } = activity;
    fs.writeFileSync(cursorPath, JSON.stringify(persisted));
  } catch {
    // Best-effort; a failed write just means the next call rebuilds from an empty/stale cursor.
  }

  return { intervening, phaseSignals };
}

function dedupe(values) {
  return [...new Set(values)];
}

// Content-addressed fingerprint of the working tree's current diff shape — a hash, never the diff
// text itself. `git diff --stat` names/sizes changed
// files without their content, which is enough to detect "something changed" without persisting any
// source text. Returns null (not thrown) when cwd isn't a git repo or git is unavailable.
function gitDiffFingerprint(cwd) {
  const diffStat = git(cwd, ["diff", "--stat", "HEAD"]);
  if (!diffStat) return null;
  return hash(diffStat);
}

function toolMetadata(input) {
  const toolInput = input.tool_input || input.toolInput || {};
  const name = input.tool_name || input.toolName || input.tool || null;
  const command = typeof toolInput.command === "string" ? toolInput.command : null;
  const mcpServer = mcpServerOf(name);
  // For MCP tools the wire name is `mcp__<server>__<tool>`; expose the bare tool so the dashboard
  // can attribute spikes to a specific call (e.g. get_context_bundle) instead of just the server.
  const mcpTool = mcpServer && typeof name === "string" ? name.split("__").slice(2).join("__") || null : null;
  // File path of a Read/Write/Edit-style tool, if any. Path itself is content-sensitive so it is
  // hashed; only the extension is kept in the clear — enough to say "spikes come from .jsonl reads".
  const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : typeof toolInput.path === "string" ? toolInput.path : null;
  return {
    name,
    is_mcp: mcpServer !== null,
    mcp_server: mcpServer,
    mcp_tool: mcpTool,
    command_hash: command ? hash(command) : null,
    command_chars: command ? command.length : 0,
    command_lines: command ? command.split("\n").length : 0,
    file_ext: filePath ? fileExt(filePath) : null,
    file_path_hash: filePath ? hash(filePath) : null,
  };
}

// Lowercase extension without the dot, or null. Used as a clear-text spike dimension while the full
// path stays hashed.
function fileExt(filePath) {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return ext || null;
}

// Max characters of a user prompt kept in the clear. Enough to identify what a session was about
// ("fix the telemetry dashboard alignment") without storing whole pasted blocks. The full prompt is
// never stored — only this leading slice plus a hash for dedup/length.
const PROMPT_PREVIEW_CHARS = 200;

function promptMetadata(input) {
  const prompt = typeof input.prompt === "string" ? input.prompt : typeof input.user_prompt === "string" ? input.user_prompt : null;
  return {
    chars: prompt ? prompt.length : 0,
    hash: prompt ? hash(prompt) : null,
    // Single-line leading slice so sessions are identifiable in the dashboard. Newlines collapsed so
    // it renders as one tidy title; truncation marked with an ellipsis.
    preview: prompt ? promptPreview(prompt) : null,
  };
}

function promptPreview(prompt) {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > PROMPT_PREVIEW_CHARS ? oneLine.slice(0, PROMPT_PREVIEW_CHARS) + "…" : oneLine;
}

// Tokens consumed since the previous capture in the same session — the spike signal. Transcript
// totals are cumulative, so the per-capture delta is what distinguishes a heavy turn from a quiet
// one. Cursors live in the collector dir keyed by session; a missing/new session yields the full
// total as its first delta.
function deltaTokens(sessionId, cumulativeTotal) {
  if (!sessionId || typeof cumulativeTotal !== "number") return null;
  const cursorPath = path.join(telemetryCollectorDir, `cursor-${hash(sessionId)}.json`);
  let previous = 0;
  try {
    previous = JSON.parse(fs.readFileSync(cursorPath, "utf8")).total || 0;
  } catch {
    previous = 0;
  }
  try {
    fs.writeFileSync(cursorPath, JSON.stringify({ total: cumulativeTotal }));
  } catch {
    // Cursor write is best-effort; a failure just means the next delta restarts from this point.
  }
  return Math.max(0, cumulativeTotal - previous);
}

// Wall-clock latency of a single tool call. PreToolUse writes a start stamp into a cursor keyed by
// call_id; PostToolUse reads and clears it by the same call_id, returning the elapsed ms.
// Best-effort: a missing start (hook race, restart) yields null rather than a bogus duration.
//
// Keyed by call_id (not session alone) so nested/concurrent tool calls within one session cannot
// clobber each other's cursor. With a session-only cursor, a second tool starting before the first
// one's PostToolUse fired would silently overwrite the first call's start stamp.
function toolDuration(event, callId) {
  if (!callId) return null;
  const cursorPath = path.join(telemetryCollectorDir, `tool-${hash(callId)}.json`);
  if (event === "PreToolUse") {
    try {
      fs.writeFileSync(cursorPath, JSON.stringify({ start: Date.now() }));
    } catch {
      // Best-effort; a failed write just means the matching PostToolUse reports null.
    }
    return null;
  }
  if (event === "PostToolUse") {
    let start = null;
    try {
      start = JSON.parse(fs.readFileSync(cursorPath, "utf8")).start;
      fs.rmSync(cursorPath, { force: true });
    } catch {
      return null;
    }
    return typeof start === "number" ? Math.max(0, Date.now() - start) : null;
  }
  return null;
}

// Prefer a harness-provided tool-use id (Claude: tool_use_id on PostToolUse payloads; Codex
// transcripts key tool calls by call_id). When the harness
// doesn't supply one on this hook's stdin (observed to happen on PreToolUse for some harness
// versions, or when a harness omits it entirely), derive a best-effort id from session, tool name,
// and an incrementing per-session-per-tool cursor. Two back-to-back calls to the *same* tool in the *same* session without a harness id
// would otherwise collide; the cursor makes each one unique.
function resolveCallId(input, sessionId, toolName, event) {
  const harnessId = input.tool_use_id || input.toolUseId || input.call_id || input.callId || null;
  if (typeof harnessId === "string" && harnessId) return harnessId;
  if (!sessionId || !toolName) return null;
  return derivedCallId(sessionId, toolName, event);
}

// Best-effort derived id: session+tool share a small counter file so repeated calls to the same
// tool in the same session get distinct ids. PreToolUse advances the counter and stamps it;
// PostToolUse reads the same counter value back without advancing, so a Pre/Post pair for the same
// invocation agrees on one id (matching how toolDuration() expects Pre to write and Post to read
// the same cursor key).
function derivedCallId(sessionId, toolName, event) {
  const counterPath = path.join(telemetryCollectorDir, `callseq-${hash(`${sessionId}:${toolName}`)}.json`);
  let counter = 0;
  try {
    counter = JSON.parse(fs.readFileSync(counterPath, "utf8")).counter || 0;
  } catch {
    counter = 0;
  }
  if (event === "PreToolUse") {
    counter += 1;
    try {
      fs.writeFileSync(counterPath, JSON.stringify({ counter }));
    } catch {
      // Best-effort; worst case PostToolUse derives the same stale counter value, still unique
      // enough to avoid colliding with a *different* tool's cursor.
    }
  }
  return `derived_${hash(`${sessionId}:${toolName}:${counter}`)}`;
}

// Effective-configuration snapshot for this session. Built once on SessionStart (dynamic-importing
// config.mjs's heavier readConfigSnapshot()/buildEffectiveSnapshot() only for that one event, to
// keep the hot capture import graph small) and cached in the session
// cursor dir; every later event in the same session reads the cached id back for free. Best-effort
// throughout — a session with no cached snapshot (e.g. telemetry enabled mid-session, or a
// telemetry-only install where config.mjs's dependencies aren't installed) reports null rather than
// failing the capture.
async function resolveConfigSnapshotId(event, sessionId, harness, stats) {
  if (!sessionId) return null;
  const cachePath = path.join(telemetryCollectorDir, `snapshot-${hash(`${harness}:${sessionId}`)}.json`);
  if (event === "SessionStart") {
    try {
      const snapshotId = await buildAndCacheSnapshot(harness, stats?.model ?? null);
      if (snapshotId) fs.writeFileSync(cachePath, JSON.stringify({ snapshot_id: snapshotId }));
      return snapshotId;
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8")).snapshot_id ?? null;
  } catch {
    return null;
  }
}

// Dynamic import (not a top-level one) is the whole point here: config.mjs pulls in
// package-catalog/skill-inventory/rules-render/etc., which is exactly the import weight the hot
// PreToolUse/PostToolUse path must not pay. Only SessionStart (once per session) takes it.
async function buildAndCacheSnapshot(harness, model) {
  const [{ readConfigSnapshot }, { buildEffectiveSnapshot }, { readPackageVersion }, { writeSnapshot }] = await Promise.all([
    import("./config.mjs"),
    import("./telemetry-schemas/snapshot-schema.mjs"),
    import("./workspace.mjs"),
    import("./telemetry-schemas/persistence.mjs"),
  ]);
  const configSnapshot = readConfigSnapshot();
  const snapshot = buildEffectiveSnapshot(configSnapshot, {
    harness,
    model,
    appVersion: readPackageVersion(),
  });
  writeSnapshot(snapshot);
  return snapshot.snapshot_id;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : "";
}

// The algorithm now lives in telemetry-schemas/hash.mjs, shared with every module that has to
// produce a matching value; the local name is kept so the call sites below read unchanged. That
// module imports node:crypto and nothing else, so this file's minimal-import constraint holds.
function hash(value) {
  return privacyHash(value);
}
