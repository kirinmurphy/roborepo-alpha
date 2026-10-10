import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { analyzeTelemetry } from "../cli/telemetry-analyze.mjs";
import { compareTelemetryOracle } from "../cli/telemetry-oracle-compare.mjs";
import { runTelemetryOracle } from "../cli/telemetry-oracle-run.mjs";

const snapshot = { schema: 2, snapshot_id: "cfg", packages: [], skills: [],
  evaluability: { packages: true, skills: true } };
const event = { schema: 3, capture_id: "capture", call_id: "call", harness: "claude", session_id: "session",
  event: "PostToolUse", ts: "2026-09-15T12:00:00.000Z", config_snapshot_id: "cfg",
  repo: { repository_id: "git:example/repo" }, session: { model: "model" }, tool: { name: "Read" },
  last_result: { tool: "Read", chars: 100 }, tokens: { input: 100, output: 10, total: 110 } };
const options = { snapshots: [snapshot] };
function compare(row = event, extra = {}) {
  return compareTelemetryOracle([row], { ...options, ...extra });
}
function hasIssue(result, category) {
  assert.ok(result.coverage.issues.some((issue) => issue.category === category && issue.count > 0), category);
  assert.notEqual(result.status, "passed");
}

assert.equal(compare().status, "passed");
assert.equal(compare({ ...event, tokens: null }).status, "passed", "known absence of token data is supported");
for (const schema of [undefined, null, 2, 3]) {
  assert.equal(compare({ ...event, schema, call_id: "derived_call" }).status, "passed", `capture schema ${schema}`);
}
assert.equal(compareTelemetryOracle([], options).status, "unavailable");

const remote = "example/repo";
const remoteHash = createHash("sha256").update(remote).digest("hex").slice(0, 24);
const repositoryRegistry = { repositories: { repo: { id: "git:example/repo", normalizedRemote: remote } } };
const legacy = { ...event, repo: { normalized_remote_hash: remoteHash } };
assert.equal(compare(legacy, { repositoryRegistry }).status, "passed", "legacy hash resolves independently from raw registry");
assert.equal(runTelemetryOracle([legacy], { repositoryRegistry }).conditions.find((row) => row.dimension === "repo").value,
  "git:example/repo", "oracle derives the expected canonical identity from the raw registry");
const brokenResolution = compareTelemetryOracle([legacy], { ...options, repositoryRegistry }, {
  analyze(events, opts) {
    return analyzeTelemetry(events, { ...opts, repositoryHashIndex: { byNormalizedRemoteHash: new Map() } });
  },
});
assert.equal(brokenResolution.status, "failed", "production identity resolution cannot set the oracle's expectation");
assert.deepEqual(brokenResolution.differences, ["conditions"]);
assert.equal(compare({ ...legacy, repo: { ...legacy.repo, repository_id: "local:direct" } }, { repositoryRegistry }).status,
  "passed", "direct identity wins over a conflicting legacy hash");
for (const repo of [null, {}, { label: "repo" }, { git_root_hash: "opaque" }, { remote_hash: "opaque" }, { cwd: "/private/repo" },
  { normalized_remote_hash: "unmatched" }]) {
  const result = compare({ ...event, repo }, { repositoryRegistry });
  assert.equal(result.status, "partial");
  hasIssue(result, "unresolved_repository");
}
hasIssue(compare({ ...event, session: { model: null } }), "unknown_model");
hasIssue(compare({ ...event, config_snapshot_id: "missing" }), "missing_snapshot");
hasIssue(compare(event, { snapshots: [{ ...snapshot, evaluability: { packages: false, skills: true } }] }), "unknown_snapshot_condition");
assert.equal(compare(event, { snapshots: [{ ...snapshot, schema: 1, evaluability: undefined }] }).status, "passed");

for (const [row, category] of [
  [null, "malformed_event"],
  [{ ...event, schema: 1 }, "unsupported_event_schema"],
  [{ ...event, schema: 99 }, "unsupported_event_schema"],
  [{ ...event, session_id: null }, "unidentified_session"],
  [{ ...event, ts: "bad" }, "invalid_timestamp"],
  [{ ...event, tokens: { total: "100" } }, "malformed_tokens"],
  [{ ...event, tokens: { input: Number.MAX_SAFE_INTEGER, output: 1, total: Number.MAX_SAFE_INTEGER } }, "malformed_tokens"],
  [{ ...event, repo: { repository_id: "unknown" } }, "malformed_repository"],
  [{ ...event, last_result: { tool: "search_symbols", chars: 10 } }, "unsupported_bare_tool"],
]) {
  const result = compare(row);
  assert.equal(result.status, "unavailable");
  hasIssue(result, category);
}
const mixed = compareTelemetryOracle([event, { ...event, schema: 99 }], options);
assert.equal(mixed.coverage.supported_events, 1);
assert.equal(mixed.coverage.unsupported_events, 1);
assert.notEqual(mixed.status, "passed", "unsupported rows cannot disappear into a green result");
hasIssue(compare(event, { repositoryRegistry: { repositories: { a: repositoryRegistry.repositories.repo,
  b: { id: "git:other/repo", normalizedRemote: remote } } } }), "ambiguous_repository_registry");

const marker = { schema: 2, marker_id: "marker", type: "change", scope: "all",
  ts: "2026-09-15T00:00:00.000Z", watching_kinds: ["spike", "loop", "read-warning"] };
assert.equal(compare(event, { markers: [marker] }).status, "passed");
hasIssue(compare(event, { markers: [{ ...marker, schema: 1, scope: "unknown" }] }), "unknown_marker_scope");
hasIssue(compare(event, { markers: [{ ...marker, watching_kinds: ["over-testing"] }] }), "unsupported_marker_kind");
hasIssue(compare(event, { snapshots: [{ ...snapshot, packages: "malformed" }] }), "malformed_snapshot");
hasIssue(compare(event, { snapshots: [snapshot, { ...snapshot, packages: ["conflict"] }] }), "duplicate_snapshot_id");
hasIssue(compare(event, { cohortFilter: { harness: "codex" } }), "unsupported_analysis_options");
hasIssue(compare(event, { skippedEvidence: { malformed_events: 2 } }), "skipped_evidence");
hasIssue(compareTelemetryOracle([event], null), "malformed_evidence");
hasIssue(compare(event, { skippedEvidence: { malformed_events: -1 } }), "malformed_evidence_accounting");
const changingSession = compareTelemetryOracle([event, { ...event, capture_id: "second", call_id: "second",
  session: { model: "other-model" }, ts: "2026-09-16T12:00:00.000Z" }], options);
assert.equal(changingSession.status, "partial");
hasIssue(changingSession, "unknown_session_condition");

const secret = "PRIVATE-PROMPT /private/path SECRET-COMMAND";
const privateEvent = { ...event, prompt: { preview: secret }, repo: { repository_id: secret } };
const mismatch = compareTelemetryOracle([privateEvent], options, {
  analyze(events, opts) {
    const report = analyzeTelemetry(events, opts);
    report.capture_count += 1;
    return report;
  },
});
assert.equal(mismatch.status, "failed");
assert.deepEqual(mismatch.differences, ["token_operation_count"]);
assert.ok(!JSON.stringify(mismatch).includes(secret), "live diagnostics expose fields and counts only");
const crash = compareTelemetryOracle([privateEvent], options, { analyze() { throw new Error(secret); } });
assert.equal(crash.status, "unavailable");
assert.ok(!JSON.stringify(crash).includes(secret), "exception messages are not live output");
for (const [field, mutate] of [
  ["policy", (report) => { report.conditions.policy = { ...report.conditions.policy, minimum_cohort: 99 }; }],
  ["session_count", (report) => { report.conditions.data_quality.sessions++; }],
  ["token_session_count", (report) => { report.sessions.push({}); }],
  ["operation_count", (report) => { report.conditions.data_quality.flows++; }],
  ["conditions", (report) => { report.conditions.comparisons[0].with_condition++; }],
  ["changes", (report) => { report.conditions.changes[0].comparisons[0].before.observations++; }],
  ["regression", (report) => { report.regression.split_ts = secret; }],
]) {
  const result = compareTelemetryOracle([privateEvent], { ...options, markers: [marker] }, {
    analyze(events, opts) { const report = analyzeTelemetry(events, opts); mutate(report); return report; },
  });
  assert.equal(result.status, "failed", field);
  assert.deepEqual(result.differences, [field]);
  assert.ok(!JSON.stringify(result).includes(secret), field);
}
console.log("telemetry oracle live comparison checks passed");
