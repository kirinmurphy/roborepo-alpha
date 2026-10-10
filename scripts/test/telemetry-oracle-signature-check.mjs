import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { telemetryOracleEvidenceSignature, telemetryReportEvidenceSignature } from "../cli/telemetry.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-signature-"));
const paths = { spoolDir: path.join(root, "spool"), snapshotsDir: path.join(root, "snapshots"),
  markersPath: path.join(root, "markers.jsonl"), registryPath: path.join(root, "registry.json") };
const signature = () => telemetryOracleEvidenceSignature(paths);
try {
  const empty = signature(); assert.match(empty, /^sha256:[a-f0-9]{64}$/);
  fs.writeFileSync(paths.markersPath, "one");
  assert.notEqual(signature(), empty, "missing spool cannot hide marker changes");
  fs.mkdirSync(paths.spoolDir); fs.mkdirSync(paths.snapshotsDir);
  for (const file of [path.join(paths.spoolDir, "capture.jsonl"), paths.markersPath,
    path.join(paths.snapshotsDir, "cfg.json"), paths.registryPath]) {
    const before = signature(); fs.writeFileSync(file, "first"); const created = signature();
    assert.notEqual(created, before); assert.equal(created, signature());
    const stat = fs.statSync(file); fs.writeFileSync(file, "other"); fs.utimesSync(file, stat.atime, stat.mtime);
    assert.notEqual(signature(), created, "same-size content changes with restored mtime are detected via ctime");
    const old = signature(); fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, "other");
    assert.notEqual(signature(), old, "file replacement invalidates even equal-sized evidence");
    fs.rmSync(`${file}.old`); const replaced = signature(); fs.rmSync(file); assert.notEqual(signature(), replaced);
  }
  fs.writeFileSync(path.join(paths.spoolDir, "capture.jsonl"), "one");
  const named = signature(); fs.renameSync(path.join(paths.spoolDir, "capture.jsonl"), path.join(paths.spoolDir, "renamed.jsonl"));
  assert.notEqual(signature(), named, "filenames affect spool provenance");
  const relevant = signature(); fs.writeFileSync(path.join(paths.spoolDir, "ignored.txt"), "ignored");
  assert.equal(signature(), relevant, "unconsumed extensions do not schedule work");
  const read = fs.readFileSync;
  try { fs.readFileSync = () => { throw new Error("signature must not read file contents"); }; assert.equal(signature(), relevant); }
  finally { fs.readFileSync = read; }
  assert.throws(() => telemetryOracleEvidenceSignature({ ...paths, spoolDir: path.join(paths.spoolDir, "renamed.jsonl") }),
    "unreadable evidence does not manufacture a stable missing signature");

  // Report cache keys stay stable across a persistent unreadable entry, yet still track other evidence.
  const reportPaths = { ...paths, experimentsDir: path.join(root, "experiments") };
  const report = () => telemetryReportEvidenceSignature(reportPaths);
  fs.mkdirSync(path.join(paths.spoolDir, "bad.jsonl"));
  assert.throws(signature, "oracle stays strict on a non-file spool entry");
  const degraded = report(); assert.match(degraded, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report(), degraded, "a persistent unreadable entry does not churn report cache keys");
  fs.writeFileSync(paths.markersPath, "changed while degraded");
  assert.notEqual(report(), degraded, "other evidence still invalidates while one entry is unreadable");
  const beforeExperiment = report(); fs.mkdirSync(reportPaths.experimentsDir);
  fs.writeFileSync(path.join(reportPaths.experimentsDir, "exp.json"), "{}");
  assert.notEqual(report(), beforeExperiment, "experiments invalidate report keys");
  fs.rmSync(path.join(paths.spoolDir, "bad.jsonl"), { recursive: true });
  assert.doesNotThrow(signature, "oracle recovers once the entry is readable");
  console.log("telemetry oracle complete evidence signature checks passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
