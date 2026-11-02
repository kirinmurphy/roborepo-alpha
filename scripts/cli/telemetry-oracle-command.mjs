// `roborepo telemetry oracle`: one on-demand comparison of the production analyzer and the
// independent oracle over the developer's real local evidence. A short-lived CLI process has no
// event loop to protect, so the comparison runs in-process.
import { telemetrySpoolDir, telemetryMarkersPath, telemetrySnapshotsDir } from "./state-paths.mjs";
import { readEvidenceSnapshot } from "./telemetry-oracle-evidence.mjs";
import { compareTelemetryOracle } from "./telemetry-oracle-compare.mjs";
import { createOracleResult, emptyOracleResult } from "./telemetry-schemas/oracle-result-schema.mjs";

const USAGE = "usage: roborepo telemetry oracle [--json]";
const EVIDENCE_PATHS = Object.freeze({ spoolDir: telemetrySpoolDir, markersPath: telemetryMarkersPath,
  snapshotsDir: telemetrySnapshotsDir });

// Exit code 2 is inconclusive: the check neither passed nor found a disagreement.
const EXIT_CODES = Object.freeze({ passed: 0, failed: 1, partial: 2, unavailable: 2 });
const STATUS_LABELS = Object.freeze({ passed: "Passed", failed: "Failed", partial: "Partial", unavailable: "Unavailable" });

export function telemetryOracleCommand(args) {
  const json = parseArgs(args);
  const result = runOracleCheck(EVIDENCE_PATHS);
  console.log(json ? JSON.stringify(result, null, 2) : formatOracleResult(result));
  process.exitCode = oracleExitCode(result.status);
}

export function runOracleCheck(paths) {
  const started = performance.now();
  let comparison;
  try {
    const { events, options } = readEvidenceSnapshot(paths);
    comparison = compareTelemetryOracle(events, options);
  } catch {
    // Read errors can carry local paths. A fixed category is enough to say the check never ran.
    comparison = emptyOracleResult("evidence_read_error");
  }
  return createOracleResult(comparison, {
    checked_at: new Date().toISOString(), duration_ms: Math.round(performance.now() - started),
  });
}

export function oracleExitCode(status) {
  return EXIT_CODES[status] ?? EXIT_CODES.unavailable;
}

export function formatOracleResult(result) {
  const { coverage } = result;
  const lines = [
    `Oracle check: ${STATUS_LABELS[result.status]}`,
    `Evidence: ${number(result.event_count)} events · ${number(result.session_count)} sessions · ${number(result.operation_count)} operations`,
    `Coverage: ${number(coverage.supported_events)} supported · ${number(coverage.unsupported_events)} unsupported`,
  ];
  if (coverage.issues.length) {
    lines.push(`Issues: ${coverage.issues.map(({ category, count }) => `${category} (${number(count)})`).join(", ")}`);
  }
  if (coverage.checks.length) lines.push(`Checked: ${coverage.checks.join(", ")}`);
  if (result.differences.length) lines.push(`Differences: ${result.differences.join(", ")}`);
  if (result.error_category) lines.push(`Error: ${result.error_category}`);
  lines.push(`Duration: ${number(result.duration_ms ?? 0)} ms`);
  return lines.join("\n");
}

function parseArgs(args) {
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown !== undefined) {
    console.error(`unknown argument: ${unknown}`);
    console.error(USAGE);
    process.exit(2);
  }
  return args.includes("--json");
}

function number(value) {
  return value.toLocaleString("en-US");
}
