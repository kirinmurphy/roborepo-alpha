#!/usr/bin/env node
// Node release health: the doctor assessment against fixed release data (no network), the
// bin/roborepo minimum-major guard against a fake `node` on PATH, and the guard's floor staying in
// step with package.json engines.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assessNodeRelease, compareNodeVersions, parseNodeVersion } from "../cli/node-release-health.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const now = new Date("2026-10-22T00:00:00Z");

// Shaped like nodejs.org/dist/index.json: newest first, `lts` false or a codename.
const releases = [
  { version: "v26.12.1", date: "2026-10-21", lts: false, security: true },
  { version: "v24.22.1", date: "2026-10-20", lts: "Krypton", security: true },
  { version: "v22.23.4", date: "2026-10-20", lts: "Jod", security: true },
  { version: "v22.23.3", date: "2026-09-23", lts: "Jod", security: false },
  { version: "v22.23.2", date: "2026-07-28", lts: "Jod", security: true },
  { version: "v22.23.1", date: "2026-06-22", lts: "Jod", security: false },
  { version: "v20.20.2", date: "2026-03-24", lts: "Iron", security: true },
  { version: "v20.20.1", date: "2026-02-10", lts: "Iron", security: false },
];
const schedule = {
  v20: { start: "2023-04-18", end: "2026-04-30" },
  v22: { start: "2024-04-24", end: "2027-04-30" },
  v24: { start: "2025-05-06", end: "2028-04-30" },
  v26: { start: "2026-05-05", end: "2029-04-30" },
};

assert.deepEqual(parseNodeVersion("v22.23.1"), [22, 23, 1]);
assert.deepEqual(parseNodeVersion("22.23.1"), [22, 23, 1]);
assert.equal(parseNodeVersion("garbage"), null);
assert.ok(compareNodeVersions("v22.9.0", "v22.10.0") < 0, "compares numerically, not lexically");
assert.equal(compareNodeVersions("v22.23.4", "v22.23.4"), 0);

assert.deepEqual(assessNodeRelease({ version: "v22.23.4", releases, schedule, now }), [], "latest security release is current");
assert.deepEqual(
  assessNodeRelease({ version: "v22.23.3", releases: releases.filter((release) => release.version !== "v22.23.4"), schedule, now }),
  [],
  "a non-security release newer than the line's latest security release is current",
);
assert.deepEqual(assessNodeRelease({ version: "v26.12.1", releases, schedule, now }), [], "a supported non-LTS line is not flagged");

const behind = assessNodeRelease({ version: "v22.23.1", releases, schedule, now });
assert.equal(behind.length, 1);
assert.match(behind[0], /behind v22\.23\.4, the latest security release on the v22 line \(2026-10-20\)/);

const eolLatest = assessNodeRelease({ version: "v20.20.2", releases, schedule, now });
assert.equal(eolLatest.length, 1, "the last release of an ended line warns only about end of life");
assert.match(eolLatest[0], /v20 line, which reached end of life on 2026-04-30/);
assert.match(eolLatest[0], /such as v24\.22\.1/, "recommends the newest LTS release on a supported line");

const eolBehind = assessNodeRelease({ version: "v20.20.1", releases, schedule, now });
assert.equal(eolBehind.length, 2, "an ended line that is also unpatched reports both");

assert.deepEqual(
  assessNodeRelease({ version: "v20.20.2", releases, schedule, now: new Date("2026-04-01T00:00:00Z") }),
  [],
  "a line is not end of life before its end date",
);

assert.equal(assessNodeRelease({ version: "v20.20.2", releases: null, schedule, now }).length, 1, "end of life still reported without the release index");
assert.match(assessNodeRelease({ version: "v20.20.2", releases: null, schedule, now })[0], /upgrade to a supported LTS line$/);
assert.equal(assessNodeRelease({ version: "v22.23.1", releases, schedule: null, now }).length, 1, "patch currency still reported without the schedule");
assert.deepEqual(assessNodeRelease({ version: "v28.0.0", releases, schedule, now }), [], "a line missing from both sources is not flagged");
assert.match(assessNodeRelease({ version: "nope", releases, schedule, now })[0], /could not parse/);

// The guard's floor and the published engines range must name the same major.
const engines = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).engines.node;
const binSource = fs.readFileSync(path.join(repoRoot, "bin", "roborepo"), "utf8");
const binFloor = /readonly min_node_major=(\d+)/.exec(binSource)?.[1];
assert.ok(binFloor, "bin/roborepo declares min_node_major");
assert.equal(engines, `>=${binFloor}`, "package.json engines matches bin/roborepo min_node_major");

// Guard behavior with a fake node first on PATH. The fake prints its version for --version and
// otherwise reports that it was exec'd, which is how a passing guard is observed.
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-release-guard-"));
function runWithFakeNode(versionText) {
  fs.writeFileSync(
    path.join(fakeDir, "node"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${versionText}'; else echo "fake-node-ran"; fi\n`,
    { mode: 0o755 },
  );
  return spawnSync("bash", [path.join(repoRoot, "bin", "roborepo"), "version"], {
    env: { ...process.env, PATH: `${fakeDir}:/usr/bin:/bin` },
    encoding: "utf8",
  });
}

try {
  const old = runWithFakeNode("v20.20.2");
  assert.equal(old.status, 1, "Node 20 is refused");
  assert.match(old.stderr, /requires Node\.js 22 or newer \(found v20\.20\.2/);
  assert.doesNotMatch(old.stdout, /fake-node-ran/);

  const unreadable = runWithFakeNode("not-a-version");
  assert.equal(unreadable.status, 1, "an unreadable version is refused");

  const floor = runWithFakeNode(`v${binFloor}.0.0`);
  assert.equal(floor.status, 0, floor.stderr);
  assert.match(floor.stdout, /fake-node-ran/, "the floor major passes through to node");
} finally {
  fs.rmSync(fakeDir, { recursive: true, force: true });
}

console.log("node-release-health-check: ok");
