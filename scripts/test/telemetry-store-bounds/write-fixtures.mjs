#!/usr/bin/env node
// Fixture writer for telemetry-store-bounds-check.mjs. Runs in its own process so
// ROBOREPO_STATE_ROOT is already set when state-paths.mjs resolves at import time.
//
// Writes past each store's 5MB cap, then reports what survived as JSON on the last stdout line.
// Assertions live in the parent; this file only produces the state to assert against.
import fs from "node:fs";
import path from "node:path";
import {
  appendMarker,
  readMarkers,
  writeSnapshot,
  writeExperiment,
} from "../../cli/telemetry-schemas/persistence.mjs";
import {
  telemetryMarkersPath,
  telemetrySnapshotsDir,
  telemetryExperimentsDir,
} from "../../cli/state-paths.mjs";

const hexId = (prefix, n) => `${prefix}_${n.toString(16).padStart(16, "0")}`;
// Few large records rather than many small ones: the caps are on bytes, so a 64KB record clears a
// 5MB bound in ~80 writes. Padding with thousands of tiny records would prove the same thing while
// paying for thousands of trim measurements.
const PAD = 64 * 1024;

// ---- Markers: append-only JSONL, padded via `description` (an arbitrary string per the schema).
const markersWritten = 120;
let newestMarkerId = null;
for (let i = 0; i < markersWritten; i += 1) {
  newestMarkerId = hexId("mark", i);
  const markerTs = new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60)).toISOString();
  appendMarker({
    schema: 2,
    marker_id: newestMarkerId,
    type: "note",
    ts: markerTs,
    effective_at: markerTs,
    scope: "all",
    watching_kinds: [],
    title: "bulk marker",
    description: "x".repeat(PAD),
  });
}
const markers = readMarkers();

// ---- Snapshots: content-addressed, so each needs a distinct id or writeSnapshot dedups it away.
const snapshotsWritten = 120;
for (let i = 0; i < snapshotsWritten; i += 1) {
  writeSnapshot({
    schema: 2,
    snapshot_id: `cfg_${i.toString(16).padStart(24, "0")}`,
    created_at: new Date().toISOString(),
    harness: "claude",
    packages: ["y".repeat(PAD)],
    revision_contract: 1,
    evaluability: { packages: true, skills: true },
    ambient: { evaluable: false, packages: [] },
  });
}

// ---- Experiments: the running one goes FIRST so it is oldest by mtime, making it the first
// eviction candidate. It must still be there at the end.
const runningId = hexId("exp", 0);
writeExperiment({
  schema: 1,
  experiment_id: runningId,
  title: "running",
  start_marker_id: hexId("mark", 0),
  primary_metric: "tokens",
  expected_direction: "decrease",
  guardrails: [],
  eligibility: { task_categories: [], minimum_sessions_per_cohort: 1 },
  comparison: "midpoint",
});
const experimentsWritten = 120;
for (let i = 1; i < experimentsWritten; i += 1) {
  writeExperiment({
    schema: 1,
    experiment_id: hexId("exp", i),
    title: `finished ${"z".repeat(PAD)}`,
    start_marker_id: hexId("mark", i),
    end_marker_id: hexId("mark", i + 1),
    primary_metric: "tokens",
    expected_direction: "decrease",
    guardrails: [],
    eligibility: { task_categories: [], minimum_sessions_per_cohort: 1 },
    comparison: "midpoint",
  });
}

console.log(JSON.stringify({
  markersWritten,
  markerBytes: fs.statSync(telemetryMarkersPath).size,
  markerCount: markers.length,
  newestMarkerPresent: markers.some((marker) => marker.marker_id === newestMarkerId),
  snapshotsWritten,
  ...describe(telemetrySnapshotsDir, "snapshot"),
  experimentsWritten,
  ...describe(telemetryExperimentsDir, "experiment"),
  runningExperimentPresent: fs.existsSync(path.join(telemetryExperimentsDir, `${runningId}.json`)),
}));

function describe(dirPath, label) {
  const files = fs.readdirSync(dirPath).filter((name) => name.endsWith(".json"));
  const bytes = files.reduce((sum, name) => sum + fs.statSync(path.join(dirPath, name)).size, 0);
  return { [`${label}Files`]: files.length, [`${label}Bytes`]: bytes };
}
