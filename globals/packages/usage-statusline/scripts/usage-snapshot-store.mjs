// Latest-snapshot persistence for non-CLI consumers (the future portal homepage). This module runs
// in TWO places: imported by the CLI/portal, and copied into ~/.roborepo/package-runtime/ as part of the
// installed Claude status-line command. So it CANNOT import scripts/cli/state-paths.mjs (that path
// does not exist beside the copied package-runtime asset) — it resolves the state dir itself, with the same
// env precedence as scripts/cli/paths.mjs (ROBOREPO_STATE_ROOT > ~/.roborepo).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const FRESH_MAX_MS = 2 * 60 * 1000; // fresh: <= 2 min old; stale: older but readable (plan)
const FILE_MODE = 0o600; // user-only: snapshots are machine-local usage data
const MIN_WRITE_INTERVAL_MS = 5000; // bound Claude's high-frequency invocation (plan risk mitigation)

function stateRoot() {
  return (
    process.env.ROBOREPO_STATE_ROOT ||
    path.join(os.homedir(), ".roborepo")
  );
}

function latestPath(harness) {
  return path.join(stateRoot(), "usage", "latest", `${harness}.json`);
}

// Timestamps live as epoch-ms inside the snapshot for calculation but are stored as ISO strings (the
// plan's on-disk contract). Both directions touch exactly the same fields — collectedAt and each
// window's resetsAt — so one helper maps them through a converter, and toWire/fromWire just supply
// the direction. Keeping the ISO<->epoch contract in one module means no consumer re-implements it.
function mapTimestamps(snapshot, convert) {
  const next = { ...snapshot, collectedAt: convert(snapshot.collectedAt) };
  if (snapshot.windows) {
    next.windows = Object.fromEntries(
      Object.entries(snapshot.windows).map(([name, window]) => {
        const w = { ...window };
        if (window.resetsAt !== undefined) w.resetsAt = convert(window.resetsAt);
        return [name, w];
      }),
    );
  }
  return next;
}

const toWire = (snapshot) => mapTimestamps(snapshot, (v) => new Date(v).toISOString());
const fromWire = (wire) => mapTimestamps(wire, (v) => Date.parse(v));

// Serialized identity for dedup — everything except collectedAt, so an unchanged usage picture does
// not rewrite the file every render.
function identity(wire) {
  const { collectedAt, ...rest } = wire;
  return JSON.stringify(rest);
}

// Skip a write only when the usage picture is unchanged AND the file was written very recently. The
// recency check uses the file's real mtime (wall-clock write time), not the snapshot's semantic
// collectedAt — collectedAt may be a caller-supplied/fixed time, which would make the interval
// meaningless. This bounds Claude's high-frequency invocation without ever suppressing a real change.
function shouldSkipWrite(destPath, wire) {
  try {
    const existing = JSON.parse(fs.readFileSync(destPath, "utf8"));
    if (identity(existing) !== identity(wire)) return false;
    const ageMs = Date.now() - fs.statSync(destPath).mtimeMs;
    return Number.isFinite(ageMs) && ageMs < MIN_WRITE_INTERVAL_MS;
  } catch {
    return false;
  }
}

// Best-effort atomic write. Returns true if written, false if skipped/failed — callers ignore the
// result; a failed persist must never break the status line. Never logs raw input on failure.
export function writeLatestSnapshot(harness, snapshot) {
  try {
    const wire = toWire(snapshot);
    const destPath = latestPath(harness);
    if (shouldSkipWrite(destPath, wire)) return false;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmp = `${destPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(wire, null, 2)}\n`, { mode: FILE_MODE });
    fs.renameSync(tmp, destPath); // same-dir rename is atomic; isolates by harness so writes never collide
    return true;
  } catch {
    return false;
  }
}

function classifyFreshness(ageMs) {
  if (!Number.isFinite(ageMs)) return "unavailable";
  return ageMs <= FRESH_MAX_MS ? "fresh" : "stale";
}

// Read the persisted snapshot plus freshness metadata. Never throws — a missing or corrupt file
// yields { available: false } so the portal can render "not collected" instead of crashing. The
// returned snapshot is in the same epoch-ms form the domain layer expects (ISO is only the on-disk
// shape), so consumers assess it directly without re-parsing timestamps.
export function readLatestSnapshot(harness, { now = Date.now() } = {}) {
  let wire;
  try {
    wire = JSON.parse(fs.readFileSync(latestPath(harness), "utf8"));
  } catch {
    return { available: false, reason: "not-collected" };
  }
  const snapshot = fromWire(wire);
  const ageMs = now - snapshot.collectedAt;
  const state = classifyFreshness(ageMs);
  if (state === "unavailable") return { available: false, reason: "invalid" };
  return { available: true, snapshot, freshness: { state, ageMs } };
}
