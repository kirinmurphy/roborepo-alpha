#!/usr/bin/env node
// Bounded JSONL history: the snapshot diff that produces events, and the store that persists them
// with truncation tolerance, retention, and a size cap.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HISTORY_MAX_BYTES,
  appendHistoryEvents,
  compactHistory,
  diffSnapshots,
  historyPathFor,
  readHistoryEvents,
} from "../../modules/developer-runtime/index.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "developer-runtime-history-"));
const NOW = new Date("2026-01-01T00:00:00.000Z");

try {
  // ---- Diff: one case per event type ----
  const base = snapshot({ origin: "http://127.0.0.1:5173", health: "healthy", scope: "loopback" });

  assert.deepEqual(diffSnapshots(base, base, { now: NOW }), [], "identical snapshots produce no events");

  const firstSeen = diffSnapshots(null, base, { now: NOW, knownKeys: new Set() });
  assert.equal(firstSeen.length, 1);
  assert.equal(firstSeen[0].type, "firstSeen");
  assert.equal(firstSeen[0].associationKey, "a1");
  assert.equal(firstSeen[0].repositoryId, "git:github.com/o/r", "events carry the registry join key");
  assert.equal(firstSeen[0].rootId, "root1");
  assert.equal(firstSeen[0].appId, "web");

  // A restart on a new port is the SAME app: the association key is port-free, so this is an origin
  // change rather than a spurious inactive + firstSeen pair.
  const moved = snapshot({ origin: "http://127.0.0.1:62345", health: "healthy", scope: "loopback" });
  const originChange = diffSnapshots(base, moved, { now: NOW });
  assert.equal(originChange.length, 1);
  assert.equal(originChange[0].type, "originChange");
  assert.equal(originChange[0].from, "http://127.0.0.1:5173");
  assert.equal(originChange[0].to, "http://127.0.0.1:62345");

  const unhealthy = snapshot({ origin: "http://127.0.0.1:5173", health: "unhealthy", reason: "connect-refused", scope: "loopback" });
  const transition = diffSnapshots(base, unhealthy, { now: NOW });
  assert.equal(transition[0].type, "healthTransition");
  assert.deepEqual([transition[0].from, transition[0].to], ["healthy", "unhealthy"]);
  assert.equal(transition[0].reason, "connect-refused", "the classifier's reason is preserved for explainability");

  const exposed = snapshot({ origin: "http://127.0.0.1:5173", health: "healthy", scope: "wildcard" });
  assert.equal(diffSnapshots(base, exposed, { now: NOW })[0].type, "exposureChange");

  const duplicated = snapshot({ origin: "http://127.0.0.1:5173", health: "healthy", scope: "loopback", duplicatePorts: [5174] });
  const duplicateChange = diffSnapshots(base, duplicated, { now: NOW })[0];
  assert.equal(duplicateChange.type, "duplicateChange");
  assert.deepEqual([duplicateChange.from, duplicateChange.to], [0, 1]);

  const gone = diffSnapshots(base, { projects: [], unmatchedInstances: [] }, { now: NOW });
  assert.equal(gone[0].type, "inactive");
  console.log("ok  snapshot diff covers every event type");

  // ---- Cold start must not re-announce apps already in the history file ----
  const known = new Set(["a1"]);
  assert.deepEqual(
    diffSnapshots(null, base, { now: NOW, knownKeys: known }),
    [],
    "a portal restart must not emit firstSeen for an app already recorded",
  );
  console.log("ok  cold start consults known history keys");

  // ---- No absolute paths reach disk ----
  const stateRoot = path.join(tempRoot, "state");
  appendHistoryEvents(firstSeen, { stateRoot, now: NOW });
  const raw = fs.readFileSync(historyPathFor(stateRoot), "utf8");
  assert.ok(!raw.includes(tempRoot) && !raw.includes("/Users"), "rootId stands in for the on-disk location");

  const roundTrip = readHistoryEvents({ stateRoot });
  assert.equal(roundTrip.length, 1);
  assert.equal(roundTrip[0].type, "firstSeen");
  assert.equal(readHistoryEvents({ stateRoot: path.join(tempRoot, "missing") }).length, 0, "a missing file reads as empty");
  console.log("ok  append/read round trip omits absolute paths");

  // ---- Malformed JSONL, including a truncated final line ----
  const messyRoot = path.join(tempRoot, "messy");
  const messyPath = historyPathFor(messyRoot);
  fs.mkdirSync(path.dirname(messyPath), { recursive: true });
  fs.writeFileSync(
    messyPath,
    [
      JSON.stringify(event("a1", "firstSeen")),
      "{ not json at all",
      JSON.stringify({ at: "2026-01-01T00:00:00.000Z", type: "bogusType", associationKey: "a1" }),
      JSON.stringify({ type: "firstSeen", associationKey: "a1" }),
      JSON.stringify(event("a2", "inactive")),
      '{"at":"2026-01-01T00:00:00.000Z","type":"firstSee',
    ].join("\n"),
  );
  const recovered = readHistoryEvents({ stateRoot: messyRoot });
  assert.equal(recovered.length, 2, "garbage, unknown types, undated rows, and a torn tail are all dropped");
  assert.deepEqual(recovered.map((e) => e.associationKey), ["a1", "a2"]);
  console.log("ok  malformed and truncated lines are tolerated");

  // ---- Retention ----
  const retentionRoot = path.join(tempRoot, "retention");
  appendHistoryEvents(
    [
      event("a1", "firstSeen", "2025-12-01T00:00:00.000Z"),
      event("a1", "inactive", "2025-12-10T00:00:00.000Z"),
      event("a1", "firstSeen", "2025-12-30T00:00:00.000Z"),
    ],
    { stateRoot: retentionRoot, now: NOW },
  );
  assert.equal(compactHistory({ stateRoot: retentionRoot, now: NOW, retentionDays: 14 }), true);
  const retained = readHistoryEvents({ stateRoot: retentionRoot });
  assert.equal(retained.length, 1, "only events inside the 14-day window survive");
  assert.equal(retained[0].at, "2025-12-30T00:00:00.000Z");
  assert.equal(
    compactHistory({ stateRoot: retentionRoot, now: NOW, retentionDays: 14 }),
    false,
    "a second compaction with nothing to drop is a no-op",
  );
  console.log("ok  retention drops events past the window");

  // Corrupt records still occupy a position in the file. Retention must remove the measured
  // prefix before filtering invalid events, or an invalid row makes a recent event disappear.
  const corruptAgeRoot = path.join(tempRoot, "corrupt-age");
  const corruptAgePath = historyPathFor(corruptAgeRoot);
  fs.mkdirSync(path.dirname(corruptAgePath), { recursive: true });
  fs.writeFileSync(corruptAgePath, [
    JSON.stringify(event("expired", "firstSeen", "2025-12-01T00:00:00.000Z")),
    JSON.stringify({ at: "2025-12-02T00:00:00.000Z", type: "invalid", associationKey: "invalid" }),
    "",
    JSON.stringify(event("recent-first", "firstSeen", "2025-12-30T00:00:00.000Z")),
    JSON.stringify(event("recent-second", "firstSeen", "2025-12-31T00:00:00.000Z")),
  ].join("\n") + "\n");
  assert.equal(compactHistory({ stateRoot: corruptAgeRoot, now: NOW }), true);
  assert.deepEqual(readHistoryEvents({ stateRoot: corruptAgeRoot }).map((entry) => entry.associationKey),
    ["recent-first", "recent-second"], "invalid expired rows must not shift the cut into recent history");

  const corruptCapRoot = path.join(tempRoot, "corrupt-cap");
  const corruptCapPath = historyPathFor(corruptCapRoot);
  fs.mkdirSync(path.dirname(corruptCapPath), { recursive: true });
  fs.writeFileSync(corruptCapPath, [
    "x".repeat(HISTORY_MAX_BYTES),
    JSON.stringify(event("recent-first", "firstSeen")),
    JSON.stringify(event("recent-second", "firstSeen")),
  ].join("\n") + "\n");
  assert.equal(compactHistory({ stateRoot: corruptCapRoot, now: NOW }), true);
  assert.deepEqual(readHistoryEvents({ stateRoot: corruptCapRoot }).map((entry) => entry.associationKey),
    ["recent-first", "recent-second"], "discarding an oversized corrupt prefix must preserve recent history");
  assert.ok(fs.statSync(corruptCapPath).size <= HISTORY_MAX_BYTES);
  assert.equal(compactHistory({ stateRoot: corruptCapRoot, now: NOW }), false, "recovered history needs no further trim");

  const corruptTailRoot = path.join(tempRoot, "corrupt-tail");
  const corruptTailPath = historyPathFor(corruptTailRoot);
  fs.mkdirSync(path.dirname(corruptTailPath), { recursive: true });
  fs.writeFileSync(corruptTailPath, JSON.stringify(event("last-valid", "firstSeen")) + "\n" + "x".repeat(HISTORY_MAX_BYTES) + "\n");
  assert.equal(compactHistory({ stateRoot: corruptTailRoot, now: NOW }), true);
  assert.deepEqual(readHistoryEvents({ stateRoot: corruptTailRoot }).map((entry) => entry.associationKey),
    ["last-valid"], "a corrupt tail must not erase the final valid event");
  assert.ok(fs.statSync(corruptTailPath).size <= HISTORY_MAX_BYTES);
  console.log("ok  compaction preserves valid history around corrupt records");

  // ---- Size cap, and compaction leaves no temp file behind ----
  // Written straight to disk rather than via appendHistoryEvents, because appending already trims
  // past the cap on the way in — this fixture has to exist in the oversized state to prove the trim
  // is what brings it back down.
  const capRoot = path.join(tempRoot, "cap");
  const capPath = historyPathFor(capRoot);
  const bulk = [];
  for (let i = 0; i < 12_000; i += 1) bulk.push(event(`a${i}`, "healthTransition"));
  fs.mkdirSync(path.dirname(capPath), { recursive: true });
  fs.writeFileSync(capPath, bulk.map((e) => JSON.stringify(e)).join("\n") + "\n");
  assert.ok(fs.statSync(capPath).size > HISTORY_MAX_BYTES, "fixture must actually exceed the cap");

  assert.equal(compactHistory({ stateRoot: capRoot, now: NOW, retentionDays: 365 }), true);
  const capped = readHistoryEvents({ stateRoot: capRoot });
  assert.ok(fs.statSync(capPath).size <= HISTORY_MAX_BYTES, "the size cap is enforced");
  assert.ok(capped.length > 0 && capped.length < bulk.length, "the newest events survive the trim");
  assert.equal(
    capped[capped.length - 1].associationKey,
    `a${bulk.length - 1}`,
    "trimming drops the oldest events, never the newest",
  );
  const strays = fs.readdirSync(path.dirname(capPath)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(strays, [], "atomic compaction leaves no temp file behind");

  // Appending is self-bounding: a caller that never invokes compactHistory still cannot grow the
  // file without limit, because each append compacts once the file clears the floor.
  const selfCapRoot = path.join(tempRoot, "self-cap");
  appendHistoryEvents(bulk, { stateRoot: selfCapRoot, now: NOW, retentionDays: 365 });
  assert.ok(
    fs.statSync(historyPathFor(selfCapRoot)).size <= HISTORY_MAX_BYTES,
    "appending past the cap trims on the way in",
  );
  console.log("ok  size cap trims oldest, compaction is atomic, append self-bounds");

  // ---- Never throws ----
  assert.deepEqual(appendHistoryEvents([], { stateRoot }), { written: 0, compacted: false });
  assert.deepEqual(appendHistoryEvents(null, { stateRoot }), { written: 0, compacted: false });
  assert.equal(
    appendHistoryEvents([{ nonsense: true }], { stateRoot }).written,
    0,
    "an event missing its addressable fields is rejected rather than persisted",
  );
  console.log("ok  history writes are best-effort and never throw");

  // ---- Route resolution: opaque key -> associationKey -> that app's events ----
  // The opaque key includes the origin, so it is not stable across a port change; history is keyed
  // by the port-free associationKey. This walks the same two-step the HTTP route performs, with the
  // state directory sandboxed so the check never touches the real ~/.roborepo.
  const routeRoot = path.join(tempRoot, "route");
  process.env.ROBOREPO_STATE_DIR = routeRoot;
  const { buildDeveloperRuntimeSnapshot, defaultSettings } = await import("../../modules/developer-runtime/index.mjs");
  const { loadDeveloperRuntimeHistory } = await import("../cli/developer-runtime.mjs");

  const live = buildDeveloperRuntimeSnapshot({
    discovery: { capabilities: { discovery: "supported" }, warnings: [], instances: [liveInstance()] },
    settings: defaultSettings(),
    refresh: { state: "idle", startedAt: null, error: null },
    now: NOW,
  });
  const target = [...live.projects.flatMap((p) => p.instances), ...live.unmatchedInstances][0];
  assert.match(target.opaqueKey, /^lk_/);

  appendHistoryEvents(
    [event(target.associationKey, "firstSeen"), event(target.associationKey, "originChange"), event("other", "firstSeen")],
    { stateRoot: routeRoot, now: NOW },
  );

  const result = loadDeveloperRuntimeHistory(target.opaqueKey, { snapshot: live });
  assert.equal(result.ok, true);
  assert.equal(result.associationKey, target.associationKey);
  assert.equal(result.events.length, 2, "only this app's events are returned");
  assert.equal(result.events[0].type, "originChange", "newest first");
  assert.ok(
    result.events.every((e) => e.associationKey === target.associationKey),
    "another app's history is never disclosed",
  );

  // The unknown-key 404 is the SSRF/enumeration guard on this tokenless GET route.
  const denied = loadDeveloperRuntimeHistory("lk_not_a_real_key", { snapshot: live });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 404);
  console.log("ok  history route resolves by opaque key and 404s unknown keys");

  console.log("\ndeveloper-runtime-history checks passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function snapshot({ origin, health, reason = null, scope, duplicatePorts = [] }) {
  return {
    projects: [
      {
        identity: "git:github.com/o/r",
        repositoryId: "git:github.com/o/r",
        rootId: "root1",
        instances: [
          {
            associationKey: "a1",
            origin,
            duplicatePorts,
            bind: { scope },
            health: { state: health, reason },
            app: { id: "web", name: "Web" },
          },
        ],
      },
    ],
    unmatchedInstances: [],
  };
}

// A discovery-shaped instance, as buildDeveloperRuntimeSnapshot expects it (pre-snapshot, so no
// opaqueKey yet — the snapshot builder mints that).
function liveInstance() {
  return {
    key: "4242:127.0.0.1:5173",
    associationKey: "alive1",
    matchSignature: { key: "alive1", titleKey: "alive1t", projectIdentity: "git:github.com/o/r", relativeCwd: ".", command: "node", title: "App" },
    origin: "http://127.0.0.1:5173",
    alternateOrigins: [],
    bind: { address: "127.0.0.1", port: 5173, scope: "loopback", warning: null },
    status: 200,
    latencyMs: 3,
    protocol: "http",
    title: "App",
    health: { state: "healthy", reason: null, consecutiveFailures: 0, since: NOW.toISOString(), firstSeenAt: NOW.toISOString(), lastProbeAt: NOW.toISOString() },
    process: { pid: 4242, command: "node" },
    project: {
      identity: "git:github.com/o/r",
      identityKind: "git",
      confidence: "high",
      projectRoot: "/tmp/fixture",
      evidence: "Git remote",
      repositoryId: "git:github.com/o/r",
      rootId: "root1",
      git: null,
    },
  };
}

function event(associationKey, type, at = NOW.toISOString()) {
  return {
    v: 1,
    at,
    type,
    associationKey,
    projectIdentity: "git:github.com/o/r",
    appId: "web",
    repositoryId: "git:github.com/o/r",
    rootId: "root1",
    from: null,
    to: null,
    reason: null,
  };
}
