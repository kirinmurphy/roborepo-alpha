import { normalizeGitRemote, localRepositoryIdForRoot } from "../../modules/repositories/index.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readConfigSnapshot } from "./config.mjs";
import { readPackageVersion } from "./workspace.mjs";
import { telemetrySpoolDir } from "./state-paths.mjs";
import { generateMarkerId, MARKER_TYPES, OUTCOME_STATUSES, EXPECTED_DIRECTIONS, TASK_CATEGORIES } from "./telemetry-schemas/marker-schema.mjs";
import { buildEffectiveSnapshot } from "./telemetry-schemas/snapshot-schema.mjs";
import { generateExperimentId, COMPARISON_MODES } from "./telemetry-schemas/experiment-schema.mjs";
import { inferTaskScale } from "./telemetry-task-infer.mjs";
import {
  appendMarker, readMarkers, writeSnapshot, writeExperiment, readExperiment, readExperiments,
} from "./telemetry-schemas/persistence.mjs";
import { compareAcrossMarker } from "./telemetry-compare.mjs";
import { filterSessionsByTaskCategory } from "./telemetry-cohort.mjs";

// Shared marker/experiment domain functions, used by both the CLI (telemetry.mjs) and — in later
// phases — the portal's marker/experiment endpoints. Keeps repo/branch/sha resolution, snapshot
// creation, and validation in one place so CLI and portal never disagree on what a marker looks like.

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : "";
}

// Best-effort: a marker created outside a git repo (or with git unavailable) still gets created,
// just with repo/branch/sha left null rather than the command failing.
function resolveGitIdentity(cwd) {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = git(cwd, ["rev-parse", "--short", "HEAD"]);
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  return {
    repo: root ? path.basename(root) : null,
    repository_id: normalizeGitRemote(git(cwd, ["remote", "get-url", "origin"])) || (root ? localRepositoryIdForRoot(root) : null),
    branch: branch || null,
    sha: sha || null,
  };
}

// Best-effort effective-configuration snapshot for the current machine, deduplicated by content
// hash. Markers created from a CLI invocation have no live harness/model context (unlike a
// SessionStart hook), so harness/model are left null here.
function resolveConfigSnapshotId() {
  try {
    const configSnapshot = readConfigSnapshot();
    const snapshot = buildEffectiveSnapshot(configSnapshot, { appVersion: readPackageVersion() });
    writeSnapshot(snapshot);
    return snapshot.snapshot_id;
  } catch {
    return null;
  }
}

// A supersede must retire a real, still-active change marker; anything else would leave both
// markers active (the conditions superseded-filter silently no-ops on an unknown id).
export function assertSupersedable(targetId, markers) {
  const target = markers.find((marker) => marker.marker_id === targetId);
  if (!target) throw new Error(`cannot supersede unknown marker: ${targetId}`);
  if (target.type !== "change") throw new Error(`cannot supersede a ${target.type} marker; only change markers can be superseded`);
  if (markers.some((marker) => marker.supersedes === targetId)) throw new Error(`marker ${targetId} is already superseded`);
}

// Builds, validates, and persists a marker from CLI-supplied fields. Machine-derived identity
// (repo/branch/sha/timestamp/snapshot) is always resolved here, never accepted from the caller,
// so automatic metadata is always correct.
export function createMarker(fields, { cwd = process.cwd() } = {}) {
  if (fields.supersedes != null) assertSupersedable(fields.supersedes, readMarkers());
  const identity = resolveGitIdentity(cwd);
  const marker = {
    schema: 2,
    marker_id: generateMarkerId(),
    ts: new Date().toISOString(),
    effective_at: fields.effective_at ?? new Date().toISOString(),
    scope: fields.scope ?? (identity.repository_id ? "repository" : "unknown"),
    repository_id: fields.scope === "all" ? null : fields.repository_id ?? identity.repository_id,
    watching_kinds: fields.watching_kinds ?? ["spike", "loop", "read-warning"],
    finding_id: fields.finding_id ?? null,
    type: fields.type,
    title: fields.title,
    description: fields.description ?? null,
    repo: identity.repo,
    branch: identity.branch,
    sha: identity.sha,
    config_snapshot_id: resolveConfigSnapshotId(),
    packages: fields.packages ?? [],
    skills: fields.skills ?? [],
    tags: fields.tags ?? [],
    metric: fields.metric ?? null,
    expected_direction: fields.expected_direction ?? null,
    supersedes: fields.supersedes ?? null,
    session_id: fields.session_id ?? null,
    phase: fields.phase ?? null,
    status: fields.status ?? null,
    ...taskFields(fields),
  };
  if (fields.effective_at == null) marker.effective_at = marker.ts;
  return appendMarker(marker);
}

// Task category/scale are explicit-only when set through the CLI (see telemetry.mjs's
// --task-category and friends) — task_category_source is always "explicit" here.
// telemetry-task-infer.mjs's inferTaskCategory() is for future analysis-time inference
// over accumulated session signals, not something this marker-creation path calls itself.
function taskFields(fields) {
  if (fields.task_category == null) return {};
  const hasScaleInput = fields.files_touched != null || fields.directories_touched != null
    || fields.insertions != null || fields.deletions != null;
  return {
    task_category: fields.task_category,
    task_category_source: "explicit",
    task_scale: hasScaleInput
      ? inferTaskScale({
          filesTouched: fields.files_touched ?? 0,
          directoriesTouched: fields.directories_touched ?? 0,
          insertions: fields.insertions ?? null,
          deletions: fields.deletions ?? null,
          changedFileCategories: [],
        })
      : null,
  };
}

export function listMarkers() {
  return readMarkers();
}

export { MARKER_TYPES, OUTCOME_STATUSES, EXPECTED_DIRECTIONS, COMPARISON_MODES, TASK_CATEGORIES };

// Creates an experiment definition plus its start marker in one step.
export function startExperiment(fields, { cwd = process.cwd() } = {}) {
  const startMarker = createMarker({
    type: "experiment-start",
    title: fields.title,
    metric: fields.metric,
    expected_direction: fields.expected_direction,
    tags: fields.tags,
  }, { cwd });

  const experiment = {
    schema: 1,
    experiment_id: generateExperimentId(),
    title: fields.title,
    start_marker_id: startMarker.marker_id,
    end_marker_id: null,
    primary_metric: fields.metric,
    expected_direction: fields.expected_direction,
    guardrails: fields.guardrails ?? [],
    eligibility: {
      task_categories: fields.task_categories ?? [],
      minimum_sessions_per_cohort: fields.minimum_sessions_per_cohort ?? 10,
    },
    comparison: fields.comparison ?? "previous-equivalent-window",
  };
  writeExperiment(experiment);
  return { experiment, startMarker };
}

export function endExperiment(experimentId, { cwd = process.cwd() } = {}) {
  const experiment = readExperiment(experimentId);
  if (!experiment) throw new Error(`unknown experiment: ${experimentId}`);
  if (experiment.end_marker_id) throw new Error(`experiment already ended: ${experimentId}`);

  const endMarker = createMarker({
    type: "experiment-end",
    title: `${experiment.title} (end)`,
    metric: experiment.primary_metric,
    expected_direction: experiment.expected_direction,
  }, { cwd });

  experiment.end_marker_id = endMarker.marker_id;
  writeExperiment(experiment);
  return { experiment, endMarker };
}

// Reads every harness spool file, tolerating partial/corrupt lines exactly like telemetry.mjs's
// readSpoolEvents() (which this duplicates rather than imports — telemetry.mjs is the CLI-parsing/
// printing layer and importing it back here would invert the module's dependency direction; the
// handful of lines are cheap to keep in sync and the read logic is trivial).
function readSpoolEventsForStatus() {
  const events = [];
  let files = [];
  try {
    files = fs.readdirSync(telemetrySpoolDir).filter((file) => file.endsWith(".jsonl"));
  } catch {
    return events;
  }
  for (const file of files) {
    const fullPath = path.join(telemetrySpoolDir, file);
    for (const line of fs.readFileSync(fullPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Ignore partial/corrupt lines.
      }
    }
  }
  return events;
}

// Cohort sizing/readiness: resolves the experiment's start marker, splits sessions into
// before/after cohorts via the same marker-relative comparison engine the portal and CLI report use
// (telemetry-compare.mjs), and reports whether the eligibility threshold is met — not merely a
// lifecycle summary. `ready` means: primary_metric is computable for both cohorts, both cohorts meet
// eligibility.minimum_sessions_per_cohort, and no serious data-quality issue was flagged. This never
// reports a provisional winner — only whether there is enough data to trust one.
export function experimentStatus(experimentId) {
  const experiments = experimentId ? [readExperiment(experimentId)].filter(Boolean) : readExperiments();
  if (experimentId && experiments.length === 0) throw new Error(`unknown experiment: ${experimentId}`);
  const allMarkers = readMarkers();
  const markersById = new Map(allMarkers.map((m) => [m.marker_id, m]));
  const events = readSpoolEventsForStatus();

  return experiments.map((experiment) => {
    const startMarker = markersById.get(experiment.start_marker_id) ?? null;
    const endMarker = experiment.end_marker_id ? markersById.get(experiment.end_marker_id) ?? null : null;
    const base = {
      experiment_id: experiment.experiment_id,
      title: experiment.title,
      state: endMarker ? "ended" : "running",
      primary_metric: experiment.primary_metric,
      expected_direction: experiment.expected_direction,
      guardrails: experiment.guardrails,
      eligibility: experiment.eligibility,
      comparison: experiment.comparison,
      started_at: startMarker?.ts ?? null,
      ended_at: endMarker?.ts ?? null,
    };

    if (!startMarker) {
      return { ...base, ready: false, cohorts: null, data_quality_warnings: ["experiment's start marker is missing"] };
    }

    let eligibleCaptures = events;
    if (experiment.eligibility?.task_categories?.length) {
      eligibleCaptures = filterSessionsByTaskCategory(events, experiment.eligibility.task_categories, allMarkers);
    }

    let comparison;
    try {
      comparison = compareAcrossMarker(eligibleCaptures, startMarker, experiment.primary_metric, {
        markers: allMarkers,
        minimumSessionsPerCohort: experiment.eligibility?.minimum_sessions_per_cohort ?? 10,
        equalize: experiment.comparison === "midpoint" ? "equal-duration" : "equal-session-count",
      });
    } catch (err) {
      return { ...base, ready: false, cohorts: null, data_quality_warnings: [`could not evaluate primary metric: ${err.message}`] };
    }

    const ready = comparison.confidence === "strong signal" || comparison.confidence === "emerging pattern";
    return {
      ...base,
      ready,
      cohorts: { before: comparison.before, after: comparison.after },
      effect_size: comparison.effect_size,
      confidence: comparison.confidence,
      data_quality_warnings: comparison.data_quality_issues,
    };
  });
}
