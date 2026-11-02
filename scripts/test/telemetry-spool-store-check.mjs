#!/usr/bin/env node
// Guardrail for the incremental spool store (readSpoolEventsCached). Asserts it yields exactly the
// same parsed events as a fresh full re-read (readSpoolEvents) across the cases that matter:
//   - initial multi-file read
//   - an append of new events (the common case — only new bytes parsed)
//   - a partial trailing line completed by a later append (torn-write tolerance)
//   - a capSpool-style shrink/rewrite (offsets invalidated -> rebuild)
//   - a file removed (purge)
// Runs against a temp spool dir so it never touches real telemetry. Set before importing telemetry.mjs
// so state-paths resolves the temp dir.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spool-store-"));
process.env.ROBOREPO_STATE_ROOT = tmp;
const spoolDir = path.join(tmp, "telemetry", "spool");
fs.mkdirSync(spoolDir, { recursive: true });

// Import AFTER the env is set so telemetrySpoolDir resolves under tmp.
const { readSpoolEvents, readSpoolEventsCached, _resetSpoolStoreForTests } = await import(
  "../cli/telemetry.mjs"
);

let n = 0;
function rec(extra = {}) {
  n += 1;
  return JSON.stringify({ ts: new Date(2020, 0, 1, 0, 0, n).toISOString(), harness: "claude", event: "test", session_id: "s" + (n % 3), tokens: { total: n * 10 }, delta_tokens: n, ...extra });
}
function append(file, records) {
  fs.appendFileSync(path.join(spoolDir, file), records.map((r) => r + "\n").join(""));
}

// Compare by value: cached store vs a fresh full read of the same on-disk state.
function assertEqual(label) {
  const full = readSpoolEvents();
  const cached = readSpoolEventsCached();
  assert.equal(cached.length, full.length, `${label}: length (${cached.length} vs ${full.length})`);
  // Order can differ across files but within our single-file cases it must match; sort by ts+total
  // to be robust to multi-file interleave.
  const key = (e) => `${e.ts}|${e.tokens?.total}`;
  const s = (arr) => [...arr].sort((a, b) => key(a).localeCompare(key(b)));
  assert.deepEqual(s(cached), s(full), `${label}: contents`);
  console.log(`ok  ${label} (${cached.length} events)`);
}

try {
  // Case 1: two files, initial read.
  append("claude.jsonl", [rec(), rec(), rec()]);
  append("codex.jsonl", [rec({ harness: "codex" }), rec({ harness: "codex" })]);
  _resetSpoolStoreForTests();
  assertEqual("initial multi-file");

  // Case 2: append new events — cached path must pick them up incrementally.
  append("claude.jsonl", [rec(), rec()]);
  assertEqual("after append");

  // Case 3: partial trailing line (no newline), then completion. First sync must NOT parse it.
  const partial = rec();
  fs.appendFileSync(path.join(spoolDir, "claude.jsonl"), partial); // no "\n"
  const midLen = readSpoolEventsCached().length;
  const fullMid = readSpoolEvents().length; // full read also skips the unterminated line? it splits on \n and .trim() keeps it...
  // readSpoolEvents WILL parse the unterminated final line (valid JSON, just no newline). The store
  // holds it as remainder. So here they legitimately differ by 1 until the newline lands.
  assert.equal(midLen + 1, fullMid, `partial line held back by store (cached ${midLen}, full ${fullMid})`);
  console.log(`ok  partial trailing line held (cached ${midLen}, full ${fullMid})`);
  fs.appendFileSync(path.join(spoolDir, "claude.jsonl"), "\n"); // complete the line
  assertEqual("after completing partial line");

  // Case 4: capSpool-style shrink — rewrite claude.jsonl smaller. Store must rebuild.
  const kept = fs.readFileSync(path.join(spoolDir, "claude.jsonl"), "utf8").trim().split("\n").slice(-2);
  fs.writeFileSync(path.join(spoolDir, "claude.jsonl"), kept.join("\n") + "\n");
  assertEqual("after capSpool shrink");

  // Case 5: remove a file (purge of one harness).
  fs.rmSync(path.join(spoolDir, "codex.jsonl"));
  assertEqual("after file removal");

  console.log("\nspool store checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
