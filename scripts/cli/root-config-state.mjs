import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { rootConfigStatePath, readJsonState, writeJsonState } from "./state-paths.mjs";
import { isMainModule } from "./roots.mjs";

// Tracks a content hash of root config files (Claude settings.json, Codex config.toml) as of the
// last time roborepo itself wrote them. This is a drift check, not a merge: it answers "has
// anything touched this file since we last wrote it," never "which parts of the difference are
// safe to keep."

export function hashContent(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function hashFile(filePath) {
  try {
    return hashContent(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

const EMPTY_STATE = { version: 1, harnesses: {} };

export function readState() {
  return readJsonState(rootConfigStatePath, EMPTY_STATE);
}

export function writeState(state) {
  writeJsonState(rootConfigStatePath, state);
}

// Record the hash of what roborepo just wrote for a harness's root config path. Accepts an
// optional pre-computed hash so a caller that already ran checkDrift for this same file doesn't
// pay for a second rehash of the same content (a state object passed via checkDrift's result is
// intentionally NOT reused here — see the re-read below).
//
// Re-reads state immediately before merging, rather than reusing a possibly-stale state object
// passed in from an earlier checkDrift call, and only ever assigns this harness's own key. Two
// processes recording different harnesses concurrently (e.g. a user manually parallelizing two
// install-harness.sh invocations for different harness ids) can still interleave their
// read-modify-write, but each only ever overwrites its own harness's key with its own freshly-read
// view of the rest of the object, narrowing (not eliminating) the clobber window inherent to a
// lock-free JSON file.
export function recordWrite(harness, filePath, precomputed = {}) {
  const hash = precomputed.hash ?? hashFile(filePath);
  if (hash === null) return;
  const state = readState();
  state.harnesses[harness] = { path: filePath, hash, writtenAt: new Date().toISOString() };
  writeState(state);
}

// Compare the current file against the last hash roborepo recorded for this harness.
//
// Returns one of:
//   "unwritten" — roborepo has never recorded a write for this harness (first install, or state
//                 predates this mechanism). Callers should fall back to existing collision handling.
//   "missing"   — the file no longer exists on disk.
//   "clean"     — the file still matches what roborepo last wrote; safe to regenerate.
//   "drifted"   — something else changed the file since roborepo's last write.
//
// The returned object always carries `state` (the already-parsed state object) so a caller that
// goes on to call recordWrite for the same file can pass it straight through instead of re-reading.
export function checkDrift(harness, filePath) {
  const state = readState();
  const recorded = state.harnesses[harness];
  if (!recorded) return { status: "unwritten", state };
  const currentHash = hashFile(filePath);
  if (currentHash === null) return { status: "missing", lastHash: recorded.hash, state };
  if (currentHash === recorded.hash) return { status: "clean", lastHash: recorded.hash, currentHash, state };
  return { status: "drifted", lastHash: recorded.hash, currentHash, state };
}

// CLI entry point so the bash install scripts (install-lib.sh) can share this exact drift check
// instead of reimplementing hash comparison in bash. Prints only the status word to stdout; bash
// call sites branch on that string.
//
//   node root-config-state.mjs check  <harness> <path>   -> prints: unwritten|missing|clean|drifted
//   node root-config-state.mjs record <harness> <path>   -> records the hash, prints nothing
if (isMainModule(import.meta.url)) {
  const [cmd, harness, filePath] = process.argv.slice(2);
  if (cmd === "check" && harness && filePath) {
    console.log(checkDrift(harness, filePath).status);
  } else if (cmd === "record" && harness && filePath) {
    recordWrite(harness, filePath);
  } else {
    console.error("usage: node root-config-state.mjs check|record <harness> <path>");
    process.exit(2);
  }
}
