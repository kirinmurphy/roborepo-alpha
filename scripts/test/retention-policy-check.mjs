#!/usr/bin/env node
// The shared retention engine: policy validation, append-log measurement (including the cheap gate
// that avoids a full read), file-set measurement, and the registry's bounded-store guarantee.
//
// The engine only measures. Every assertion here is about the verdict it returns, never about a
// file it wrote, because writing stays with each store — see modules/retention/policy.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FILE_SET_SHAPE,
  LOG_SHAPE,
  assertBounded,
  describeFileSet,
  dropCountForBytes,
  findRetentionStore,
  measureFileSet,
  measureLog,
  normalizePolicy,
  retentionStores,
} from "../../modules/retention/index.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-retention-"));
const NOW = new Date("2026-01-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

try {
  // ---- Policy validation ----
  // A typo'd cap that silently became 0 would delete everything, so bad values throw rather than coerce.
  assert.throws(() => normalizePolicy({ maxBytes: 0 }), /maxBytes/, "zero cap is rejected");
  assert.throws(() => normalizePolicy({ maxAgeDays: -1 }), /maxAgeDays/, "negative age is rejected");
  assert.throws(() => normalizePolicy({ keepFraction: 1 }), /keepFraction/, "keepFraction must be below 1");
  assert.throws(() => normalizePolicy({ floorBytes: -1 }), /floorBytes/, "negative floor is rejected");

  const unbounded = normalizePolicy({});
  assert.equal(unbounded.maxBytes, null, "an empty policy means unbounded, not zero");
  assert.equal(unbounded.floorBytes, 0);

  // ---- dropCountForBytes ----
  const lengths = [10, 10, 10, 10];
  assert.equal(dropCountForBytes(lengths, 40, normalizePolicy({ maxBytes: 100 })), 0, "under cap drops nothing");
  assert.equal(dropCountForBytes(lengths, 40, normalizePolicy({ maxBytes: 25 })), 2, "drops the oldest until it fits");
  // keepFraction overshoots deliberately so the next append does not immediately re-trip the cap.
  assert.equal(
    dropCountForBytes(lengths, 40, normalizePolicy({ maxBytes: 30, keepFraction: 0.5 })),
    3,
    "keepFraction trims further than the bare minimum",
  );
  assert.equal(
    dropCountForBytes([100], 100, normalizePolicy({ maxBytes: 10 })),
    0,
    "a single oversized record is never dropped — an empty store looks like a fresh one",
  );

  // ---- Log: absent, empty, and below-floor short-circuits ----
  const logPolicy = { maxAgeDays: 14, maxBytes: 2048, floorBytes: 512 };
  assert.equal(measureLog({ filePath: path.join(tempRoot, "nope.jsonl"), policy: logPolicy }).reason, "absent");

  const emptyLog = writeLog("empty.jsonl", []);
  assert.equal(measureLog({ filePath: emptyLog, policy: logPolicy }).reason, "empty");

  // Well under the floor: the engine must not even look at the contents.
  const tinyLog = writeLog("tiny.jsonl", [record(NOW, "a")]);
  const tiny = measureLog({ filePath: tinyLog, policy: logPolicy, now: NOW });
  assert.equal(tiny.act, false);
  assert.equal(tiny.reason, "below-floor");

  // ---- Log: the cheap gate must not read the file when the oldest record is live ----
  // Proven by fault injection: readFileSync throws, so any verdict at all means the full read was
  // never reached. This is the property the whole ladder exists for.
  const freshLog = writeLog("fresh.jsonl", padTo(600, () => record(NOW, "fresh")));
  const guardedFs = {
    ...fs,
    readFileSync: () => {
      throw new Error("full read must not happen when the oldest record is inside the window");
    },
  };
  const gated = measureLog({ filePath: freshLog, policy: logPolicy, now: NOW, fsApi: guardedFs });
  assert.equal(gated.act, false, "a log of live records needs no action");
  assert.equal(gated.reason, "within-policy");

  // ---- Log: age retention ----
  const agedLog = writeLog("aged.jsonl", [
    record(new Date(NOW.getTime() - 40 * DAY), "old-1"),
    record(new Date(NOW.getTime() - 30 * DAY), "old-2"),
    record(new Date(NOW.getTime() - 1 * DAY), "recent"),
    ...padTo(600, () => record(NOW, "now")),
  ]);
  const aged = measureLog({ filePath: agedLog, policy: logPolicy, now: NOW });
  assert.equal(aged.act, true, "expired records are detected");
  assert.equal(aged.dropCount, 2, "exactly the two records past the 14-day window");
  assert.equal(aged.reason, "age");

  // ---- Log: size cap with no age dimension (the spool's shape) ----
  const spoolPolicy = { maxAgeDays: null, maxBytes: 1024, floorBytes: 0, keepFraction: 0.7 };
  const bigLog = writeLog("big.jsonl", padTo(4096, () => record(NOW, "bulk")));
  const capped = measureLog({ filePath: bigLog, policy: spoolPolicy, now: NOW });
  assert.equal(capped.act, true, "an oversized log is trimmed even with no age policy");
  assert.equal(capped.reason, "size");
  assert.ok(capped.dropCount > 0);

  // ---- Log: unparseable lines still occupy bytes and remain droppable ----
  const corruptPath = path.join(tempRoot, "corrupt.jsonl");
  fs.writeFileSync(
    corruptPath,
    [
      JSON.stringify(record(new Date(NOW.getTime() - 40 * DAY), "old")),
      "{ this is not json",
      ...padTo(600, () => JSON.stringify(record(NOW, "now"))),
    ].join("\n") + "\n",
  );
  const corrupt = measureLog({ filePath: corruptPath, policy: logPolicy, now: NOW });
  assert.equal(corrupt.act, true);
  assert.equal(corrupt.dropCount, 1, "the expired record goes; the unparseable line is treated as live and stops the walk");

  // ---- Log: the `ts` field name, used by telemetry capture ----
  const tsPath = path.join(tempRoot, "ts.jsonl");
  fs.writeFileSync(
    tsPath,
    [
      JSON.stringify({ ts: new Date(NOW.getTime() - 40 * DAY).toISOString(), v: 1 }),
      ...padTo(600, () => JSON.stringify({ ts: NOW.toISOString(), v: 1 })),
    ].join("\n") + "\n",
  );
  const tsResult = measureLog({ filePath: tsPath, policy: logPolicy, now: NOW });
  assert.equal(tsResult.dropCount, 1, "`ts` is recognized alongside `at`");

  // ---- File set: absent and empty ----
  assert.equal(measureFileSet({ dirPath: path.join(tempRoot, "nodir"), policy: { maxBytes: 1024 } }).reason, "absent");

  // ---- File set: age retention by mtime ----
  const snapDir = path.join(tempRoot, "snapshots");
  fs.mkdirSync(snapDir, { recursive: true });
  writeAgedJson(snapDir, "old-a.json", 100 * DAY);
  writeAgedJson(snapDir, "old-b.json", 95 * DAY);
  writeAgedJson(snapDir, "recent.json", 1 * DAY);

  const setAged = measureFileSet({ dirPath: snapDir, policy: { maxAgeDays: 90 }, now: NOW });
  assert.equal(setAged.act, true);
  assert.equal(setAged.dropCount, 2, "both files past the window are selected");
  assert.equal(setAged.reason, "age");
  assert.ok(
    setAged.files.every((file) => path.basename(file).startsWith("old-")),
    "only the aged files are named for removal",
  );
  assert.ok(fs.existsSync(path.join(snapDir, "old-a.json")), "measurement never deletes anything itself");

  // ---- File set: never empties itself ----
  const allOldDir = path.join(tempRoot, "all-old");
  fs.mkdirSync(allOldDir, { recursive: true });
  writeAgedJson(allOldDir, "a.json", 200 * DAY);
  writeAgedJson(allOldDir, "b.json", 199 * DAY);
  const allOld = measureFileSet({ dirPath: allOldDir, policy: { maxAgeDays: 90 }, now: NOW });
  assert.equal(allOld.dropCount, 1, "the newest file survives even when everything is expired");

  // ---- File set: describe, for reporting surfaces ----
  const described = describeFileSet({ dirPath: snapDir });
  assert.equal(described.fileCount, 3);
  assert.ok(described.totalBytes > 0);
  assert.ok(described.oldestMtimeMs !== null);

  // ---- Registry ----
  const stores = retentionStores(tempRoot);
  assert.ok(stores.length > 0, "the registry is populated");
  assertBounded(stores);

  // The guarantee: no store may be registered unbounded.
  assert.throws(
    () => assertBounded([{ id: "bad", policy: { maxAgeDays: null, maxBytes: null } }]),
    /unbounded/,
    "an unbounded entry fails loudly",
  );

  const ids = stores.map((store) => store.id);
  assert.equal(new Set(ids).size, ids.length, "store ids are unique");
  for (const store of stores) {
    assert.ok([LOG_SHAPE, FILE_SET_SHAPE].includes(store.shape), `${store.id} has a known shape`);
    assert.ok(store.target.startsWith(tempRoot), `${store.id} resolves under the given stateRoot`);
    assert.ok(store.label && store.description, `${store.id} is described for reporting surfaces`);
  }

  assert.equal(findRetentionStore(tempRoot, "developer-runtime-history")?.policy.maxAgeDays, 14);
  assert.equal(findRetentionStore(tempRoot, "nope"), null);

  // Registered policies must survive validation — a bad literal in the registry fails here, not at
  // the first append on a user's machine.
  for (const store of stores) normalizePolicy(store.policy);

  console.log(`ok: retention policy engine (${stores.length} stores registered)`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function record(at, tag) {
  return { v: 1, at: at.toISOString(), tag };
}

// Repeat a record until the file clears a byte threshold, so floor/cap behavior is exercised
// without hard-coding a line count that a field change would invalidate.
function padTo(minBytes, make) {
  const out = [];
  let bytes = 0;
  while (bytes < minBytes) {
    const next = make();
    bytes += Buffer.byteLength(JSON.stringify(next), "utf8") + 1;
    out.push(next);
  }
  return out;
}

function writeLog(name, records) {
  const filePath = path.join(tempRoot, name);
  const body = records.length ? records.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
  fs.writeFileSync(filePath, body);
  return filePath;
}

function writeAgedJson(dir, name, ageMs) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify({ name }) + "\n");
  const when = new Date(NOW.getTime() - ageMs);
  fs.utimesSync(filePath, when, when);
}
