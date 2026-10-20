// Bounded append-only JSONL of Runtime transition events.
//
// Events are written only when something CHANGES, not once per scan, so volume is tiny — a busy
// machine produces a few dozen lines a day. That is why this is one shared file rather than a file
// per app or per repository: sharding would multiply the fiddly parts (atomic compaction, retention,
// size capping) across shards, and per-app shards would orphan themselves anyway, since
// disambiguateAssociationKeys can swap an app's associationKey to its titleKey mid-life.
//
// stateRoot is a parameter rather than an import from scripts/cli/state-paths.mjs, matching
// settingsPathFor in settings.mjs. That parameterization is what makes this module testable against
// a temp directory with no environment juggling.

import fs from "node:fs";
import path from "node:path";
import { measureLog } from "../retention/index.mjs";

export const HISTORY_EVENT_VERSION = 1;
export const HISTORY_EVENT_TYPES = [
  "firstSeen",
  "originChange",
  "healthTransition",
  "exposureChange",
  "duplicateChange",
  "inactive",
];

export const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
// Below this size, retention is not worth a full read on every append. The cap above is the hard
// safety net; this floor keeps the steady state at zero extra reads.
export const HISTORY_COMPACT_FLOOR_BYTES = 64 * 1024;
export const DEFAULT_RETENTION_DAYS = 14;

export function historyPathFor(stateRoot) {
  return path.join(stateRoot, "developer-runtime", "history.jsonl");
}

// Read every event, newest last. Unparseable lines are dropped silently, which is also how a
// truncated final line is tolerated: a partially-flushed last record simply fails JSON.parse and
// disappears until its newline lands.
//
// Deliberately NOT built on scripts/cli/jsonl-tail.mjs. readAppendedLines exists to make incremental
// tailing cheap for a long-lived reader that holds a byte cursor between calls (the telemetry spool).
// History is read whole, on demand, filtered by key — there is no cursor to hold, and inventing one
// to satisfy that signature would use the helper against its stated design.
export function readHistoryEvents({ stateRoot, fsApi = fs } = {}) {
  let raw;
  try {
    raw = fsApi.readFileSync(historyPathFor(stateRoot), "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split("\n")) {
    const event = parseEvent(line);
    if (event) events.push(event);
  }
  return events;
}

// Append a batch in a single write. This is the in-memory write queue: one
// refresh produces one array of events from diffSnapshots and flushes it in one syscall. A queue
// spanning refreshes would only add a flush-on-exit failure mode, since refreshes are already
// serialized by the inFlightRefresh guard in scripts/cli/developer-runtime.mjs.
//
// Never throws. History is an observability nicety; a full disk or a bad permission must not be able
// to break app discovery.
export function appendHistoryEvents(events, options = {}) {
  const { stateRoot, fsApi = fs, now = new Date(), retentionDays = DEFAULT_RETENTION_DAYS } = options;
  const valid = (events || []).filter(Boolean).map(normalizeEvent).filter(Boolean);
  if (!valid.length) return { written: 0, compacted: false };

  const filePath = historyPathFor(stateRoot);
  try {
    fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
    fsApi.appendFileSync(filePath, valid.map((event) => JSON.stringify(event)).join("\n") + "\n");
  } catch {
    return { written: 0, compacted: false };
  }
  return { written: valid.length, compacted: maybeCompact({ stateRoot, fsApi, now, retentionDays }) };
}

// Drop events past the retention window, then trim to the size cap if still oversized.
//
// The measurement — which events are stale and how many must go — comes from modules/retention,
// shared with the telemetry spool and every other bounded store. Only the commit is local, and it
// stays local deliberately: the rewrite is atomic (temp file + rename, following writeRegistry in
// modules/repositories/registry.mjs). Do NOT switch to capSpool's in-place writeFileSync from
// telemetry-capture.mjs — that is only safe because its reader detects the resulting shrink via byte
// offsets, which this reader has no way to notice.
// `floorBytes` skips the work on a file too small to be worth measuring. That gate belongs to the
// append path, which calls this on every write — a direct call is an explicit request to compact,
// so it applies the policy regardless of size. Passing floorBytes: 0 here is what keeps a small
// file's expired events from surviving a deliberate compaction.
export function compactHistory({
  stateRoot,
  fsApi = fs,
  now = new Date(),
  retentionDays = DEFAULT_RETENTION_DAYS,
  floorBytes = 0,
} = {}) {
  const filePath = historyPathFor(stateRoot);
  const policy = { ...policyFor(retentionDays), floorBytes };
  const verdict = measureLog({ filePath, policy, now, fsApi });
  if (!verdict.act) return false;

  const events = readHistoryEvents({ stateRoot, fsApi });
  if (!events.length) return false;

  // measureLog counts physical lines, including any that failed to parse; readHistoryEvents drops
  // those. Clamping keeps a corrupt line from shifting the cut into live events — the retained set
  // can only ever be too generous, never too small.
  const dropped = Math.min(verdict.dropCount, events.length - 1);
  const kept = events.slice(dropped);
  if (kept.length === events.length) return false;

  try {
    const dir = path.dirname(filePath);
    const temp = path.join(dir, `.history.${process.pid}.${Date.now()}.tmp`);
    fsApi.writeFileSync(temp, serialize(kept));
    fsApi.renameSync(temp, filePath);
    return true;
  } catch {
    return false;
  }
}

// retentionDays is a user preference (1-365) resolved by the caller; the byte cap and compaction
// floor are fixed. Mirrors the developer-runtime-history entry in modules/retention/registry.mjs, which
// declares the same numbers for reporting surfaces.
function policyFor(retentionDays) {
  return {
    maxAgeDays: Math.max(1, retentionDays),
    maxBytes: HISTORY_MAX_BYTES,
    floorBytes: HISTORY_COMPACT_FLOOR_BYTES,
    keepFraction: null,
  };
}

// The append path applies the compaction floor: below it, retention is not worth a stat's worth of
// follow-up on every write. measureLog does the rest of the ladder (cap check, then parse only the
// oldest record) internally, so the hand-rolled maybeCompact + oldestEventExpired pair this
// replaced is gone.
function maybeCompact({ stateRoot, fsApi, now, retentionDays }) {
  return compactHistory({
    stateRoot,
    fsApi,
    now,
    retentionDays,
    floorBytes: HISTORY_COMPACT_FLOOR_BYTES,
  });
}

function serialize(events) {
  return events.length ? events.map((event) => JSON.stringify(event)).join("\n") + "\n" : "";
}

function parseEvent(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return normalizeEvent(parsed);
}

// Minimal shape validation so a hand-edited file cannot inject arbitrary objects into an API
// response. Anything missing the three fields that make an event addressable is dropped.
function normalizeEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at))) return null;
  if (!HISTORY_EVENT_TYPES.includes(event.type)) return null;
  if (typeof event.associationKey !== "string" || !event.associationKey) return null;
  return {
    v: HISTORY_EVENT_VERSION,
    at: event.at,
    type: event.type,
    associationKey: event.associationKey,
    projectIdentity: stringOrNull(event.projectIdentity),
    appId: stringOrNull(event.appId),
    repositoryId: stringOrNull(event.repositoryId),
    rootId: stringOrNull(event.rootId),
    from: event.from ?? null,
    to: event.to ?? null,
    reason: stringOrNull(event.reason),
  };
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}
