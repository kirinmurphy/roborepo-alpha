import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync, spawn } from "node:child_process";
import { markTelemetrySelected } from "./presets.mjs";
import { repoRoot, stateRoot, harnessHome, rootConfigActive } from "./paths.mjs";
import { portalPidPathForPort, legacyTelemetryPidPath, telemetryBackupDir, telemetryCollectorDir, telemetryDir, telemetrySpoolDir, telemetryMarkersPath, telemetryExperimentsDir, telemetrySnapshotsDir, repositoriesRegistryPath } from "./state-paths.mjs";
import { conditionDemoEvidence } from "./telemetry-conditions-demo.mjs";
import { analyzeTelemetry } from "./telemetry-analyze.mjs";
import { readMarkers, readSnapshot, readSnapshots, readExperiments } from "./telemetry-schemas/persistence.mjs";
import { readSourceFile } from "./config-source-lookup.mjs";
import {
  createMarker, startExperiment, endExperiment, experimentStatus,
  MARKER_TYPES, OUTCOME_STATUSES, EXPECTED_DIRECTIONS, TASK_CATEGORIES,
} from "./telemetry-markers.mjs";
import { isKnownMetric, listMetrics, computeMetric } from "./telemetry-metrics.mjs";
import { normalizeCohortFilter, applyCohortFilter } from "./telemetry-cohort.mjs";
import { compareAcrossMarker, describeMarkerComparison } from "./telemetry-compare.mjs";
import { readAppendedLines } from "./jsonl-tail.mjs";
import { startPortalServer } from "./portal-server.mjs";
import { computePortalSourceHash } from "./portal-source-hash.mjs";
import { readConfigSnapshot, loadConfigSource } from "./config.mjs";
import { mutatePackage, setSkillInstalled, setBehaviorBucket, setCommandBucket } from "./config-mutate.mjs";
import { loadPlansSnapshot, loadCachedPlansSnapshot, loadPlanDocument, buildPlansPrompt, updatePlanPriority, updatePlanLifecycle, refreshPlans } from "./plans.mjs";
import { loadRepositorySources, addRepositorySource, removeRepositorySource, setRepositorySourceEnabled, refreshRepositorySources, wipeRepositoryList, autoDiscoveryEnabled } from "./repository-sources.mjs";
import {
  loadDeveloperRuntimeSnapshot,
  loadDeveloperRuntimeHistory,
  loadDeveloperRuntimeMetadata,
  refreshDeveloperRuntimeSnapshot,
  updateDeveloperRuntimeSettings,
  setDeveloperRuntimeRepositoryVisibility,
  setDeveloperRuntimeRepositoryPinned,
  forgetDeveloperRuntimeRepository,
  setDeveloperRuntimePortalInfo,
  clearDeveloperRuntimeSnapshotCache,
} from "./developer-runtime.mjs";
import {
  loadRepositoriesPayload,
  loadRepositoryPayload,
  loadRepositoryAssociations,
  patchRepository,
} from "./repositories.mjs";
import { loadRegistry, updateRegistry, recordDiscoveryIfKnown } from "../../modules/repositories/index.mjs";
import { buildRepositoryHashIndex } from "./telemetry-repository.mjs";
import { createRepositoryOverviewService } from "./repository-overview.mjs";
import { MOCK_FIRST_RUN_VIEWS_ENABLED, mockHomeOverview, purgePersistedMockRepositories } from "./mock-home.mjs";
import { buildTelemetryRepositoryProjection, fixtureTelemetryRepositories, homeTelemetryProjection } from "./telemetry-repository-overview.mjs";
import { privacyHash } from "./telemetry-schemas/hash.mjs";
import { buildAnalysisPrompt } from "../harnesses/transcript-locate.mjs";
import { insightsSummary } from "./telemetry-insights.mjs";
import { deriveSessionFindings } from "./telemetry-session-findings.mjs";
import { hookFilePath, writeHooksFile } from "./hook-composition.mjs";
import { getHarnessProvider, hasHarnessProvider, listHarnessProviders, harnessDisplayName } from "../harnesses/registry.mjs";
import { refreshHarnessState, setHarnessEnabled } from "../harnesses/service.mjs";
import { loadSetupState } from "./portal-setup.mjs";
import { ensureInitialized, finalizeInitialization, describeNewerSchemaRefusal } from "./initialization-bootstrap.mjs";

export async function telemetryCommand(rest) {
  const [sub, ...args] = rest;
  switch (sub) {
    case "install":
      return telemetryInstall(args);
    case "enable":
      return telemetryEnable(args);
    case "disable":
      return telemetryDisable(args);
    case "status":
      return telemetryStatus(args);
    case "report":
      return telemetryReport(args);
    case "export":
      return telemetryExport(args);
    case "purge":
      return telemetryPurge(args);
    case "backup":
      return telemetryBackup(args);
    case "mark":
      return telemetryMark(args);
    case "experiment":
      return telemetryExperiment(args);
    // The hot hook path (fires every PreToolUse/PostToolUse) bypasses this module entirely via
    // main.mjs's dynamic import of telemetry-capture.mjs. This case only serves callers that go
    // through telemetryCommand directly (tests, telemetry-only install's wired hook command still
    // routes through `roborepo telemetry capture`, which main.mjs intercepts before reaching here).
    case "capture": {
      const { telemetryCaptureCommand } = await import("./telemetry-capture.mjs");
      return telemetryCaptureCommand(args);
    }
    default:
      console.error("usage: roborepo telemetry install|stop|enable|disable|status|report|export|backup|purge|mark|experiment");
      console.error("portal: roborepo web [--detach] [--no-open] [--port <n>]");
      process.exit(2);
  }
}

// --------------------------------------------------------------------------- markers

const MARK_USAGE = "usage: roborepo telemetry mark --type <type> --title <title> [--description <text>] "
  + "[--package <id>]... [--skill <id>]... [--tag <tag>]... [--metric <id>] [--expect increase|decrease|no-change] "
  + "[--session <id>] [--phase <phase>] [--status <status>] [--supersedes <marker-id>] "
  + "[--task-category <id>] [--files-touched <n>] [--directories-touched <n>] [--insertions <n>] [--deletions <n>]";

function parseMarkArgs(args) {
  const options = { packages: [], skills: [], tags: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--type": options.type = args[++i]; break;
      case "--title": options.title = args[++i]; break;
      case "--description": options.description = args[++i]; break;
      case "--package": options.packages.push(args[++i]); break;
      case "--skill": options.skills.push(args[++i]); break;
      case "--tag": options.tags.push(args[++i]); break;
      case "--metric": options.metric = args[++i]; break;
      case "--expect": options.expected_direction = args[++i]; break;
      case "--session": options.session_id = args[++i]; break;
      case "--phase": options.phase = args[++i]; break;
      case "--status": options.status = args[++i]; break;
      case "--supersedes": options.supersedes = args[++i]; break;
      // Task category/scale are explicit-only through the CLI — a human or scripted caller stating
      // "this was a bug-fix touching 3 files" is task_category_source: "explicit" by construction.
      // Inferred task classification (telemetry-task-infer.mjs) is a Phase 5+ analysis-time concern,
      // not something this command computes itself.
      case "--task-category": options.task_category = args[++i]; break;
      case "--files-touched": options.files_touched = Number(args[++i]); break;
      case "--directories-touched": options.directories_touched = Number(args[++i]); break;
      case "--insertions": options.insertions = Number(args[++i]); break;
      case "--deletions": options.deletions = Number(args[++i]); break;
      default:
        console.error(`unknown argument: ${arg}`);
        console.error(MARK_USAGE);
        process.exit(2);
    }
  }
  return options;
}

function telemetryMark(args) {
  const options = parseMarkArgs(args);
  if (!options.type || !MARKER_TYPES.has(options.type)) {
    console.error(`--type is required and must be one of: ${[...MARKER_TYPES].join(", ")}`);
    console.error(MARK_USAGE);
    process.exit(2);
  }
  if (!options.title || !options.title.trim()) {
    console.error("--title is required");
    console.error(MARK_USAGE);
    process.exit(2);
  }
  if (options.expected_direction && !EXPECTED_DIRECTIONS.has(options.expected_direction)) {
    console.error(`--expect must be one of: ${[...EXPECTED_DIRECTIONS].join(", ")}`);
    process.exit(2);
  }
  if (options.type === "outcome" && (!options.status || !OUTCOME_STATUSES.has(options.status))) {
    console.error(`outcome markers require --status to be one of: ${[...OUTCOME_STATUSES].join(", ")}`);
    process.exit(2);
  }
  if (options.type === "phase" && !options.phase) {
    console.error("phase markers require --phase");
    process.exit(2);
  }
  if (options.task_category != null && !TASK_CATEGORIES.has(options.task_category)) {
    console.error(`--task-category must be one of: ${[...TASK_CATEGORIES].join(", ")}`);
    process.exit(2);
  }
  if (options.task_category != null && options.type !== "outcome") {
    console.error("--task-category is only valid on outcome markers (--type outcome)");
    process.exit(2);
  }
  let marker;
  try {
    marker = createMarker(options);
  } catch (err) {
    console.error(`failed to create marker: ${err.message}`);
    process.exit(1);
  }
  console.log(`marker: ${marker.marker_id}`);
  console.log(`  ts: ${marker.ts}`);
  console.log(`  type: ${marker.type}`);
  console.log(`  title: ${marker.title}`);
  console.log(`  repo: ${marker.repo ?? "unknown"}  branch: ${marker.branch ?? "unknown"}  sha: ${marker.sha ?? "unknown"}`);
  console.log(`  snapshot: ${marker.config_snapshot_id ?? "unavailable"}`);
  if (marker.task_category) {
    console.log(`  task_category: ${marker.task_category} (${marker.task_category_source})`);
  }
  if (marker.task_scale) {
    console.log(`  task_scale: files=${marker.task_scale.files_touched ?? "?"} dirs=${marker.task_scale.directories_touched ?? "?"} +${marker.task_scale.insertions ?? "?"}/-${marker.task_scale.deletions ?? "?"} cross_cutting=${marker.task_scale.cross_cutting}`);
  }
}

// --------------------------------------------------------------------------- experiments

const EXPERIMENT_USAGE = "usage: roborepo telemetry experiment start --title <title> --metric <id> "
  + "--expect increase|decrease|no-change [--guardrail <id>]... [--task-category <id>]... "
  + "[--minimum-sessions <n>] [--comparison previous-equivalent-window|midpoint]\n"
  + "       roborepo telemetry experiment end <experiment-id>\n"
  + "       roborepo telemetry experiment status [<experiment-id>]";

function parseExperimentStartArgs(args) {
  const options = { guardrails: [], task_categories: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--title": options.title = args[++i]; break;
      case "--metric": options.metric = args[++i]; break;
      case "--expect": options.expected_direction = args[++i]; break;
      case "--guardrail": options.guardrails.push(args[++i]); break;
      case "--task-category": options.task_categories.push(args[++i]); break;
      case "--minimum-sessions": options.minimum_sessions_per_cohort = Number(args[++i]); break;
      case "--comparison": options.comparison = args[++i]; break;
      default:
        console.error(`unknown argument: ${arg}`);
        console.error(EXPERIMENT_USAGE);
        process.exit(2);
    }
  }
  return options;
}

function telemetryExperiment(args) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "start":
      return telemetryExperimentStart(rest);
    case "end":
      return telemetryExperimentEnd(rest);
    case "status":
      return telemetryExperimentStatus(rest);
    default:
      console.error(EXPERIMENT_USAGE);
      process.exit(2);
  }
}

function telemetryExperimentStart(args) {
  const options = parseExperimentStartArgs(args);
  if (!options.title || !options.title.trim()) {
    console.error("--title is required");
    console.error(EXPERIMENT_USAGE);
    process.exit(2);
  }
  if (!options.metric || !options.metric.trim()) {
    console.error("--metric is required");
    console.error(EXPERIMENT_USAGE);
    process.exit(2);
  }
  if (!options.expected_direction || !EXPECTED_DIRECTIONS.has(options.expected_direction)) {
    console.error(`--expect is required and must be one of: ${[...EXPECTED_DIRECTIONS].join(", ")}`);
    process.exit(2);
  }
  if (options.minimum_sessions_per_cohort != null && (!Number.isInteger(options.minimum_sessions_per_cohort) || options.minimum_sessions_per_cohort < 1)) {
    console.error("--minimum-sessions must be a positive integer");
    process.exit(2);
  }
  let result;
  try {
    result = startExperiment(options);
  } catch (err) {
    console.error(`failed to start experiment: ${err.message}`);
    process.exit(1);
  }
  console.log(`experiment: ${result.experiment.experiment_id}`);
  console.log(`  title: ${result.experiment.title}`);
  console.log(`  start marker: ${result.startMarker.marker_id}`);
  console.log(`  primary metric: ${result.experiment.primary_metric} (expect ${result.experiment.expected_direction})`);
}

function telemetryExperimentEnd(args) {
  const [experimentId, ...rest] = args;
  rejectArgs(rest);
  if (!experimentId) {
    console.error(EXPERIMENT_USAGE);
    process.exit(2);
  }
  let result;
  try {
    result = endExperiment(experimentId);
  } catch (err) {
    console.error(`failed to end experiment: ${err.message}`);
    process.exit(1);
  }
  console.log(`experiment ended: ${result.experiment.experiment_id}`);
  console.log(`  end marker: ${result.endMarker.marker_id}`);
}

function telemetryExperimentStatus(args) {
  const [experimentId, ...rest] = args;
  rejectArgs(rest);
  let statuses;
  try {
    statuses = experimentStatus(experimentId || null);
  } catch (err) {
    console.error(`failed to read experiment status: ${err.message}`);
    process.exit(1);
  }
  if (statuses.length === 0) {
    console.log("no experiments found.");
    return;
  }
  for (const status of statuses) {
    console.log(`experiment: ${status.experiment_id}  [${status.state}]`);
    console.log(`  title: ${status.title}`);
    console.log(`  metric: ${status.primary_metric} (expect ${status.expected_direction})`);
    console.log(`  started: ${status.started_at ?? "unknown"}${status.ended_at ? `  ended: ${status.ended_at}` : ""}`);
    if (status.guardrails.length) console.log(`  guardrails: ${status.guardrails.join(", ")}`);
    console.log(`  ready: ${status.ready}`);
    if (status.cohorts) {
      console.log(`  cohorts: before=${status.cohorts.before.sessions} sessions (${formatMetricValue(status.cohorts.before.value)}), after=${status.cohorts.after.sessions} sessions (${formatMetricValue(status.cohorts.after.value)})`);
      console.log(`  effect size: ${status.effect_size == null ? "unknown" : status.effect_size}  confidence: ${status.confidence}`);
    }
    for (const warning of status.data_quality_warnings) console.log(`  warning: ${warning}`);
  }
}

// Telemetry-only install: wires just the 5 capture hooks into the harness settings files, without
// touching the rest of roborepo's operational hooks or presets. Intended for Claude/Codex users who
// want token visibility before committing to a full roborepo install.
function telemetryInstall(args) {
  rejectArgs(args);
  // Symlink ~/.local/bin/roborepo → repo bin (only if not already there).
  wireBinSymlink();
  // Write state directly — no presetsApply, so operational hooks are not touched.
  ensureTelemetryDirs();
  writeTelemetryState({ enabled: true });
  markTelemetrySelected(true);
  // Wire capture hooks into whichever registered providers are actually installed on this machine.
  for (const provider of listHarnessProviders()) {
    if (!provider.manifest.capabilities.includes("telemetry-capture")) continue;
    if (!fs.existsSync(harnessHome[provider.id])) continue;
    wireCaptureHooks(provider.id);
  }
  console.log("telemetry-only install complete.");
  console.log("capture is enabled.");
  console.log("open the portal:       roborepo web");
  console.log("view reports:          roborepo telemetry report");
  console.log("upgrade to full suite: re-run the roborepo install script");
}

function wireBinSymlink() {
  const target = path.join(os.homedir(), ".local", "bin", "roborepo");
  const source = path.join(repoRoot, "bin", "roborepo");
  let existing = null;
  try { existing = fs.lstatSync(target); } catch {}
  if (existing) {
    // Already exists: report ok if it's already pointing to this repo's bin; otherwise skip — never
    // overwrite a symlink the user may have pointing to a different roborepo clone.
    const current = existing.isSymbolicLink()
      ? path.resolve(path.dirname(target), fs.readlinkSync(target))
      : null;
    if (current === source) {
      console.log(`ok: ${target}`);
    } else {
      console.log(`skip: ${target} already exists — link it manually if needed`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target);
  console.log(`link: ${target} -> ${source}`);
}

// Dispatches to the provider's own telemetry.wireCaptureHooks adapter (which merges its fixed
// hooks-<id>.json fragment via the same hook-merge math the package-driven `enable telemetry` path
// uses), then writes the result through the same drift-tracked-for-Claude/plain-for-Codex path
// hook-composition.mjs uses — never two independently-maintained hook-write implementations.
function wireCaptureHooks(harness) {
  const filePath = hookFilePath(harness, { claudeSettingsPath: rootConfigActive.claude });
  const { changed, content } = getHarnessProvider(harness).adapters.telemetry.wireCaptureHooks(filePath);
  if (changed) {
    writeHooksFile(harness, filePath, content);
    console.log(`wired: telemetry capture hooks (${harness}) → ${filePath}`);
  } else {
    console.log(`ok: telemetry capture hooks already present (${harness}) → ${filePath}`);
  }
}

async function telemetryEnable(args) {
  rejectArgs(args);
  const result = await mutatePackage("telemetry", true);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log("telemetry: enabled");
  console.log("note: capture adds a small amount of overhead to every tool call (reads the transcript to size the latest turn).");
  telemetryStatus([]);
}

async function telemetryDisable(args) {
  rejectArgs(args);
  const result = await mutatePackage("telemetry", false);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log("telemetry: disabled");
}

// Programmatic capture-state toggle, shared by the CLI verbs and the config controls. Only flips the
// service's own enabled flag/selection state — hook install/removal is a separate `hooks` component
// on the telemetry package, handled by the generic enable/disable switch in packages.mjs. Does not
// start/stop the portal server — the dashboard toggle is about capture, not the server. Returns
// { ok, message }.
export function setTelemetryEnabled(enabled) {
  try {
    ensureTelemetryDirs();
    writeTelemetryState({ enabled });
    markTelemetrySelected(enabled);
    return { ok: true, message: `telemetry ${enabled ? "enabled" : "disabled"}` };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

function telemetryStatus(args) {
  rejectArgs(args);
  const state = readTelemetryState();
  console.log(`enabled: ${state.enabled === true ? "yes" : "no"}`);
  console.log(`spool:    ${telemetrySpoolDir}`);
  console.log(`collector:${telemetryCollectorDir}`);
}

function telemetryReport(args) {
  rejectSupportedReportArgs(args);
  const deep = args.includes("--deep");
  const state = readTelemetryState();
  const events = readSpoolEvents();
  if (events.length === 0) {
    console.log("No telemetry events yet.");
    console.log(`Capture enabled: ${state.enabled === true ? "yes" : "no"}`);
    return;
  }
  const markers = readMarkers();
  const report = analyzeTelemetry(events, { markers, snapshots: readSnapshots() });
  if (args.includes("--conditions")) console.log(JSON.stringify(report.conditions, null, 2));
  // Headline first: the deterministic "what this means" conclusions, before any raw table.
  printInsights(report.insights);
  printDataQualityWarnings(report.data_quality_warnings);
  printReadWarnings(report.read_warnings);
  printCodexProviderRateLimits(report.codex_provider_rate_limits);
  if (deep) printDeepRead(report);
  console.log(`\nevents: ${report.event_count}  (with token data: ${report.capture_count})`);
  printTop("repos", countBy(events, (event) => event.repo?.label ?? "unknown"));
  printTop("tools/events", countBy(events, (event) => event.tool?.name ?? event.event ?? "unknown"));
  // Recent markers (plan CLI report change: "recent markers"). Shown even when there is no token
  // data yet, since markers can exist independent of capture activity.
  printRecentMarkers(markers);
  printExperimentReadiness();
  if (report.capture_count === 0) {
    console.log("\n(no token-bearing records yet — start a session with telemetry enabled to populate spike analysis)");
    return;
  }
  printUsageWindows(report.usage_windows);
  printSpikeCauses(report.spike_causes);
  printTestingEfficiency(report.testing_efficiency);
  // Conclusions first — the actionable headlines before the raw contributor tables.
  printGroupCost(report.group_cost);
  printToolCost(report.tool_cost);
  printSpikeAnatomy(report.spike_anatomy);
  printRegression(report.regression);
  printLoops(report.loops);
  printSessions(report.sessions);
  printSpikes(report);
  printTokenContributors("token by repo", report.top_repos);
  printTokenContributors("token by tool", report.top_tools);
  printTokenContributors("token by MCP server", report.top_mcp);
  printComparison(report.comparison);
}

// Plan CLI report change: "recent markers" — the latest few, newest first, so a terminal report
// shows what has been marked without requiring a separate `telemetry mark --list` (which does not
// exist; export is the only current bulk-read path).
function printRecentMarkers(markers) {
  if (!markers.length) return;
  const recent = [...markers].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 5);
  console.log("\nrecent markers:");
  for (const m of recent) {
    console.log(`  ${m.ts}  [${m.type}]  ${m.title}${m.metric ? `  (metric: ${m.metric})` : ""}`);
  }
}

// Plan CLI report change: "experiment readiness/results" — mirrors telemetryExperimentStatus's
// printer so the CLI report and `telemetry experiment status` never disagree on wording.
function printExperimentReadiness() {
  let statuses;
  try {
    statuses = experimentStatus(null);
  } catch {
    return;
  }
  const running = statuses.filter((s) => s.state === "running");
  if (!running.length) return;
  console.log("\nexperiment readiness:");
  for (const status of running) {
    const cohortSummary = status.cohorts ? `before=${status.cohorts.before.sessions} after=${status.cohorts.after.sessions}` : "no cohort data";
    console.log(`  ${status.title}  ready=${status.ready}  ${cohortSummary}${status.confidence ? `  confidence=${status.confidence}` : ""}`);
  }
}

// Plan CLI report change: "testing efficiency" section, same metric registry values the portal's
// testing-efficiency panel reads — CLI and portal must agree for the same cohort (acceptance
// criterion 11).
function printTestingEfficiency(summary) {
  const share = summary["test.share_of_tool_time"];
  const fullPerSession = summary["test.full_suite_calls_per_session"];
  const redundant = summary["test.full_suite_without_intervening_edit"];
  if (share == null && fullPerSession == null && redundant == null) return;
  console.log("\ntesting efficiency:");
  if (share != null) console.log(`  testing share of tool time: ${share}%`);
  if (fullPerSession != null) console.log(`  full-suite runs/session: ${fullPerSession.toFixed(2)}`);
  if (summary["test.full_suite_calls_per_debug_phase"] != null) console.log(`  full-suite runs/debugging phase: ${summary["test.full_suite_calls_per_debug_phase"].toFixed(2)}`);
  if (redundant != null) console.log(`  redundant reruns (no intervening edit): ${redundant}`);
  if (summary["test.full_suite_unchanged_failure_signature"] != null) console.log(`  reruns with unchanged failure signature: ${summary["test.full_suite_unchanged_failure_signature"]}`);
  if (summary["test.targeted_to_full_ratio"] != null) console.log(`  targeted-to-full ratio: ${summary["test.targeted_to_full_ratio"].toFixed(2)}`);
}

// Trailing-window consumption is a local estimate from capture deltas — not the real server-side
// Claude rate limit, which telemetry can't see. Labeled as such so it's never mistaken for quota.
function printUsageWindows(windows) {
  if (!windows) return;
  console.log("\nrecent token usage (local estimate, not server rate limit):");
  console.log(`  last 5h:  ~${fmt(windows.five_hour).padStart(12)} tok`);
  console.log(`  last 7d:  ~${fmt(windows.seven_day).padStart(12)} tok`);
}

function printDataQualityWarnings(warnings) {
  if (!warnings || warnings.length === 0) return;
  console.log("\ndata quality warnings:");
  for (const warning of warnings.slice(0, 8)) {
    console.log(`  ${warning.harness || "unknown"} ${warning.type}: ${warning.hint} (${warning.events} events)`);
  }
}

function printReadWarnings(warnings) {
  if (!warnings || warnings.length === 0) return;
  console.log("\nread warnings:");
  for (const warning of warnings.slice(0, 8)) {
    const size = warning.approx_tokens ? ` ~${fmt(warning.approx_tokens)} tok` : "";
    const file = warning.file_ext ? ` ${warning.file_ext}/${warning.file_path_hash || "unknown"}` : "";
    console.log(`  ${warning.type} ${warning.repo}/${warning.session_short_id}${file}${size}: ${warning.hint}`);
  }
}

function printCodexProviderRateLimits(rateLimits) {
  if (!rateLimits) return;
  const rows = Array.isArray(rateLimits) ? rateLimits : [rateLimits];
  if (rows.length === 0) return;
  console.log("\nCodex provider rate limits (provider-reported, not local estimate):");
  for (const row of rows.slice(0, 4)) {
    const label = row.name || "limit";
    const used = typeof row.used_percent === "number" ? `${row.used_percent}% used` : "usage unknown";
    const window = typeof row.window_minutes === "number" ? `, ${row.window_minutes}m window` : "";
    console.log(`  ${label}: ${used}${window}`);
  }
}

// The actionable headline: each token spike grouped by the pattern that drove it, with the change to
// make. Answers "what am I doing that blows up my tokens" instead of a wall of per-capture numbers.
function printSpikeCauses(causes) {
  if (!causes || causes.length === 0) return;
  console.log("\nwhat's causing spikes (biggest token cost first):");
  for (const cause of causes.slice(0, 8)) {
    console.log(`  ${cause.cause.padEnd(22)} n=${String(cause.spikes).padEnd(3)} avg Δ=${fmt(cause.avg_delta).padStart(9)} tok  worst @${cause.worst_repo}`);
    console.log(`    → ${cause.hint}`);
  }
}

// The headline: deterministic conclusions, before any raw table. Severity-marked so the high-signal
// findings (tail risk, loops) stand out.
function printInsights(insights) {
  if (!insights || insights.length === 0) return;
  const mark = { high: "▲", warn: "△", info: "·" };
  console.log("\n══ what this means ══");
  for (const f of insights) {
    console.log(`  ${mark[f.severity] || "·"} ${f.headline}`);
    console.log(`      ${f.detail}`);
  }
}

// Optional LLM "deeper read": send the computed summary (not raw spool) to `claude -p` for a written
// synthesis. Best-effort — degrades to a note if the claude CLI is unavailable.
function printDeepRead(report) {
  const result = runDeepRead(report);
  console.log("\n══ deeper read (claude) ══");
  console.log(result.ok ? indent(result.text.trim(), "  ") : `  (${result.note})`);
}

function indent(text, pad) {
  return text.split("\n").map((l) => pad + l).join("\n");
}

// Native-vs-MCP head-to-head: avg context-tokens dropped per call, by functional group. The signal
// for "is the MCP cheaper than the Read/Grep it replaces". Approximate (result size ÷ 4).
function printGroupCost(groups) {
  if (!groups || groups.length === 0) return;
  console.log("\ncost per call by group (approx tokens from result size):");
  for (const g of groups) {
    console.log(`  ${g.group.padEnd(14)} ${fmt(g.avg_tokens).padStart(7)} tok/call  (${g.calls} calls)`);
  }
}

function printToolCost(tools) {
  if (!tools || tools.length === 0) return;
  console.log("\ncost per call by tool (approx tokens from result size):");
  for (const t of tools.slice(0, 10)) {
    console.log(`  ${t.tool.padEnd(24)} avg ${fmt(t.avg_tokens).padStart(7)}  max ${fmt(t.max_tokens).padStart(8)}  (${t.calls})`);
  }
}

// Lift > 1 means that group drives spikes more than its everyday share — "spikes are X-heavy".
function printSpikeAnatomy(anatomy) {
  if (!anatomy || anatomy.groups.length === 0) return;
  console.log(`\nwhat's different in spikes (${anatomy.spike_count} spike vs ${anatomy.normal_count} normal results):`);
  for (const g of anatomy.groups.slice(0, 6)) {
    const lift = g.lift == null ? "only-in-spikes" : `${g.lift}× vs normal`;
    console.log(`  ${g.group.padEnd(14)} ${lift.padEnd(16)} ${Math.round(g.spike_share * 100)}% of spike results  avg ${fmt(g.avg_tokens)} tok`);
  }
}

// Earlier vs later half: a positive delta means that group got more expensive over time — the
// "did my recent change make context heavier" signal.
function printRegression(regression) {
  if (!regression || regression.groups.length === 0) return;
  console.log(`\nregression (earlier vs later half, split @ ${regression.split_ts?.slice(0, 19)}):`);
  for (const g of regression.groups.slice(0, 6)) {
    const arrow = g.delta_tokens > 0 ? "↑" : g.delta_tokens < 0 ? "↓" : "·";
    console.log(`  ${g.group.padEnd(14)} ${fmt(g.before_avg_tokens).padStart(6)} → ${fmt(g.after_avg_tokens).padStart(6)} tok/call  ${arrow}${fmt(Math.abs(g.delta_tokens))}`);
  }
}

function printLoops(loops) {
  if (!loops || loops.length === 0) return;
  console.log("\n⚠ loops detected (same tool fired repeatedly in one session):");
  for (const l of loops.slice(0, 6)) {
    console.log(`  ${l.repo}/${shortId(l.session_id)}  ${l.tool} ×${l.max_repeat}  → ${l.hint}`);
  }
}

function printSessions(sessions) {
  console.log("\nsessions (by total tokens):");
  for (const session of sessions.slice(0, 8)) {
    const repoBranch = session.repo + (session.branch ? `@${session.branch}` : "");
    const label = `${repoBranch} ${session.harness ?? ""} ${shortId(session.session_id)}`.trim();
    console.log(`  ${label.padEnd(36)} ${fmt(session.total_tokens).padStart(10)} tok  ${session.tool_calls} tools  ${session.mcp_calls} mcp`);
  }
}

function printSpikes(report) {
  console.log(`\ntoken spikes (delta >= ${fmt(report.spike_threshold)} tok):`);
  if (report.spikes.length === 0) {
    console.log("  none — no capture exceeded the spike threshold");
    return;
  }
  for (const spike of report.spikes.slice(0, 8)) {
    const where = `${spike.repo}/${shortId(spike.session_id)}`;
    console.log(`  ${spike.ts.slice(0, 19)}  ${where.padEnd(24)} +${fmt(spike.delta_tokens).padStart(8)} tok  ${spike.event}${spike.tool ? ` (${spike.tool})` : ""}`);
  }
}

function printTokenContributors(label, rows) {
  if (rows.length === 0) return;
  console.log(`\n${label}:`);
  for (const row of rows.slice(0, 8)) {
    console.log(`  ${String(row.key).padEnd(24)} ${fmt(row.tokens).padStart(10)} tok  (${row.captures})`);
  }
}

// Terse metric-value formatter for the experiment status printout. Mirrors telemetry-compare.mjs's
// internal formatMetricValue (kept local here since the CLI print layer doesn't import compare.mjs's
// private helpers) — used only for human-readable output, never fed back into a comparison.
function formatMetricValue(value) {
  if (value == null) return "unknown";
  return String(Math.round(value * 100) / 100);
}

function printComparison(comparison) {
  console.log("\nspike vs normal captures:");
  for (const [label, stats] of [["spike", comparison.spike], ["normal", comparison.normal]]) {
    console.log(`  ${label.padEnd(8)} n=${String(stats.count).padEnd(4)} avg Δ=${fmt(stats.avg_delta).padStart(8)} tok  avg tools=${stats.avg_tool_calls}  mcp rate=${stats.mcp_rate}`);
  }
}

function telemetryExport(args) {
  rejectSupportedReportArgs(args);
  console.log(JSON.stringify({
    captures: readSpoolEvents(),
    markers: readMarkers(),
    snapshots: readSnapshots(),
    experiments: readExperiments(),
  }, null, 2));
}

// Backs the Telemetry page's "view docs" popup: renders docs/user/guides/telemetry.md server-side
// (same renderMarkdown() used by the Config page's skill-source popup) so the page and the guide
// never drift into two separately-maintained copies of the same explanation. readSourceFile()
// confines the path inside repoRoot, so this can only ever serve this one repo-relative file.
function loadTelemetryGuide() {
  const guide = readSourceFile(path.join(repoRoot, "docs", "user", "guides", "telemetry.md"), "Tokens page user guide");
  if (guide.ok) guide.html = guide.html.replace(/(href|src)="(\.\.?\/[^"#]*)"/g, (_match, attribute, relative) =>
    `${attribute}="${path.posix.resolve("/docs/user/guides", relative)}"`);
  return guide;
}

export async function serveCommand(args, { allowPortFallback = false, openPath = "" } = {}) {
  const options = parseServeArgs(args);

  // First-run bootstrap: `roborepo web` must produce the same procedural machine state as
  // `roborepo init` on a fresh install, so the portal never runs on a machine that was never
  // initialized. This runs in the invoking process BEFORE the detach branch spawns its foreground
  // child (and before reuse/start), so the child inherits a completed initialization record and
  // takes the no-op path instead of racing this process's first-run mutation. On an already
  // initialized install this is a no-op and adds no extra startup work. `web` never passes
  // --force or --dry-run; it always uses the default non-forced, mutating path.
  //
  // Unlike `init`, `web` finalizes the initialization record immediately after the procedural
  // bootstrap: starting the portal IS web's first-run destination, so there is no separate
  // configuration step to wait for. If that configuration step is interrupted or fails, only the
  // in-progress record remains, and a later `roborepo init` resumes it.
  const bootstrap = ensureInitialized();
  if (bootstrap.status === "refused") {
    for (const line of describeNewerSchemaRefusal(bootstrap.schemaVersion)) console.error(line);
    process.exit(1);
  }
  if (bootstrap.status === "bootstrapped") {
    finalizeInitialization();
    if (bootstrap.phase === "in-progress") console.log("Resuming an interrupted initialization.");
    const detected = bootstrap.detected ?? [];
    if (detected.length === 0) {
      console.log("RoboRepo initialized.");
    } else {
      const names = detected.map(harnessDisplayName);
      console.log(`RoboRepo initialized. Detected harnesses: ${names.join(", ")}.`);
    }
  }

  // Remove synthetic records left by an earlier development-only mock implementation. Current
  // first-run mocks are in-memory Home data and never enter the canonical registry.
  purgePersistedMockRepositories({ stateRoot });

  if (options.detach) {
    const port = await startDetachedPortal(options.port, { allowPortFallback, portExplicit: options.portExplicit });
    const detachedPortalUrl = `http://127.0.0.1:${port}`;
    console.log(`roborepo portal: ${detachedPortalUrl}  (detached · use: roborepo web stop)`);
    if (options.open) openLocalUrl(`${detachedPortalUrl}${openPath}`);
    return;
  }
  const resolved = await resolvePortalPort(options.port, {
    allowPortFallback,
    portExplicit: options.portExplicit,
    warn: true,
  });
  if (resolved.reuse) {
    const existingUrl = `http://127.0.0.1:${resolved.port}`;
    writePid(resolved.port, resolved.pid);
    console.log(`roborepo portal already running: ${existingUrl}`);
    if (options.open) openLocalUrl(`${existingUrl}${openPath}`);
    return;
  }
  await killExistingServer(resolved.port);
  writePid(resolved.port, process.pid);
  options.port = resolved.port;
  const portalUrl = (port) => `http://127.0.0.1:${port}`;
  // Clean up the PID file (and stop the refresh timer) when the server exits cleanly (SIGTERM from
  // stop or OS shutdown).
  process.on("SIGTERM", () => { stopAnalysisRefresh(); clearPid(resolved.port); process.exit(0); });
  if (readTelemetryState().enabled !== true) {
    console.log("telemetry is disabled; serving whatever is already in the spool.");
  }
  // Warming the default view is deliberately NOT done here. It parses the whole spool, and that
  // cost scales with the spool: at ~45MB the first analyze takes ~30s, during which the process has
  // not called listen() yet. `roborepo web --detach` gives the child 3s to bind (waitForPortalReady)
  // and so declared every start a failure — on a machine whose spool had simply grown. It moved into
  // onListening below, so the socket is accepting before any of that work begins.
  // The server reads the spool through an incremental in-memory store (readSpoolEventsCached), so a
  // running dashboard reflects live captures without re-parsing the whole file each request. A
  // `window` ({ rangeMs, end }) scopes the whole report to a trailing time slice before analysis, so
  // every panel — not just the chart — reflects the dashboard's time filter. loadSession bridges a
  // flagged event to its chat transcript (file I/O lives here, not in the server).
  const repositoryOverview = createRepositoryOverviewService({
    loadRegistry: () => loadRegistry({ stateRoot }),
    loadRuntime: () => loadDeveloperRuntimeSnapshot(),
    loadPlans: () => loadCachedPlansSnapshot(),
    loadAutoDiscoveryEnabled: () => autoDiscoveryEnabled(),
    loadMockHomeOverview: mockHomeOverview,
    mockHomeEnabled: MOCK_FIRST_RUN_VIEWS_ENABLED,
    loadTelemetry: () => homeTelemetryProjection({
      enabled: readTelemetryState().enabled === true,
      projection: loadTelemetryRepositoryProjection(),
      fixtureRepositories: loadFixtureTelemetryRepositories(),
    }),
  });
  startPortalServer({
    port: options.port,
    // Phase 6 additions (model/repo/markerId) layer a normalized cohort filter on top of the
    // existing time/harness window; folded into cachedAnalysisJson's cache key (see
    // cachedAnalysisEntry above) so cohort-filtered views stay cached the same way the default
    // view is. See telemetry-analyze.mjs's analyzeTelemetry() options and telemetry-cohort.mjs for
    // the shared filter shape the CLI report will eventually reuse too.
    loadAnalysisJson: (window, harness, extra = {}) => cachedAnalysisJson(window, harness, extra),
    loadMockAnalysisJson: () => loadMockAnalysisJson(),
    loadSession: (req) => loadSessionDetail({
      ...req,
      spoolContext: sessionSpoolContext(req.id, readMarkers()),
      reportRows: sessionReportRows(req),
    }),
    loadInsightsLlm: () => loadInsightsLlm(),
    loadMarkers: () => readMarkers(),
    createMarkerFromRequest: (body) => createMarkerFromPortalRequest(body),
    loadExperiments: () => experimentStatus(null),
    createExperimentFromRequest: (body) => createExperimentFromPortalRequest(body),
    endExperimentFromRequest: (experimentId) => endExperimentFromPortalRequest(experimentId),
    loadTelemetryAnalysis: (body) => loadTelemetryAnalysisRequest(body),
    loadTelemetryGuide: () => loadTelemetryGuide(),
    loadConfig: () => readConfigSnapshot(),
    loadSetupState: () => loadSetupState(),
    refreshHarnesses: () => refreshHarnessState(),
    setHarnessEnabled: (id, enabled) => setHarnessEnabled(id, enabled),
    loadConfigSource: (params) => loadConfigSource(params),
    loadPlans: () => loadPlansSnapshot(),
    loadPlanDocument: (params) => loadPlanDocument(params),
    buildPlansPrompt: (params) => buildPlansPrompt(params),
    updatePlanPriority: (params) => updatePlanPriority(params),
    updatePlanLifecycle: (params) => updatePlanLifecycle(params),
    refreshPlans: () => refreshPlans(),
    loadDeveloperRuntime: () => loadDeveloperRuntimeSnapshot(),
    refreshDeveloperRuntime: () => refreshDeveloperRuntimeSnapshot(),
    updateDeveloperRuntimeSettings: (params) => updateDeveloperRuntimeSettings(params),
    setDeveloperRuntimeRepositoryVisibility: (params) => setDeveloperRuntimeRepositoryVisibility(params),
    setDeveloperRuntimeRepositoryPinned: (params) => setDeveloperRuntimeRepositoryPinned(params),
    forgetDeveloperRuntimeRepository: (params) => forgetDeveloperRuntimeRepository(params),
    loadDeveloperRuntimeHistory: (key) => loadDeveloperRuntimeHistory(key),
    loadDeveloperRuntimeMetadata: (key) => loadDeveloperRuntimeMetadata(key),
    loadRepositories: () => { reconcileTelemetryRepositories(); return loadRepositoriesPayload(); },
    loadRepository: (params) => loadRepositoryPayload(params),
    loadRepositoryAssociations: (params) => loadRepositoryAssociations(params),
    loadHomeOverview: () => repositoryOverview.loadHome(),
    loadRepositoryOverview: (params) => repositoryOverview.loadDetail(params),
    patchRepository: (params) => patchRepository(params),
    // Source changes alter which repositories exist, so the cached Plans snapshot is rebuilt after
    // each one; enabling auto-discovery starts the first process scan immediately.
    loadRepositorySources: () => loadRepositorySources(),
    addRepositorySource: (params) => afterSourceChange(addRepositorySource(params)),
    removeRepositorySource: (params) => afterSourceChange(removeRepositorySource(params)),
    setRepositorySourceEnabled: (params) => afterSourceChange(setRepositorySourceEnabled({ ...params, onAutoDiscoveryEnabled: startAutoDiscoveryScan })),
    refreshRepositorySources: (params) => afterSourceChange(refreshRepositorySources({ ...params, onAutoDiscoveryEnabled: startAutoDiscoveryScan })),
    wipeRepositoryList: () => {
      const payload = wipeRepositoryList();
      clearDeveloperRuntimeSnapshotCache();
      if (payload.autoDiscovery?.enabled) startAutoDiscoveryScan();
      return afterSourceChange(payload);
    },
    mutatePackage: (id, enabled) => mutatePackage(id, enabled),
    mutateSkill: (id, enabled) => setSkillInstalled(id, enabled),
    // Section-level bulk enable/disable (portal bulkToggle sections). Lazy import: keeps the
    // batch module (and its reconcile dependency) out of every non-portal code path.
    bulkPackageChange: (ids, enabled) =>
      import("./config-bulk.mjs").then((m) => m.applyBulkPackageChange(ids, enabled)),
    mutateBehavior: (behaviorId, bucket) => setBehaviorBucket(behaviorId, bucket),
    mutateCommand: (tokens, bucket) => setCommandBucket(tokens, bucket),
    // Managed cleanup, shared with `roborepo uninstall` so both consume one implementation of what
    // is safe to remove. Imported lazily: the portal starts on every `roborepo web` and has no
    // reason to load the uninstall path unless someone opens the Maintenance panel.
    uninstallPreview: async () => (await import("./uninstall.mjs")).uninstallPreview(),
    uninstallExecute: async () => (await import("./uninstall.mjs")).uninstallExecute(),
    onListening: (actualPort) => {
      setDeveloperRuntimePortalInfo({ port: actualPort });
      if (options.open) openLocalUrl(`${portalUrl(actualPort)}${openPath}`);
      // Deferred to the next tick so the ready-file write and this callback complete first: the
      // warm-up is synchronous and would otherwise block the event loop before the detaching parent
      // ever sees the child as ready. The dashboard's first request may still race it and pay the
      // analyze cost itself, which is the pre-existing behavior for a cold portal — the difference
      // is that the server is now listening while it happens.
      setTimeout(() => {
        reconcileTelemetryRepositories();
        try { refreshPlans(); } catch {}
        startAnalysisRefresh();
      }, 0);
    },
  });
}

function startAutoDiscoveryScan() {
  refreshDeveloperRuntimeSnapshot().then(() => { try { refreshPlans(); } catch {} }).catch(() => {});
}

function afterSourceChange(payload) {
  try { refreshPlans(); } catch {}
  return payload;
}

export function webStopCommand(args) {
  const port = parsePortalStopArgs(args);
  const stopped = stopServer(port);
  console.log(stopped ? "roborepo portal: stopped" : "roborepo portal: no server was running");
}

function parseServeArgs(args) {
  const options = { port: 4317, portExplicit: false, detach: false, open: true, allowZeroPort: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port") {
      options.port = Number(args[++i]);
      options.portExplicit = true;
    } else if (arg.startsWith("--port=")) {
      options.port = Number(arg.slice("--port=".length));
      options.portExplicit = true;
    }
    else if (arg === "--detach") options.detach = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--allow-zero-port") options.allowZeroPort = true;
    else rejectArgs([arg]);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || (options.port === 0 && !options.allowZeroPort)) {
    console.error("usage: roborepo web [--detach] [--no-open] [--port <n>]");
    process.exit(2);
  }
  return options;
}

function parsePortalStopArgs(args) {
  let port = 4317;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port") port = Number(args[++i]);
    else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
    else rejectArgs([arg]);
  }
  if (!Number.isInteger(port) || port < 0) {
    console.error("usage: roborepo web stop [--port <n>]");
    process.exit(2);
  }
  return port;
}

function telemetryPurge(args) {
  const backup = args.includes("--backup");
  const rest = args.filter((arg) => arg !== "--backup");
  if (rest.length !== 1 || rest[0] !== "--all") {
    console.error("usage: roborepo telemetry purge --all [--backup]");
    process.exit(2);
  }
  if (backup) {
    const archive = backupTelemetry();
    if (archive) console.log(`backup:  ${archive}`);
    else console.log("backup:  nothing to back up (no telemetry data)");
  }
  fs.rmSync(telemetryDir, { recursive: true, force: true });
  markTelemetrySelected(false);
  console.log(`purged: ${telemetryDir}`);
}

function telemetryBackup(args) {
  rejectArgs(args);
  const archive = backupTelemetry();
  if (archive) console.log(`backup: ${archive}`);
  else console.log("nothing to back up (no telemetry data yet)");
}

// Snapshots the current telemetry dir into a timestamped, gitignored copy under telemetryBackupDir
// (which lives outside telemetryDir, so a subsequent purge can't remove it). Returns the backup path,
// or null when there's nothing to copy. Uses fs.cpSync — no shell, no tar dependency.
function backupTelemetry() {
  if (!fs.existsSync(telemetryDir)) return null;
  const entries = fs.readdirSync(telemetryDir);
  if (entries.length === 0) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(telemetryBackupDir, `telemetry-${stamp}`);
  fs.mkdirSync(telemetryBackupDir, { recursive: true });
  fs.cpSync(telemetryDir, dest, { recursive: true });
  return dest;
}

function ensureTelemetryDirs() {
  fs.mkdirSync(telemetrySpoolDir, { recursive: true });
  fs.mkdirSync(telemetryCollectorDir, { recursive: true });
}

function telemetryStatePath() {
  return `${telemetryDir}/state.json`;
}

// Cheap change-detector for the spool: newest mtime + total size + file count across all .jsonl
// files. Captures append (mtime + size grow) and file add/remove (count changes), so it flips
// whenever a new telemetry event lands. Used to memoize loadAnalysis — the 5s dashboard poll and
// every page nav would otherwise re-read the whole spool and re-run the (~1.5s) analysis on data
// that hasn't changed, blocking the single-threaded server for other pages' requests meanwhile.
function spoolSignature() {
  let files = [];
  try {
    files = fs.readdirSync(telemetrySpoolDir).filter((file) => file.endsWith(".jsonl"));
  } catch {
    return "none";
  }
  let maxMtime = 0;
  let totalSize = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(telemetrySpoolDir, file));
      if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
      totalSize += stat.size;
    } catch {
      // File vanished between readdir and stat; ignore — the next tick re-signs the spool.
    }
  }
  // Cached reports embed markers and experiments (chart overlay, cohort/marker-relative
  // comparisons, the recent-markers list) alongside spool-derived data, so a marker/experiment
  // mutation must also invalidate the cache even though it never touches the spool directory
  // itself — otherwise a marker or experiment created through the portal would not appear in
  // /api/data until the next unrelated capture landed.
  let markersStamp = "0:0";
  try {
    const stat = fs.statSync(telemetryMarkersPath);
    markersStamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // No markers file yet; stable "0:0" until one is created.
  }
  // Experiments are one file per experiment_id (mutable in place — status/end_marker_id update),
  // so the signature is a count+max-mtime over the directory rather than a single file stamp.
  let experimentsStamp = "0:0";
  try {
    const experimentFiles = fs.readdirSync(telemetryExperimentsDir).filter((file) => file.endsWith(".json"));
    let maxExpMtime = 0;
    for (const file of experimentFiles) {
      const stat = fs.statSync(path.join(telemetryExperimentsDir, file));
      if (stat.mtimeMs > maxExpMtime) maxExpMtime = stat.mtimeMs;
    }
    experimentsStamp = `${experimentFiles.length}:${maxExpMtime}`;
  } catch {
    // No experiments dir yet; stable "0:0" until one is created.
  }
  let snapshotsStamp = "missing";
  try {
    snapshotsStamp = fs.readdirSync(telemetrySnapshotsDir).filter((file) => file.endsWith(".json")).sort().map((file) => {
      const stat = fs.statSync(path.join(telemetrySnapshotsDir, file));
      return `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }).join("|");
  } catch { /* Missing/evicted snapshot evidence is reevaluated as unknown. */ }
  return `${files.length}:${maxMtime}:${totalSize}|${markersStamp}|${experimentsStamp}|${snapshotsStamp}`;
}

// Plain full-read of the whole spool. Used by the one-shot CLI paths (`telemetry report`/`export`)
// where a resident store buys nothing — the process reads once and exits. The long-lived server
// uses readSpoolEventsCached() instead. Kept as the reference implementation the incremental store
// is tested against for equality.
function parsedSpoolRow(line, file, sequence) {
  const row = JSON.parse(line);
  Object.defineProperty(row, "spool_provenance", { value: { source: `spool:${file}`, sequence }, enumerable: false });
  return row;
}

export function readSpoolEvents() {
  const events = [];
  let files = [];
  try {
    files = fs.readdirSync(telemetrySpoolDir).filter((file) => file.endsWith(".jsonl"));
  } catch {
    return events;
  }
  for (const file of files) {
    const fullPath = path.join(telemetrySpoolDir, file);
    let sequence = 0;
    for (const line of fs.readFileSync(fullPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      sequence++;
      try {
        events.push(parsedSpoolRow(line, file, sequence));
      } catch {
        // Ignore partial/corrupt lines; hooks must never make reports fragile.
      }
    }
  }
  return events;
}

// Incremental spool store for the long-lived server. The spool is append-only (each capture is one
// `appendFileSync` of a newline-terminated line), so re-reading + re-parsing the whole 30MB+ file on
// every 5s poll and every page nav is pure waste — the dominant cost of the old request path. This
// keeps parsed events in memory per file and, on each sync, reads only the bytes appended since last
// time via readAppendedLines(). Nothing changed -> a few stat() calls; a few new events -> parse
// only those lines. The incremental byte-tail read (offset advance, partial-line hold, shrink/rotate
// detection) lives in jsonl-tail.mjs, shared with the transcript reader.
//
// Server-only: a single process owns this. The writer is a separate short-lived capture process, so
// the server never sees a torn write beyond a possible partial trailing line at EOF, which
// readAppendedLines holds back (an unterminated final line is not parsed until its newline lands).
const _spoolStore = new Map(); // filename -> { offset, events: object[] }
// Memoized flat concatenation of every file's events, returned as-is when nothing changed since the
// last sync. Without this, the common no-op call (the 5s poll / 2s refresh tick on an unchanged
// spool) would still spread ~35k events into a fresh array every time — the residual steady-state
// cost. `_spoolDirty` is set whenever a file is appended, added, or evicted, so the flat array is
// rebuilt only then.
let _spoolFlat = [];
let _spoolDirty = true;

export function readSpoolEventsCached() {
  let files;
  try {
    files = fs.readdirSync(telemetrySpoolDir).filter((file) => file.endsWith(".jsonl"));
  } catch {
    // Spool dir gone/unreadable — nothing to serve. Clear state and return an empty result.
    _spoolStore.clear();
    _spoolFlat = [];
    _spoolDirty = false;
    return _spoolFlat;
  }
  const present = new Set(files);
  // Drop store entries for files that vanished (e.g. a purge) so their events don't linger.
  for (const name of [..._spoolStore.keys()]) {
    if (!present.has(name)) { _spoolStore.delete(name); _spoolDirty = true; }
  }
  for (const file of files) syncSpoolFile(file);
  if (_spoolDirty) {
    _spoolFlat = [];
    for (const file of files) {
      const entry = _spoolStore.get(file);
      if (entry) _spoolFlat.push(...entry.events);
    }
    _spoolDirty = false;
  }
  return _spoolFlat;
}

// Bring one file's in-memory entry up to date via readAppendedLines(). Sets _spoolDirty when it
// actually parses new events, or when the file was added/rebuilt.
function syncSpoolFile(file) {
  let entry = _spoolStore.get(file);
  if (!entry) {
    entry = { offset: 0, events: [], sequence: 0 };
    _spoolStore.set(file, entry);
    _spoolDirty = true;
  }
  const { lines, nextOffset, rebuilt, ok } = readAppendedLines(
    path.join(telemetrySpoolDir, file),
    entry.offset,
  );
  if (!ok) return; // missing/unreadable; retried on the next sync (readdir still listed it)
  if (rebuilt) {
    // The file shrank/rotated (capSpool trim) — offset was past EOF, the read restarted from 0, so
    // discard the events accumulated from the pre-trim bytes before re-appending the current ones.
    entry.events = [];
    entry.sequence = 0;
    _spoolDirty = true;
  }
  for (const line of lines) {
    entry.sequence++;
    try {
      entry.events.push(parsedSpoolRow(line, file, entry.sequence));
      _spoolDirty = true;
    } catch {
      // Ignore corrupt lines, matching readSpoolEvents().
    }
  }
  entry.offset = nextOffset;
}

// Test hook: clear the store so a bench/test can measure a cold prime or force a rebuild.
export function _resetSpoolStoreForTests() {
  _spoolStore.clear();
  _spoolFlat = [];
  _spoolDirty = true;
}

// Restrict events to a trailing time window before analysis so the dashboard's time filter scopes
// the entire report. `end` (epoch ms) pins the window's right edge for panning; null follows the
// latest event. Null window returns everything unchanged. Events lacking a parseable ts are dropped
// when a window is active (they cannot be placed on the timeline).
function filterByWindow(events, window) {
  if (!window || !(window.rangeMs > 0) || events.length === 0) return events;
  const times = events.map((event) => Date.parse(event.ts)).filter((ms) => Number.isFinite(ms));
  if (times.length === 0) return events;
  const dataEnd = Math.max(...times);
  const end = Number.isFinite(window.end) ? window.end : dataEnd;
  const start = end - window.rangeMs;
  return events.filter((event) => {
    const ms = Date.parse(event.ts);
    return Number.isFinite(ms) && ms >= start && ms <= end;
  });
}

// Analysis cache: the dashboard's 5s poll and every cross-page nav call loadAnalysis, which re-reads
// the whole spool and runs the full (~1.5s) report. That work only changes when a new capture lands,
// so memoize the computed report per (spool signature + window + harness). On unchanged data the
// server answers in microseconds instead of blocking its single event loop for seconds — which is
// what made nav to other pages feel unresponsive while a poll was in flight. Bounded at 32 entries
// (a handful of range/harness combinations) so it can't grow without limit.
// Each entry stores the SERIALIZED JSON, not the report object. The default-view response is ~10MB,
// so JSON.stringify alone is ~100ms — re-serializing an unchanged report on every request (the route
// used to `JSON.stringify(loadAnalysis(...))` each time) was the remaining floor after the analyze
// cost was cached. Caching the string lets the hot /api/data path skip both analyze and stringify;
// the route sends it directly. Only the route consumes this, and it needs a string, so the report
// object is discarded once stringified rather than retained as dead memory.
const _analysisCache = new Map();
const ANALYSIS_CACHE_MAX = 32;
// Phase 6 additions (model/repo/markerId) layer a normalized cohort filter on top of the existing
// time/harness window; folded into the cache key so a cohort-filtered view gets its own cached
// entry instead of colliding with (or evicting) the unfiltered default view.
function analysisKey(window, harness, { model = null, repo = null, repository = null, markerId = null } = {}) {
  return `${spoolSignature()}|${window ? `${window.rangeMs}:${window.end ?? ""}` : "all"}|${harness || "all"}|${model || "all"}|${repo || "all"}|${repository || "all"}|${markerId || "none"}`;
}

// Returns the cache entry { json } for the given view, computing (and caching) it on a miss.
// Registry-derived hash index for read-time legacy telemetry association, cached by spool signature
// so it is rebuilt only when the spool changes (the registry is small; loading it is cheap, and a
// missing/corrupt registry degrades to an empty index rather than throwing).
let _repositoryHashIndex = null;
let _repositoryHashIndexSig = null;
// Matching capture's hash is what makes normalized_remote_hash values line up, and both sides now
// call the same helper rather than keeping two copies aligned by hand.
const captureRepositoryHash = privacyHash;
// Reconcile telemetry-observed repositories into the registry so `capabilities.telemetry` can be
// true. Runs at portal repo-list load (NOT on the capture hot path): scans the spool's distinct
// repository_ids and records one `telemetry` discovery each, batched into a single registry write.
// Agent sessions only attach to repositories a source already found; they never create one
// (pljvmyh). Cached by spool AND registry signature: a repository a folder or auto-discovery adds
// later picks up the session evidence already in the spool. Best-effort — a registry failure never
// breaks the repositories list.
let _telemetryReconcileSig = null;
export function reconcileTelemetryRepositories() {
  const sig = `${spoolSignature()}|${registrySignature()}`;
  if (_telemetryReconcileSig === sig) return;
  _telemetryReconcileSig = sig;
  const seen = new Set(); // repository_id
  for (const event of readSpoolEventsCached()) {
    const id = event?.repo?.repository_id;
    if (id) seen.add(id);
  }
  if (seen.size === 0) return;
  try {
    updateRegistry({
      stateRoot,
      mutate: (registry) => {
        let changed = false;
        for (const id of seen) {
          if (recordDiscoveryIfKnown(registry, id, { source: "telemetry", evidence: "telemetry-session", confidence: id.startsWith("git:") ? "high" : "medium" })) changed = true;
        }
        return changed;
      },
    });
  } catch {
    // Registry unavailable — telemetry capability just stays unreported; not fatal.
  }
}

// Signature of the registry file itself (mtime+size), so the hash index is rebuilt only when the
// REGISTRY changes — not on every spool change (the index is derived from the registry, not the
// spool). Missing file -> "none" so a first write invalidates.
function registrySignature() {
  try {
    const st = fs.statSync(repositoriesRegistryPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "none";
  }
}
function repositoryHashIndexCached() {
  const sig = registrySignature();
  if (_repositoryHashIndex && _repositoryHashIndexSig === sig) return _repositoryHashIndex;
  let registry;
  try {
    registry = loadRegistry({ stateRoot });
  } catch {
    registry = { repositories: {} };
  }
  _repositoryHashIndex = buildRepositoryHashIndex(registry, captureRepositoryHash);
  _repositoryHashIndexSig = sig;
  return _repositoryHashIndex;
}

function cachedAnalysisEntry(window, harness, extra = {}) {
  const { model = null, repo = null, repository = null, markerId = null } = extra;
  const key = analysisKey(window, harness, { model, repo, repository, markerId });
  const hit = _analysisCache.get(key);
  if (hit) return hit;
  const allEvents = readSpoolEventsCached();
  const markers = readMarkers();
  // Filter dropdowns cascade: harness is the top-level split, so the model/repo dropdowns should
  // only ever offer values that actually co-occur with the selected harness — picking "codex"
  // must not still list Claude-only models. Harness itself always lists every harness in the full
  // spool (nothing sits above it to narrow it). Model does not narrow repo, or vice versa — both
  // sit at the same level under harness — so each is scoped by harness alone, not by each other.
  const availableHarnesses = [...new Set(allEvents.map((e) => e.harness).filter(Boolean))].sort();
  const events = harness ? allEvents.filter((e) => e.harness === harness) : allEvents;
  const availableModels = [...new Set(events.map((e) => e.session?.model).filter(Boolean))].sort();
  const availableRepos = [...new Set(events.map((e) => e.repo?.label).filter(Boolean))].sort();
  const windowed = filterByWindow(events, window);
  // The global repository scope (?repository=<canonical-id>) composes with the legacy per-page
  // ?repo=<label> filter. When set, legacy events are resolved to a canonical id at read time via a
  // registry-derived hash index (built lazily; absent/broken registry -> unresolved, never a crash).
  const cohortFilter = (model || repo || repository)
    ? { models: model ? [model] : [], repos: repo ? [repo] : [], repository_ids: repository ? [repository] : [] }
    : null;
  const repositoryHashIndex = repositoryHashIndexCached();
  const report = analyzeTelemetry(windowed, { cohortFilter, markers, markerId, compareMetric: "tokens.total", repositoryHashIndex, snapshots: readSnapshots() });
  // Backfill session titles from transcripts: the transcript always has the first user message
  // (turn 1), whereas the spool only captures prompts when hooks fired — so new sessions or
  // sessions started before telemetry was enabled may have no spool title or a mid-chat title.
  // Cap at top 20 sessions to bound latency; titles are separately cached so 5s polls don't re-read.
  for (const s of report.sessions.slice(0, 20)) {
    const t = cachedTranscriptTitle(s.session_id, s.harness);
    if (t) s.title = t;
  }
  report.available_harnesses = availableHarnesses;
  // Display names for whichever harnesses are actually present — sourced from each provider's own
  // manifest (never a hardcoded "claude" -> "Claude Code" table here), so a new registered provider
  // needs no change in this file to get a real label instead of falling back to its bare id.
  report.harness_display_names = Object.fromEntries(
    availableHarnesses.map((id) => [id, hasHarnessProvider(id) ? getHarnessProvider(id).manifest.displayName : id]),
  );
  report.available_models = availableModels;
  report.available_repos = availableRepos;
  // Metric ids from the shared registry (plan: "available ... metric" dimension) so the Analysis
  // explorer's metric select never hand-maintains its own list.
  report.available_metrics = listMetrics().map((m) => m.id);
  // Window-scoped markers for the chart overlay (plan: "The server supplies window-scoped
  // markers"). Uses the same filterByWindow the events themselves went through.
  report.markers = filterByWindow(markers, window);
  report.experiments = readExperiments();
  report.deepread_cli = findDeepReadCli();
  // Cache the serialized JSON, not the report object: the only consumer is the /api/data route,
  // which sends the string, so retaining the ~10MB object per entry would be dead memory. The report
  // object is discarded once stringified.
  const entry = {
    json: JSON.stringify(report),
    repositoryProjection: buildTelemetryRepositoryProjection(allEvents, report, repositoryHashIndex),
  };
  // Prune the oldest entry once over the cap. Signature changes mint fresh keys on every new
  // capture, so stale-signature entries accumulate otherwise; Map preserves insertion order.
  if (_analysisCache.size >= ANALYSIS_CACHE_MAX) {
    _analysisCache.delete(_analysisCache.keys().next().value);
  }
  _analysisCache.set(key, entry);
  return entry;
}

// Serialized report JSON for the hot /api/data path, memoized per signature+window+harness+cohort.
function cachedAnalysisJson(window, harness, extra = {}) {
  return cachedAnalysisEntry(window, harness, extra).json;
}

export function loadTelemetryRepositoryProjection() {
  const key = analysisKey(null, null);
  return _analysisCache.get(key)?.repositoryProjection || {
    status: "unavailable",
    updatedAt: null,
    repositories: {},
  };
}

// Mock analysis for the /tokens page: reads the bundled mock spool file
// (portal/tokens/mock-spool.jsonl) and runs it through the same analyzeTelemetry()
// pipeline as real data. The mock spool is a committed .jsonl file with the same
// schema-2 record shape telemetryCapture() writes, so the only difference from real
// data is the source file — analyzeTelemetry() processes it identically. Cached so
// repeated requests don't re-parse the file.
let _mockAnalysisJson = null;
const MOCK_SPOOL_PATH = path.join(repoRoot, "portal", "tokens", "mock-spool.jsonl");
// Demo marker for the mock report: the mock spool is seeded with sessions on both sides of
// this timestamp so the "Before vs after your change" section has real pipeline output.
const MOCK_MARKER = {
  schema: 2,
  marker_id: "mark_0000000000000001",
  effective_at: "2026-06-13T12:00:00.000Z",
  scope: "all",
  watching_kinds: ["spike", "loop", "read-warning"],
  type: "change",
  title: "Prefer section-level document reads (demo)",
  ts: "2026-06-13T12:00:00.000Z",
};
// Rows of a committed .jsonl file. A missing file reads as no rows and a corrupt line is skipped,
// so a bad fixture file degrades to an empty view instead of failing the page.
function readJsonlFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* ignore corrupt lines */ }
  }
  return rows;
}

// Token warnings for the dev fixture repositories, from a committed schema-3 spool. It lives under
// local/, which npm installs never ship, so off a dev checkout this is empty. Parsed once per
// process, like the Tokens mock report.
const FIXTURE_TOKEN_SPOOL_PATH = path.join(repoRoot, "local", "dev-fixtures", "token-warnings-spool.jsonl");
let _fixtureTelemetryRepositories = null;
function loadFixtureTelemetryRepositories() {
  _fixtureTelemetryRepositories ??= fixtureTelemetryRepositories(readJsonlFile(FIXTURE_TOKEN_SPOOL_PATH));
  return _fixtureTelemetryRepositories;
}

function loadMockAnalysisJson() {
  if (_mockAnalysisJson) return _mockAnalysisJson;
  const events = readJsonlFile(MOCK_SPOOL_PATH);
  const evidence = conditionDemoEvidence(events);
  const collectingMarker = { ...MOCK_MARKER, marker_id: "mark_0000000000000002", title: "Limit retry loops (demo)",
    ts: "2026-06-15T11:59:00.000Z", effective_at: "2026-06-15T11:59:00.000Z", watching_kinds: ["loop"] };
  const report = analyzeTelemetry(evidence.events, { markers: [MOCK_MARKER, collectingMarker], markerId: MOCK_MARKER.marker_id, snapshots: evidence.snapshots });
  report.available_harnesses = [...new Set(evidence.events.map((e) => e.harness).filter(Boolean))].sort();
  report.harness_display_names = Object.fromEntries(
    (report.available_harnesses || []).map((id) => [id, hasHarnessProvider(id) ? getHarnessProvider(id).manifest.displayName : id]),
  );
  report.available_models = [...new Set(evidence.events.map((e) => e.session?.model).filter(Boolean))].sort();
  report.available_repos = [...new Set(evidence.events.map((e) => e.repo?.label).filter(Boolean))].sort();
  report.available_metrics = listMetrics().map((m) => m.id);
  report.markers = [];
  report.experiments = [];
  report.deepread_cli = findDeepReadCli();
  _mockAnalysisJson = JSON.stringify(report);
  return _mockAnalysisJson;
}

// Tier 2 — debounced default-view refresh. cachedAnalysisJson() still computes synchronously on a
// cache miss, but for the DEFAULT view (window=null, harness=null — what every page load and the 5s poll
// request) we keep the result warm PROACTIVELY on a background timer, so the request path reads a
// ready report instead of triggering the ~250ms analyze+stringify itself. That work is what still
// blocked the single-threaded server on the first request after each new capture.
//
// The timer polls the cheap spoolSignature(); when it changes it debounces (waits for a quiet gap,
// with a max-wait cap so a continuous capture stream still refreshes) and then recomputes the
// default view once. Windowed/panned/harness-filtered requests are user-initiated and stay
// on-demand (a brief spinner there is fine; precomputing every combination is infeasible).
//
// It's a setInterval/setTimeout — a timer on the existing thread, not a worker. The recompute still
// briefly occupies the event loop (~250ms), but now at most once per debounce window and between
// requests, rather than inside a request on every change.
const ANALYSIS_POLL_MS = 2000; // how often the timer checks the cheap signature
const ANALYSIS_DEBOUNCE_MS = 12000; // wait for this much quiet after the last change before recomputing
const ANALYSIS_MAX_WAIT_MS = 60000; // ...but never defer a refresh longer than this under a steady stream
let _refreshTimer = null;
// pendingSince doubles as the "is a change pending?" flag (0 = none) and the max-wait anchor;
// lastSeenAt is the last tick a change was observed, for the quiet-gap debounce.
const _refreshState = { lastSig: null, pendingSince: 0, lastSeenAt: 0 };

function refreshDefaultView() {
  // Populates _analysisCache under the current signature's default key so the request path is warm.
  try {
    cachedAnalysisEntry(null, null);
  } catch {
    // A transient read/analyze failure must not kill the refresh loop; the next tick retries.
  }
}

function tickAnalysisRefresh() {
  const sig = spoolSignature();
  const now = Date.now();
  if (sig !== _refreshState.lastSig) {
    // A change: (re)arm the debounce window. pendingSince anchors the max-wait; lastSeenAt the gap.
    _refreshState.lastSig = sig;
    if (!_refreshState.pendingSince) _refreshState.pendingSince = now;
    _refreshState.lastSeenAt = now;
    return;
  }
  // Stable this tick. If a change is pending, recompute once it's been quiet long enough OR the
  // max-wait cap has elapsed since the change was first seen.
  if (_refreshState.pendingSince) {
    const quietFor = now - _refreshState.lastSeenAt;
    const waitedFor = now - _refreshState.pendingSince;
    if (quietFor >= ANALYSIS_DEBOUNCE_MS || waitedFor >= ANALYSIS_MAX_WAIT_MS) {
      _refreshState.pendingSince = 0;
      refreshDefaultView();
    }
  }
}

// Start the background refresh loop for the running server. Primes the default view once up front so
// the very first page load is warm, then keeps it fresh on the debounced timer. `unref()` so the
// timer never keeps the process alive on its own.
function startAnalysisRefresh() {
  refreshDefaultView();
  _refreshState.lastSig = spoolSignature();
  _refreshTimer = setInterval(tickAnalysisRefresh, ANALYSIS_POLL_MS);
  _refreshTimer.unref?.();
}

function stopAnalysisRefresh() {
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = null;
}

// Title cache: transcripts are append-only so the first user message never changes. Cache by id so
// the 5-second dashboard poll doesn't re-stat/re-read files for every session on every tick.
const _titleCache = new Map();
// No silent default to Claude: an unrecognized/missing harness is a data-quality problem on this
// one session's spool record, not grounds to guess — this is a best-effort title backfill (a miss
// just leaves the spool's own title, if any), so it degrades to null rather than throwing.
function cachedTranscriptTitle(sessionId, harness) {
  if (_titleCache.has(sessionId)) return _titleCache.get(sessionId);
  if (!hasHarnessProvider(harness)) return null;
  const adapters = getHarnessProvider(harness).adapters;
  const p = adapters.transcripts.locate(sessionId);
  const t = p ? adapters.transcripts.parse(p, { includeHeavyTurns: true }).title : null;
  if (t) _titleCache.set(sessionId, t);
  return t;
}

// Phase 7 session-detail extension (plan: "Extend the current session modal with: model history,
// configuration snapshot, active packages/skills, explicit versus inferred task category and
// outcome, phase timeline, semantic operation totals, testing-efficiency summary, markers inside or
// adjacent to the session, data-quality flags"). Scans the already-loaded spool for this session's
// own captures (cheap: one session's records only, not a re-read) and pulls together everything
// derivable without touching the transcript. Best-effort throughout — missing data reports as
// unavailable rather than guessed.
function sessionSpoolContext(sessionId, markers) {
  if (!sessionId) return null;
  const events = readSpoolEvents().filter((e) => e.session_id === sessionId);
  if (!events.length) return null;
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));

  // Model history: every distinct model seen across this session's captures, in first-seen order.
  const modelHistory = [...new Set(sorted.map((e) => e.session?.model).filter(Boolean))];

  // Configuration snapshot: the most recent non-null snapshot id (a session may span more than one
  // if configuration changed mid-session per the snapshot schema's per-turn-override allowance).
  const snapshotIds = [...new Set(sorted.map((e) => e.config_snapshot_id).filter(Boolean))];
  const latestSnapshot = snapshotIds.length ? readSnapshot(snapshotIds[snapshotIds.length - 1]) : null;

  // Phase timeline: contiguous runs of the same phase.name, in order, with start/end timestamps.
  const phaseTimeline = [];
  for (const e of sorted) {
    const name = e.phase?.name ?? null;
    if (name == null) continue;
    const last = phaseTimeline[phaseTimeline.length - 1];
    if (last && last.name === name) last.end = e.ts;
    else phaseTimeline.push({ name, source: e.phase?.source ?? null, start: e.ts, end: e.ts });
  }

  // Semantic operation totals: count by operation.category.
  const operationTotals = {};
  for (const e of sorted) {
    if (!e.operation?.category) continue;
    operationTotals[e.operation.category] = (operationTotals[e.operation.category] || 0) + 1;
  }

  // Explicit outcome/task-category marker for this session, if any (kept distinguishable from any
  // future inferred value — the plan requires "explicit versus inferred" stay separate, and today
  // only explicit outcome markers set task_category, per Phase 4 notes).
  const outcomeMarker = markers.find((m) => m.type === "outcome" && m.session_id === sessionId) ?? null;

  // Markers "inside or adjacent to" the session: any marker whose timestamp falls within the
  // session's own [first, last] capture window, widened by a small adjacency margin.
  const ADJACENCY_MS = 15 * 60 * 1000;
  const sessionStart = Date.parse(sorted[0].ts) - ADJACENCY_MS;
  const sessionEnd = Date.parse(sorted[sorted.length - 1].ts) + ADJACENCY_MS;
  const nearbyMarkers = markers.filter((m) => {
    const ms = Date.parse(m.ts);
    return Number.isFinite(ms) && ms >= sessionStart && ms <= sessionEnd;
  });

  // Data-quality flags: same reliability dimensions the metrics registry tracks, scoped to this
  // session so a modal can show "this session's data is thinner than usual" at a glance.
  const flags = [];
  if (!snapshotIds.length) flags.push("no configuration snapshot recorded for this session");
  if (!modelHistory.length) flags.push("model unknown for every capture in this session");
  const v3Count = sorted.filter((e) => e.schema === 3).length;
  if (v3Count < sorted.length) flags.push(`${sorted.length - v3Count} of ${sorted.length} captures predate schema v3 (fewer derived fields)`);

  return {
    model_history: modelHistory,
    config_snapshot: latestSnapshot ? { snapshot_id: latestSnapshot.snapshot_id, packages: latestSnapshot.packages, skills: latestSnapshot.skills, harness: latestSnapshot.harness } : null,
    phase_timeline: phaseTimeline,
    operation_totals: operationTotals,
    outcome: outcomeMarker ? { status: outcomeMarker.status, task_category: outcomeMarker.task_category ?? null, task_category_source: outcomeMarker.task_category_source ?? null, source: "explicit" } : { status: "unknown", task_category: null, source: "none" },
    nearby_markers: nearbyMarkers.map((m) => ({ marker_id: m.marker_id, type: m.type, title: m.title, ts: m.ts })),
    data_quality_flags: flags,
  };
}

// Pull one session's rows out of the (cached) analyzed report so the session popup can show
// deterministic "what happened" findings without re-running the pipeline. Rows live in the report
// keyed by [harness, session_id]; the testing summary is report-global so it rides along as-is. Returns null
// when the report can't be computed (e.g. no spool) — the session endpoint still works, just
// without findings.
function sessionReportRows({ id, harness }) {
  try {
    const report = JSON.parse(cachedAnalysisJson(null, null));
    const match = (rows) => (rows || []).filter((r) => r.session_id === id);
    const harnessMatch = (rows) => match(rows).filter((r) => !harness || r.harness === harness);
    return {
      spikes: harnessMatch(report.spikes),
      loops: harnessMatch(report.loops),
      read_warnings: harnessMatch(report.read_warnings),
      testing_efficiency: report.testing_efficiency || null,
    };
  } catch {
    return null;
  }
}

// Resolve a flagged event to its chat: find the transcript, surface the heaviest turns, and build a
// paste-ready analysis prompt. Best-effort — a missing transcript returns found:false, never throws.
// `reportRows` (optional) carries the session's own rows from the analyzed report (spikes, loops,
// read warnings) plus the report-global testing summary, so deriveSessionFindings() can emit the
// deterministic "what happened" prose alongside the transcript facts. When a caller has no report
// in scope, findings are simply omitted — the transcript path still works unchanged.
function loadSessionDetail({ id, harness, finding, repo, spoolContext = null, reportRows = null }) {
  const adapters = getHarnessProvider(harness).adapters;
  const transcriptPath = adapters.transcripts.locate(id);
  const findings = reportRows
    ? deriveSessionFindings({ sessionId: id, ...reportRows })
    : null;
  if (!transcriptPath) {
    return {
      found: false,
      session_id: id,
      harness,
      analysis_prompt: buildAnalysisPrompt({ sessionId: id, harness, repo, finding, transcriptPath: null }),
      findings,
      spool_context: spoolContext,
    };
  }
  const { heavyTurns, title } = adapters.transcripts.parse(transcriptPath, { includeHeavyTurns: true });
  return {
    found: true,
    session_id: id,
    harness,
    transcript_path: transcriptPath,
    title,
    heavy_turns: heavyTurns,
    analysis_prompt: buildAnalysisPrompt({ sessionId: id, harness, repo, finding, transcriptPath }),
    findings,
    spool_context: spoolContext,
  };
}

// The deeper-read prompt: only the computed summary goes out — never raw spool, prompts, or results.
const DEEP_READ_PROMPT =
  "Below is a local telemetry summary of an AI coding session (deterministic facts only). " +
  "Give 3-5 terse, actionable conclusions a developer can act on: call out the biggest token cost, " +
  "any tail risks, and one concrete thing to change. No preamble.\n\n";

// Find the first available AI CLI for the deeper-read feature: prefer claude, fall back to codex, then gemini.
function findDeepReadCli() {
  for (const cmd of ["claude", "codex", "gemini"]) {
    const check = spawnSync("which", [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (check.status === 0 && check.stdout.trim()) return cmd;
  }
  return null;
}

// Run the optional LLM synthesis via the headless AI CLI (claude, codex, or gemini — whichever is available).
// Best-effort: returns { ok:false, note } when no CLI is available so callers degrade gracefully.
function runDeepRead(report) {
  const cli = findDeepReadCli();
  if (!cli) return { ok: false, note: "no AI CLI available (tried claude, codex, gemini)", cli: null };
  const prompt = DEEP_READ_PROMPT + insightsSummary(report);
  let result;
  try {
    result = spawnSync(cli, ["-p", prompt], { encoding: "utf8", timeout: 60000 });
  } catch (err) {
    return { ok: false, note: `${cli} CLI not available: ${err.message}`, cli };
  }
  if (result.error) return { ok: false, note: `${cli} CLI not available: ${result.error.message}`, cli };
  if (result.status !== 0) return { ok: false, note: `${cli} exited ${result.status}: ${(result.stderr || "").trim().slice(0, 200)}`, cli };
  const text = (result.stdout || "").trim();
  return text ? { ok: true, text, cli } : { ok: false, note: `${cli} returned no output`, cli };
}

// Server closure: deeper-read on demand from the dashboard. Reads the spool through the incremental
// store so it reflects live captures without re-parsing the whole file, mirroring loadAnalysis.
function loadInsightsLlm() {
  return runDeepRead(analyzeTelemetry(readSpoolEventsCached()));
}

// --- Phase 6: portal marker/experiment/analysis request handlers ------------------------------
// All three reuse the exact same domain functions the CLI calls (createMarker/startExperiment/
// endExperiment from telemetry-markers.mjs) — no browser-side rule duplication, per the plan's
// "Do not duplicate experiment rules in the browser." Server-side validation mirrors the CLI's own
// argument checks (parseMarkArgs/parseExperimentStartArgs) since a browser POST body skips that path.

// Portal markers omit --session/--phase/--status conveniences the CLI supports via flags the portal
// doesn't yet render a control for; only the fields the plan's marker-creation UI needs are accepted.
function createMarkerFromPortalRequest(body) {
  if (typeof body.type !== "string" || !MARKER_TYPES.has(body.type)) {
    return { ok: false, error: `type must be one of: ${[...MARKER_TYPES].join(", ")}` };
  }
  if (typeof body.title !== "string" || !body.title.trim()) {
    return { ok: false, error: "title is required" };
  }
  if (body.expected_direction != null && !EXPECTED_DIRECTIONS.has(body.expected_direction)) {
    return { ok: false, error: `expected_direction must be one of: ${[...EXPECTED_DIRECTIONS].join(", ")}` };
  }
  if (body.type === "outcome" && !OUTCOME_STATUSES.has(body.status)) {
    return { ok: false, error: `outcome markers require status to be one of: ${[...OUTCOME_STATUSES].join(", ")}` };
  }
  try {
    const marker = createMarker({
      effective_at: body.effective_at,
      repository_id: body.repository_id,
      scope: body.scope,
      watching_kinds: body.watching_kinds,
      finding_id: body.finding_id,
      type: body.type,
      title: body.title,
      description: typeof body.description === "string" ? body.description : null,
      packages: Array.isArray(body.packages) ? body.packages : [],
      skills: Array.isArray(body.skills) ? body.skills : [],
      tags: Array.isArray(body.tags) ? body.tags : [],
      metric: typeof body.metric === "string" ? body.metric : null,
      expected_direction: body.expected_direction ?? null,
      session_id: typeof body.session_id === "string" ? body.session_id : null,
      phase: body.type === "phase" ? body.phase : null,
      status: body.type === "outcome" ? body.status : null,
      supersedes: typeof body.supersedes === "string" ? body.supersedes : null,
    });
    return { ok: true, marker };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function createExperimentFromPortalRequest(body) {
  if (typeof body.title !== "string" || !body.title.trim()) return { ok: false, error: "title is required" };
  if (typeof body.metric !== "string" || !body.metric.trim()) return { ok: false, error: "metric is required" };
  if (!EXPECTED_DIRECTIONS.has(body.expected_direction)) {
    return { ok: false, error: `expected_direction must be one of: ${[...EXPECTED_DIRECTIONS].join(", ")}` };
  }
  try {
    const result = startExperiment({
      title: body.title,
      metric: body.metric,
      expected_direction: body.expected_direction,
      guardrails: Array.isArray(body.guardrails) ? body.guardrails : [],
      task_categories: Array.isArray(body.task_categories) ? body.task_categories : [],
      minimum_sessions_per_cohort: Number.isInteger(body.minimum_sessions_per_cohort) ? body.minimum_sessions_per_cohort : 10,
      comparison: body.comparison,
    });
    return { ok: true, experiment: result.experiment, startMarker: result.startMarker };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function endExperimentFromPortalRequest(experimentId) {
  try {
    const result = endExperiment(experimentId);
    return { ok: true, experiment: result.experiment, endMarker: result.endMarker };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// POST /api/telemetry/analysis: dedicated high-dimensional comparison endpoint for the Analysis
// explorer (plan: "Add a dedicated endpoint for high-dimensional comparisons rather than inflating
// /api/data for every explorer interaction"). Body: { cohort_a, cohort_b, metric, marker_id }.
// Validates known metric ids and cohort filter shapes server-side; never trusts client-supplied
// formulas or cohort definitions beyond selecting from the shared registry/cohort model.
function loadTelemetryAnalysisRequest(body) {
  const metricId = body.metric;
  if (typeof metricId !== "string" || !isKnownMetric(metricId)) {
    return { ok: false, error: `metric must be one of the known metric ids (see /api/telemetry/analysis with no metric for the list)`, known_metrics: listMetrics().map((m) => m.id) };
  }
  const allEvents = readSpoolEvents();
  const markers = readMarkers();

  // marker_id (or cohort_a.marker_id) selects the marker-relative path — the plan's preferred
  // comparison when a change marker exists. Falling back to a bare cohort_a-vs-cohort_b comparison
  // (two independent cohort filters, no marker) is supported for the explorer's "compare two
  // arbitrary cohorts" mode, using a simple metric-value-per-cohort comparison rather than the
  // marker-relative before/after split (which needs a single marker timestamp to split around).
  const markerId = body.marker_id || body.cohort_a?.marker_id || null;
  if (markerId) {
    const marker = markers.find((m) => m.marker_id === markerId);
    if (!marker) return { ok: false, error: `unknown marker: ${markerId}` };
    try {
      const comparison = compareAcrossMarker(allEvents.filter((e) => e.tokens), marker, metricId, {
        markers,
        cohortFilter: body.cohort_a || null,
      });
      return { ok: true, finding: describeMarkerComparison(comparison, marker) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // No marker: compare two independently-filtered cohorts directly (metric value + sample size for
  // each), without the before/after marker-relative machinery (there is no shared timestamp to split
  // sessions around). Still surfaces sample size so the explorer can flag thin cohorts the same way.
  const cohortA = applyCohortFilter(allEvents.filter((e) => e.tokens), normalizeCohortFilter(body.cohort_a), { markers });
  const cohortB = applyCohortFilter(allEvents.filter((e) => e.tokens), normalizeCohortFilter(body.cohort_b), { markers });
  const sessionsOf = (captures) => new Set(captures.map((e) => e.session_id).filter(Boolean)).size;
  return {
    ok: true,
    finding: {
      metric: metricId,
      cohort_a: { sessions: sessionsOf(cohortA), value: computeMetric(metricId, cohortA, { markers }) },
      cohort_b: { sessions: sessionsOf(cohortB), value: computeMetric(metricId, cohortB, { markers }) },
      correlation_only: true,
    },
  };
}

function countBy(events, keyFor) {
  const counts = new Map();
  for (const event of events) {
    const key = keyFor(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function printTop(label, entries) {
  console.log(`${label}:`);
  for (const [key, count] of entries.slice(0, 8)) {
    console.log(`  ${String(key).padEnd(24)} ${count}`);
  }
}

function fmt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function shortId(id) {
  return id && id !== "unknown" ? String(id).slice(0, 8) : "unknown";
}

function readTelemetryState() {
  try {
    return JSON.parse(fs.readFileSync(telemetryStatePath(), "utf8"));
  } catch {
    return { enabled: false };
  }
}

function writeTelemetryState(patch) {
  ensureTelemetryDirs();
  const state = { ...readTelemetryState(), ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(telemetryStatePath(), JSON.stringify(state, null, 2) + "\n");
}

// --- PID management for the detached portal server ---------------------------------------------
// Keyed by port (portalPidPathForPort), not one shared file: each port is an independent server,
// commonly from a different repo/worktree entirely. Reading/writing/clearing the wrong repo's PID
// here previously meant starting a portal on ANY port would SIGTERM whatever the last-started
// portal on ANY OTHER port happened to be, because they all wrote to the same file — see the
// bugfix commit for the concrete repro (a main-checkout `serve` and a worktree `serve` on
// different ports were killing each other every time either one restarted).

function readPid(port) {
  try {
    return parseInt(fs.readFileSync(portalPidPathForPort(port), "utf8").trim(), 10) || null;
  } catch {}
  // The legacy single-file path predates per-port tracking, so it could only ever have recorded a
  // default-port (4317) server — never consult it for any other port.
  if (port !== 4317) return null;
  try {
    return parseInt(fs.readFileSync(legacyTelemetryPidPath, "utf8").trim(), 10) || null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function writePid(port, pid) {
  const pidPath = portalPidPathForPort(port);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(pid));
}

function clearPid(port) {
  try { fs.rmSync(portalPidPathForPort(port), { force: true }); } catch {}
  if (port === 4317) {
    try { fs.rmSync(legacyTelemetryPidPath, { force: true }); } catch {}
  }
}

// Kill any existing detached server ON THIS PORT (stale or live) and wait for it to actually exit
// before returning. Clears that port's PID file unconditionally. Waiting matters: a caller that
// immediately tries to bind the same port right after this resolves would otherwise race the
// killed process's own teardown (SIGTERM handling + socket close isn't instant) — a transient bind
// failure right after signalling would read as "port occupied by something else" and fall back
// to a random port, permanently orphaning the process we just tried to kill instead of waiting
// the extra tens of milliseconds for it to actually die.
async function killExistingServer(port) {
  const pid = readPid(port);
  clearPid(port);
  if (pid == null || !isProcessRunning(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 2000;
  while (isProcessRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Kill the running server on this port. Returns true if a live process was found and signalled.
function stopServer(port) {
  const pid = readPid(port);
  if (pid == null) return false;
  clearPid(port);
  if (!isProcessRunning(pid)) return false;
  try { process.kill(pid, "SIGTERM"); return true; } catch { return false; }
}

async function startDetachedPortal(port, { allowPortFallback = false, portExplicit = false } = {}) {
  // Resolve BEFORE killing, matching the foreground path below. Killing first made the reuse branch
  // unreachable: a healthy portal on this port was SIGTERMed and respawned on every `web --detach`,
  // so running the command twice needlessly destroyed a working server (and, with the ready-wait,
  // could leave you with none). resolvePortalPort already handles the case a kill was meant to
  // cover — it SIGTERMs a STALE portal (one running code that changed since it started) and waits
  // for the port to free, so only a current, healthy portal survives to the reuse branch.
  const resolved = await resolvePortalPort(port, { allowPortFallback, portExplicit, warn: true });
  if (resolved.reuse) {
    writePid(resolved.port, resolved.pid);
    return resolved.port;
  }
  const selectedPort = resolved.port;
  // Reap whatever this port's PID file still tracks (a dead process, or one that is alive but not
  // answering as a healthy portal) before binding. Skipped for 0/auto-assign: there is no specific
  // port's prior server to reconcile with. A stale record here never touches another port's.
  if (selectedPort !== 0) await killExistingServer(selectedPort);
  const { child, readyFile } = spawnDetachedServer(selectedPort);
  const ready = await waitForPortalReady(selectedPort, child, readyFile);
  if (!ready.ok) {
    clearPid(selectedPort);
    try { fs.rmSync(readyFile, { force: true }); } catch {}
    if (child.exitCode == null) {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
    }
    throw new Error(ready.message);
  }
  writePid(ready.port ?? selectedPort, child.pid);
  child.unref();
  return ready.port ?? selectedPort;
}

async function resolvePortalPort(port, { allowPortFallback = false, portExplicit = false, warn = false } = {}) {
  if (port === 0 || await canBindPort(port)) return { port, reuse: false };

  const existing = await probePortal(port);
  if (existing.current) return { port, reuse: true, pid: existing.pid };

  if (existing.stale && Number.isInteger(existing.pid)) {
    if (warn) {
      console.error(`port ${port} is running a stale portal (pid ${existing.pid}, code changed since it started) — restarting it.`);
    }
    try { process.kill(existing.pid, "SIGTERM"); } catch {}
    await waitForPortToFree(port);
    return { port, reuse: false };
  }

  if (allowPortFallback || !portExplicit) {
    if (warn) {
      console.error(
        `port ${port} is occupied by a non-current or unhealthy process; starting this portal on an available port instead.`,
      );
    }
    return { port: 0, reuse: false };
  }

  console.error(`port ${port} is occupied by a non-current or unhealthy process; stop it or pass --port <n>.`);
  process.exit(1);
}

// After SIGTERM-ing a stale portal, the socket doesn't necessarily free immediately — poll briefly
// rather than assuming the very next bind attempt succeeds.
async function waitForPortToFree(port, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBindPort(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function probePortal(port) {
  try {
    const data = await getPortalStatus(port);
    const currentPortalDir = path.join(repoRoot, "portal");
    const pid = Number(data?.pid);
    const samePath = data?.ok === true && data?.appRoot === repoRoot && data?.portalDir === currentPortalDir && Number.isInteger(pid);
    if (!samePath) return { current: false };
    // Same repo path, but is it running the code that's actually on disk right now? A detached
    // server outlives the CLI invocation that spawned it on purpose, so it can easily still be
    // alive from before a `git pull`/merge changed portal-server.mjs or anything under portal/ —
    // Node never re-reads those files once loaded. Reusing a stale process would silently keep
    // serving old code with no visible sign anything is wrong.
    const stale = typeof data?.sourceHash === "string" && data.sourceHash !== computePortalSourceHash();
    return { current: !stale, stale, pid };
  } catch {
    return { current: false };
  }
}

function getPortalStatus(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/portal/status",
        timeout: 500,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`portal status returned ${res.statusCode}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("portal status timed out")));
    req.on("error", reject);
  });
}

// Spawn a new foreground `web` process in the background. The caller writes the PID only after the
// child writes its ready-file from server.listen(), so a failed bind never leaves a stale "running" PID.
function spawnDetachedServer(port) {
  const readyFile = path.join(os.tmpdir(), `cli-portal-${process.pid}-${Date.now()}.ready`);
  const child = spawn(process.execPath, [process.argv[1], "web", "--no-open", "--port", String(port), "--allow-zero-port"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORTAL_READY_FILE: readyFile },
  });
  return { child, readyFile };
}

function waitForPortalReady(port, child, readyFile) {
  // A COLD start is far slower than it looks: the server warms telemetry/developer-runtime views before
  // it binds, which measured ~29s on a normal dev checkout — an order of magnitude past the 3s this
  // used to allow. That made `web --detach` fail on every cold start while leaving the child alive
  // and binding moments later, so the CLI reported failure for a portal that was about to work.
  // The child exiting is still detected immediately below, so a genuinely broken start fails fast
  // rather than sitting out this whole window.
  const deadline = Date.now() + 60000;
  return new Promise((resolve) => {
    let settled = false;
    let exitCode = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("exit", (code, signal) => {
      exitCode = signal || code;
    });
    const poll = () => {
      if (exitCode !== null) {
        finish({ ok: false, message: `portal server exited before it was ready (${exitCode})` });
        return;
      }
      if (Date.now() > deadline) {
        finish({ ok: false, message: `portal server did not become ready on http://127.0.0.1:${port}` });
        return;
      }
      if (fs.existsSync(readyFile) && isProcessRunning(child.pid)) {
        let actualPort = port;
        try {
          const marker = fs.readFileSync(readyFile, "utf8").trim();
          const match = /^ready:(\d+)$/.exec(marker);
          if (match) actualPort = Number(match[1]);
        } catch {}
        try { fs.rmSync(readyFile, { force: true }); } catch {}
        finish({ ok: true, port: actualPort });
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function openLocalUrl(url) {
  const platform = process.platform;
  const command = platform === "darwin"
    ? "open"
    : platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    console.error(`open failed: ${err?.message || err}`);
  }
}

function rejectArgs(args) {
  if (args.length > 0) {
    console.error(`unknown argument: ${args[0]}`);
    process.exit(2);
  }
}

function rejectSupportedReportArgs(args) {
  const allowed = new Set(["--since", "--repo", "--group", "--format", "--deep", "--conditions"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.includes("=")) {
      if (!allowed.has(arg.split("=")[0])) rejectArgs([arg]);
      continue;
    }
    if (!allowed.has(arg)) rejectArgs([arg]);
    if (!["--deep", "--conditions"].includes(arg)) i++;
  }
}
