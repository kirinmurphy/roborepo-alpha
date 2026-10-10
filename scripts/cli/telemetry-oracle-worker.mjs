import fs from "node:fs";
import path from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { compareTelemetryOracle } from "./telemetry-oracle-compare.mjs";
import { createOracleHealthResult, emptyOracleHealth } from "./telemetry-schemas/oracle-health-schema.mjs";

// Explicit paths avoid importing portal orchestration or a reader that silently normalizes or
// discards evidence. Only this isolated thread retains the full raw snapshot during comparison.
if (!isMainThread && parentPort) {
  const started = performance.now();
  let comparison;
  try {
    const { events, options } = readEvidenceSnapshot(workerData.paths);
    comparison = compareTelemetryOracle(events, options);
  } catch {
    comparison = emptyOracleHealth("unavailable", "evidence_read_error");
  }
  parentPort.postMessage(createOracleHealthResult(comparison, {
    evidence_signature: workerData.evidence_signature,
    checked_at: new Date().toISOString(), duration_ms: Math.round(performance.now() - started),
  }));
  parentPort.close();
}

function readEvidenceSnapshot(paths) {
  const skippedEvidence = { malformed_events: 0, malformed_markers: 0, malformed_snapshots: 0, malformed_repository_registry: 0 };
  const events = filesIn(paths.spoolDir, ".jsonl").flatMap((file) =>
    readJsonl(path.join(paths.spoolDir, file), skippedEvidence, "malformed_events", file));
  const markers = readJsonl(paths.markersPath, skippedEvidence, "malformed_markers", null, true);
  const snapshots = filesIn(paths.snapshotsDir, ".json").flatMap((file) => {
    const parsed = parseJson(fs.readFileSync(path.join(paths.snapshotsDir, file), "utf8"), skippedEvidence, "malformed_snapshots");
    return parsed.ok ? [parsed.value] : [];
  });
  const registryText = readOptionalFile(paths.registryPath);
  const registry = registryText === null ? { ok: true, value: null }
    : parseJson(registryText, skippedEvidence, "malformed_repository_registry");
  return { events, options: { markers, snapshots, repositoryRegistry: registry.ok ? registry.value : {}, skippedEvidence } };
}

function filesIn(directory, extension) {
  try { return fs.readdirSync(directory).filter((file) => file.endsWith(extension)).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function readOptionalFile(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function readJsonl(file, skipped, category, source = null, optional = false) {
  const text = optional ? readOptionalFile(file) : fs.readFileSync(file, "utf8");
  const rows = [];
  let sequence = 0;
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    sequence++;
    const parsed = parseJson(line, skipped, category);
    if (!parsed.ok) continue;
    // Provenance chooses among otherwise equal mirrored captures. Keep it non-enumerable, as in
    // the production spool reader, so evidence deduplication still sees only persisted fields.
    if (source && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
      Object.defineProperty(parsed.value, "spool_provenance", { value: { source: `spool:${source}`, sequence }, enumerable: false });
    }
    rows.push(parsed.value);
  }
  return rows;
}

function parseJson(text, skipped, category) {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch { skipped[category]++; return { ok: false }; }
}
