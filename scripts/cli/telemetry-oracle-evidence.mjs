import fs from "node:fs";
import path from "node:path";

// Reads one raw evidence snapshot from explicit paths. It deliberately avoids the production spool
// and persistence readers, which normalize or silently discard evidence the oracle must account for:
// every unparseable record is counted per store instead.
export function readEvidenceSnapshot(paths) {
  const skippedEvidence = { malformed_events: 0, malformed_markers: 0, malformed_snapshots: 0 };
  const events = filesIn(paths.spoolDir, ".jsonl").flatMap((file) =>
    readJsonl(path.join(paths.spoolDir, file), skippedEvidence, "malformed_events", file));
  const markers = readJsonl(paths.markersPath, skippedEvidence, "malformed_markers", null, true);
  const snapshots = filesIn(paths.snapshotsDir, ".json").flatMap((file) => {
    const parsed = parseJson(fs.readFileSync(path.join(paths.snapshotsDir, file), "utf8"), skippedEvidence, "malformed_snapshots");
    return parsed.ok ? [parsed.value] : [];
  });
  return { events, options: { markers, snapshots, skippedEvidence } };
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
