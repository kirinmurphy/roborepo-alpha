---
id: roborepo-telemetry-events-experiments
priority: high
next_action: ""
blocked_by: []
depends_on: []
related: []
reviewed_commit: c1be1dc540b1380f909ed2cdea53e1a792776450
---

# Telemetry Events, Experiments, and Actionable Analysis

## Status

Proposed implementation plan grounded in the current RoboRepo `main` branch.

## Purpose

Extend RoboRepo telemetry from a useful collection of token and tool-cost summaries into an explainable analysis system that can answer questions such as:

- Did changing a rule, skill, hook, script, package, or portal implementation produce a measurable change?
- Are full test suites being used as a debugging loop instead of targeted tests?
- Which tools consume most of a session's wall-clock time or context?
- Do sessions exposed to one package, skill revision, harness, or model behave differently from comparable sessions?
- Is a higher-cost model actually cheaper per successfully completed task?
- What evidence supports an alert, how reliable is it, and what should the user do next?

The system must remain honest about attribution. It may report direct observations and controlled correlations, but it must not claim that a prompt fragment, rule, package, or skill caused model behavior unless RoboRepo can directly observe the causal action.

## Required implementation workflow: use jcodemunch

The implementing agent must use jcodemunch while working on this plan.

Before editing:

1. Resolve and index the RoboRepo checkout with jcodemunch.
2. Refresh the index if it is stale.
3. Use jcodemunch symbol search, reference search, repository outlines, and context bundles to map the full telemetry path:
   - capture hooks and CLI dispatch;
   - transcript parsing and cursors;
   - JSONL persistence and retention;
   - analysis and deterministic insights;
   - portal routes and query parsing;
   - telemetry browser state, rendering, charting, and modals;
   - package catalog, configuration snapshot, and package mutation paths.
4. Use changed-symbol and reference queries before changing shared functions or record shapes.
5. Prefer narrow jcodemunch context bundles over repeatedly reading entire source files.
6. Refresh the index or register edits after structural changes so later searches reflect the new implementation.
7. Fall back to `rg` and targeted file reads only when jcodemunch cannot answer a query. Do not use broad repository dumps as the primary exploration method.

jcodemunch has two separate roles in this feature:

- **Implementation tool:** required for navigating and changing RoboRepo safely.
- **Measured MCP package:** its calls, durations, result sizes, and correlations continue to appear in telemetry like any other MCP package.

Do not hard-code analysis around jcodemunch. MCP identification must remain server-generic, with the existing bare-name compatibility behavior retained where required by current Codex transcripts.

## Phase 0 notes (grounding and characterization)

Recorded 2026-07-21, ahead of Phase 1 implementation, from an Explore pass over the worktree.

**Schema-v2 capture record** (`scripts/cli/telemetry-capture.mjs:31-63`, `SCHEMA_VERSION = 2` at line 12): `schema, ts, harness, event, session_id, cwd_hash, cwd_name, repo{label, git_root_hash, remote_hash, branch, sha}, tool{name, is_mcp, mcp_server, mcp_tool, command_hash, command_chars, command_lines, file_ext, file_path_hash}, duration_ms, prompt{chars, hash, preview}, tokens{input, output, cache_creation, cache_read, total}, delta_tokens, session{model, assistant_turns, tool_calls, mcp_calls, max_output_tokens}, details{token_schema_seen, unsupported_usage_seen, codex_reasoning_output_tokens, codex_rate_limits}, last_result, biggest_result`.

Spool: one JSONL per harness at `telemetrySpoolDir/<harness>.jsonl` (paths in `scripts/cli/state-paths.mjs`), capped at 25MB via `capSpool()` (keeps newest ~70%, `telemetry-capture.mjs:70-91`). Duration/delta-token pairing currently uses a **per-session cursor keyed only by `hash(sessionId)`** in `telemetryCollectorDir` — this is the known "single cursor overwritten by nested/concurrent calls" gap (limitation #10 above). Phase 1 adds the `call_id` field to the schema only; switching pairing logic to use it is Phase 3 work, out of scope here.

**Claude vs. Codex field differences** — fully handled today in `scripts/cli/telemetry-transcript.mjs`, cite rather than rediscover:
- Claude: `{type: "assistant"|"user", message: {usage, content[]}}`, tool calls keyed by `tool_use_id`, `tokens.total` computed as the sum of four sub-fields (line ~152).
- Codex: `{type: "event_msg"|"response_item"}`, tool calls keyed by `call_id`, `token_count` events carry a pre-totaled `total_tokens` override (`applyCodexEntry`, lines 208-253) rather than a sum — the two harnesses' totals are not guaranteed to come from the same arithmetic.
- MCP tool names: Claude always prefixes `mcp__<server>__<tool>`; Codex sometimes logs bare names, requiring the `BARE_MCP_TOOLS` lookup (lines 298-312) and `mcpServerOf()` (316-323).
- Only Codex has `codex_rate_limits` (provider-reported, privacy-scrubbed via `privacySafeRateLimits()`).
- Transcript file location differs: Claude at `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`; Codex under `~/.codex/sessions/` dated tree, matched by session-id substring (`telemetry-transcript-locate.mjs:22-29`).

**`readConfigSnapshot` gaps** (`scripts/cli/config.mjs:46-175`) relative to what Phase 1's configuration-snapshot schema needs: exposes `globals.settings.hooks` as **counts only** (not full hook command strings), no MCP server registration detail, no parsed Codex `config.toml` structure. Phase 1's snapshot builder must treat `readConfigSnapshot` as a partial data source and fill these three gaps itself (best-effort/`null` where not derivable), not assume it already returns the full effective-configuration shape the plan describes.

**Existing test coverage gap (fixed this phase):** `scripts/test/telemetry-correctness-check.mjs` existed but was not wired into `package.json` or `test-roborepo.sh`, unlike every sibling `*-check.mjs`. Added `"test:telemetry"` npm script and an `assert` line in `test-roborepo.sh` (after the hook-composition check) so it now runs in CI. Verified passing via `npm run test:telemetry`.

**Schema/validator precedent for Phase 1:** `modules/developer-runtime/settings-schema.mjs` (`SETTINGS_VERSION` constant, `validateSettings()` entry point, decomposed `validateX()` field helpers, `validateObjectKeys()` strict allowlisting, throw-based errors) and `scripts/cli/package-catalog.mjs` (`validatePackageCatalog()`, `SUPPORTED_SCHEMA` gate, accumulate-all-errors-then-throw). No zod/ajv/joi in the repo — new marker/snapshot/experiment/capture-v3 schemas should follow this same hand-rolled shape.

No `fixtures/` directory exists for telemetry; sample data today is inline literals inside `telemetry-correctness-check.mjs` (`writeJsonl`, `baseEvent`, `tool` helpers) and `test-roborepo.sh`. Phase 1's new schema tests should follow the same inline-fixture style for consistency.

## Phase 2 notes (CLI markers and experiments)

Recorded 2026-07-21, ahead of Phase 3.

Shared domain functions live in `scripts/cli/telemetry-markers.mjs` (`createMarker`, `listMarkers`, `startExperiment`, `endExperiment`, `experimentStatus`), separate from `telemetry.mjs`'s CLI parsing/printing (`telemetryMark`, `telemetryExperiment*`) — Phase 6/7 portal marker/experiment endpoints should import from `telemetry-markers.mjs`, not duplicate this logic. `createMarker` always resolves repo/branch/sha via its own local `git()`/`resolveGitIdentity()` (not `telemetry-capture.mjs`'s private `repoMetadata()`, which isn't exported) and always builds+dedupes a best-effort config snapshot via `resolveConfigSnapshotId()`. `readPackageVersion` in `workspace.mjs` was exported (was module-private) so the snapshot builder can stamp `roborepo_version`.

**Bug fixed this phase:** `marker-schema.mjs`'s `validateMarker` checked `config_snapshot_id` with `isValidId(value, "cfg")`, which enforces the generic 16-hex `generateId()` shape — but `computeSnapshotId()` (snapshot-schema.mjs) produces a 24-hex content hash. Every marker with a real resolved snapshot failed validation until fixed to check `/^cfg_[a-f0-9]{24}$/` directly. Covered by a regression assertion in `telemetry-marker-cli-check.mjs`.

**`experimentStatus` is intentionally thin:** cohort sizing, sample counts, and a "ready" verdict need the Phase 5 metrics/cohort engine (none of that exists yet). Status today reports only what's derivable from the experiment record + marker timeline (lifecycle state, definition, elapsed time) and always returns `ready: false` with a `data_quality_warnings` entry noting cohort sizing isn't implemented. Do not backfill fake readiness logic before Phase 5's cohort model lands — replace this stub then.

Added a manual-invocation `telemetry-marker` skill (`globals/packages/telemetry/skills/telemetry-marker/SKILL.md`) with a slash-command entrypoint, wired into `globals/packages/telemetry/package.config.json`. After editing package.config.json or the skill, regenerate `generated/packages/telemetry/*/commands/telemetry-marker.md` via `node scripts/build/render-slash-commands.mjs` and refresh `docs/internal/skill-invocation-audit.md` via `roborepo skill audit` — both are checked by `test-roborepo.sh` and were the source of spurious full-suite failures during this phase (stale generated output, not actual regressions).

Tests: `scripts/test/telemetry-marker-cli-check.mjs` (new, wired as `test:telemetry-marker-cli` + a `test-roborepo.sh` assertion) drives the real CLI process end-to-end (mark creation, validation errors, full experiment start/status/end/re-end-rejected lifecycle, export completeness) rather than only unit-testing the domain functions — this is what caught the config_snapshot_id bug above.

## Phase 3 notes (capture v3 and operation classification)

Recorded 2026-07-21, ahead of Phase 4.

`telemetry-capture.mjs` now writes `SCHEMA_VERSION = 3` records (was 2) with `capture_id`, `call_id`, `config_snapshot_id`, `operation`, and `phase` (always `null` for now — Phase 4 fills it) added on top of every existing v2 field. Schema-v2 read compatibility holds: `readSpoolEvents()`/`analyzeTelemetry()` never gate on `.schema` and work structurally, so mixed v2/v3 spools already analyze correctly (unchanged from before this phase).

**Call-aware duration pairing** (the actual reason Phase 3 exists — plan limitation #10): `toolDuration()` now keys its start/stop cursor by `call_id` instead of `session_id` alone, so two tool calls overlapping in time within one session no longer clobber each other's start stamp. `resolveCallId()` in `telemetry-capture.mjs` prefers a harness-provided id (`tool_use_id`/`toolUseId`/`call_id`/`callId` on hook stdin) and falls back to a derived id (`derivedCallId()`) keyed by session+tool+an incrementing per-session-per-tool counter file when the harness doesn't supply one. Verified directly for both paths in `telemetry-capture-v3-check.mjs` (concurrent-calls fixture + derived-id-without-harness-id fixture) — this is the fix the plan doc's exit criteria calls "concurrent call fixtures do not overwrite duration cursors."

**Config snapshot references, built cheaply:** the hot capture path still does not import `config.mjs` at module load time — `resolveConfigSnapshotId()` only `await import()`s `config.mjs`/`snapshot-schema.mjs`/`workspace.mjs`/`persistence.mjs` on the `SessionStart` event, builds+dedupes the snapshot once, and caches its id in a `telemetryCollectorDir` file keyed by session. Every later event in that session reads the cached id back with a plain `fs.readFileSync`, paying nothing extra. `telemetryCaptureCommand` is now `async` (both call sites in `main.mjs`/`telemetry.mjs` already `await`/`return` it from an async function, so this was a safe, non-breaking signature change).

**Semantic command classification** lives in a new pure module, `scripts/cli/telemetry-classify.mjs` (`classifyCommand`, `CLASSIFIER_VERSION`, `failureSignature`), with zero fs/config dependencies so it's cheap enough to import unconditionally into the hot capture path. `telemetry-capture.mjs` classifies a Bash tool's raw command inline (local variable only, never attached to any object that gets persisted) and stores only the classifier's output (category/runner/scope/target/signature-hash/classifier_version) — never the raw command text; covered by `testRawCommandNeverPersisted` in the capture-v3 test and `testNeverStoresRawCommand` in the classifier unit test. This repo's own `package.json` scripts (`npm test` → full suite via `test-roborepo.sh`, `npm run test:xxx` → targeted single files) served as the canonical full-vs-targeted fixture for the classifier's test rules.

**Two schema bugs fixed this phase** (both pre-existing from Phase 1, same root cause as the Phase 2 marker fix): `capture-schema-v3.mjs`'s `validateCaptureV3` checked `config_snapshot_id` against the generic 16-hex `isValidId(..., "cfg")` shape instead of the real 24-hex content-hash format snapshots use — fixed to `/^cfg_[a-f0-9]{24}$/`, matching the marker-schema.mjs fix from Phase 2. Also added `classifier_version` to `validateOperation`'s `ALLOWED_FIELDS` — the plan text requires storing a classifier version with every classification (rule #6 in "Classification rules") but the original v3 schema's operation allowlist omitted the field entirely, which would have rejected every real classified operation.

**Deferred to later phases, deliberately not attempted here:** phase inference (Phase 4), failure-signature capture from actual tool output (Phase 4 — `failureSignature()` exists and is unit-tested but nothing calls it yet; wiring it needs a privacy-safe bounded-output source from PostToolUse, which is Phase 4 territory per "capture exit/failure signatures where harness data permits"), snapshot mutation mid-session when config changes (plan's snapshot-schema section mentions per-turn model override; out of scope for capture v3 specifically), and any analyzer/portal consumption of the new `operation`/`call_id`/`config_snapshot_id` fields (Phase 5+ — `telemetry-analyze.mjs` is untouched this phase).

Tests: `scripts/test/telemetry-classify-check.mjs` (pure classifier, no CLI) and `scripts/test/telemetry-capture-v3-check.mjs` (real CLI process, following the same `spawnSync` + sandboxed `HOME`/`ROBOREPO_STATE_DIR` pattern as `telemetry-marker-cli-check.mjs`), both wired into `package.json` (`test:telemetry-classify`, `test:telemetry-capture-v3`) and `test-roborepo.sh`.

## Phase 4 notes (phases, intervening work, tasks, and outcomes)

Recorded 2026-07-21, ahead of Phase 5. Explicit phase markers (`telemetry mark --type phase --phase <name>`) already existed from Phase 2 — this phase's work was inferred phase tagging, intervening-work signal capture, task category/scale inference, and the schema surface for all three. Implementation decisions below were confirmed with the user before building (two storage-location questions the plan doc left open).

**Inferred phase tagging** lives in a new pure module, `scripts/cli/telemetry-phase-infer.mjs` (`inferPhase()`, `PHASE_CLASSIFIER_VERSION`, `LOW_CONFIDENCE_THRESHOLD`), zero fs/config dependency like `telemetry-classify.mjs`. It takes an already-summarized `signals` object (edit/read counts, last test operation, failure streak, broad-check-ran, finalization-signals) and returns `{name, source: "inferred", confidence, classifier_version}`. Rules are checked most-specific-first (finalization > debugging > verification > implementation > discovery > unknown) so a stronger narrow signal always wins over a weaker broad one. Confidence below `LOW_CONFIDENCE_THRESHOLD` (0.5) collapses to `"unknown"` inside `inferPhase()` itself, not left to callers — matches the plan's "low-confidence phases collapse to unknown" rule directly at the source. Capture records always carry the **inferred** reading in their `phase` field; explicit phase markers are not looked up from the hot capture path (would require importing marker persistence into the path the plan's performance constraints explicitly keep small) — reconciling explicit-marker-overrides-inferred-from-its-timestamp is Phase 5 analyzer work, over the marker timeline plus these capture-level inferred readings.

**Task category/scale inference** lives in `scripts/cli/telemetry-task-infer.mjs` (`inferTaskCategory`, `inferTaskScale`, `categorizeFile`, `TASK_CLASSIFIER_VERSION`), same zero-dependency discipline. `categorizeFile(ext)` buckets a file extension into `doc`/`ui`/`config`/`generated`/`code`/`unknown` — never given a raw path, only an extension (or a `looksGenerated` hint some future caller derives itself). Confirmed with the user: task category/scale live on **outcome markers**, not a new marker type or a separate stream — `marker-schema.mjs` gained `task_category` (enum matching the plan's "Task categories" list), `task_category_source` (`explicit`/`inferred`), and `task_scale` (`files_touched`, `directories_touched`, `insertions`, `deletions`, `cross_cutting`, `surface`), all optional and outcome-marker-only (validated, throws on any other marker type). The CLI (`telemetry mark --type outcome --task-category ... --files-touched ... `) only ever sets `task_category_source: "explicit"` — `inferTaskCategory()`/`inferTaskScale()` are unused by the CLI today and exist for Phase 5+ analysis-time inference over accumulated session signals, per the plan's explicit/inferred coexistence requirement.

**Intervening-work signals** are a new additive `intervening` object on capture-schema-v3 records (confirmed with the user: lives on the capture record itself, not a separate event stream — keeps captures the single source Phase 5's analyzer reads, at the cost of Phase 5 having to reconstruct "since the last full-suite run" by scanning capture history rather than reading a purpose-built stream). Fields: `edit_since_last_test`, `changed_file_count`, `changed_file_categories`, `diff_fingerprint` (a hash, never real diff text), `diff_fingerprint_changed`, `targeted_test_ran_since_last_full`, `failure_signature_changed`. Computed by a new `updateSessionActivity()` in `telemetry-capture.mjs`, which read-modify-writes a per-session JSON cursor (`telemetryCollectorDir/activity-<hash>.json`) on every `PostToolUse` — same cursor-file pattern as `toolDuration()`/`deltaTokens()`. `diff_fingerprint` comes from `git diff --stat HEAD` (file names/sizes, not content) hashed to 24 hex chars via a new `gitDiffFingerprint()`.

**Failure-signature wiring** (the plan's "`failureSignature()` exists and is unit-tested but nothing calls it yet" gap from Phase 3): `telemetry-transcript.mjs`'s `transcriptStats()` now also returns `last_result_failure_text` — bounded (4000 chars via a new `resultText()` helper, separate from the existing `resultChars()` sizing helper), populated **only** on the `is_error` branch of both the Claude (`tool_result` block) and Codex (`function_call_output`) paths, and never attached to `last_result`/`biggest_result` (which get persisted). `telemetry-capture.mjs` hashes this transient field via `classifyCommand`'s sibling export `failureSignature()` immediately when building `operation.exit_status`/`operation.failure_signature`, and the field never appears in the record object. Regression-tested directly in `telemetry-phase4-integration-check.mjs`'s privacy assertion (raw failure text asserted absent from the spool line) — same discipline as Phase 3's `testRawCommandNeverPersisted`.

**Schema additions:** `capture-schema-v3.mjs` gained the `intervening` field (own validator, strict allowlist) and `phase.classifier_version` (was missing — Phase 3's `operation.classifier_version` precedent applied retroactively to phase too, since both are "store a rule/version identifier with the classification" per the same plan rule). `marker-schema.mjs` gained `TASK_CATEGORIES`/`TASK_CATEGORY_SOURCES` and the three task fields described above.

**Deferred to later phases, deliberately not attempted here:** reconciling explicit phase markers against inferred per-capture phase (Phase 5 — needs the marker-relative comparison / cohort machinery that doesn't exist yet), any derived intervening-work findings like "full-suite runs without an intervening edit" counts or "redundant rerun" rollups (Phase 5's metrics registry — this phase only stores the raw per-capture signals a Phase 5 analyzer would aggregate), outcome *inference* beyond the existing explicit `telemetry mark --type outcome --status ...` (the plan's "never inferring success from Stop alone" rule means a real inference function needs multiple signals — verification pass, retry count, correction count — that don't have a capture-time home yet; deliberately not stubbed here to avoid the same kind of premature-readiness mistake Phase 2 flagged for `experimentStatus`).

Tests: `telemetry-phase-infer-check.mjs` and `telemetry-task-infer-check.mjs` (pure modules, no CLI), `telemetry-phase4-integration-check.mjs` (real CLI process, following the `telemetry-capture-v3-check.mjs` pattern — includes the plan's "redundant rerun with unchanged failure signature" and "edit after failure flips intervening signal" scenarios), plus new assertions added to `telemetry-schemas-check.mjs` (task_category/task_scale marker validation, intervening/phase.classifier_version capture-v3 validation) and `telemetry-correctness-check.mjs` (`last_result_failure_text` transcript-level unit coverage). All wired into `package.json` and `test-roborepo.sh`.

## Phase 5 notes (metrics, cohorts, and findings)

Recorded 2026-07-21, ahead of Phase 6.

**Metrics registry** lives in a new pure module, `scripts/cli/telemetry-metrics.mjs` (`listMetrics`, `getMetric`, `isKnownMetric`, `computeMetric`, plus the shared robust-summary helpers `trimmedMean`/`percentile`/`median`). 26 metrics across the plan's six groups (tokens/time/calls/test/outcome/reliability), each a `{ id, label, unit, direction_good, summary, minimum_sample, compute(captures, extra) }` record. `compute()` always operates on an already-filtered capture array — the registry itself never touches fs/config, matching the classifier/inference module discipline from Phases 3-4. Outcome metrics (`outcome.completion_rate`, `outcome.tokens_per_completed_task`) additionally accept `{ markers }` in their `extra` argument since task/outcome data lives on marker records, not captures; omitting markers returns `null` rather than guessing (never inferring success from absence of data).

**Normalized cohort filter model** lives in `scripts/cli/telemetry-cohort.mjs` (`emptyCohortFilter`, `normalizeCohortFilter`, `applyCohortFilter`, `filterSessionsByTaskCategory`, `describeCohortFilter`, `activeFilterCount`). Matches the plan's cohort JSON shape (`time`/`harnesses`/`models`/`repos`/`packages`/`skills`/`operations`/`phases`/`outcomes`/`task_categories`/`snapshot_ids`). `applyCohortFilter` resolves package/skill exposure by reading the capture's `config_snapshot_id` through `readSnapshot()` (cached per-call via a closure-scoped `Map` so repeated captures sharing a snapshot don't re-read the file). Outcome filtering needs the marker timeline; when a caller filters by `outcomes` but passes no `markers`, the filter degrades to "no restriction on this dimension" rather than excluding every capture — this was a bug caught by `telemetry-cohort-check.mjs`'s `testApplyFilterByOutcomeIgnoredWithoutMarkers` (the initial implementation excluded everything by mistake; fixed in `applyCohortFilter` to gate the outcome-lookup Map construction on `markers.length` too).

**Marker-relative comparison engine and confidence/data-quality gates** live in `scripts/cli/telemetry-compare.mjs`: `splitCohortsByMarker` (excludes sessions spanning the marker timestamp, per the plan's explicit rule), `equalizeCohorts` (`equal-session-count` default / `equal-duration` alternative, trimming the larger cohort's trailing/leading sessions to match), `compareAcrossMarker` (the full pipeline: split → equalize → compute metric per side → confidence label), `buildFinding`/`describeMarkerComparison` (the actionable finding contract assembly — observation/evidence/cohort/sample_size/confidence/data_quality_issues/interpretation/next_action/correlation_only/analysis_filter_state). Confidence labels: `insufficient evidence` (either cohort below `minimumSessionsPerCohort`, default 10, or the metric didn't compute), `data-quality warning` (one session dominates a cohort >40% of its captures, or sessions were excluded for spanning the marker), `emerging pattern` (computable but below `STRONG_SIGNAL_MIN_SESSIONS`=20 per side), `strong signal` (both cohorts ≥20 sessions, no serious data-quality issue). `describeMarkerComparison` never emits causal language — always "correlates with"/"may"/exposure wording, verified by `testDescribeMarkerComparisonCorrelationLanguage`'s explicit `doesNotMatch(/\bcaused\b/i)` assertion.

**Package telemetry policy validation/evaluation** lives in `scripts/cli/telemetry-policy.mjs` (`validateTelemetryPolicies`, `evaluatePolicy`, `evaluatePackagePolicies`, `POLICY_OPERATORS`, `POLICY_SEVERITIES`). Follows `package-catalog.mjs`'s accumulate-errors-then-return style (not throw-on-first, since a catalog-wide pass over many packages wants every package's errors at once) rather than the throw-based style the marker/snapshot/experiment/capture-v3 schemas use — chosen because `validatePackageCatalog` is this policy validator's actual sibling/caller context, not the marker-adjacent schemas. Policy evaluation is pure and advisory-only: `evaluatePolicy` never blocks anything, only returns `satisfied`/`violated`/`insufficient-samples`/`unknown` status. Not yet wired into `package-catalog.mjs`'s `validatePackageCatalog()` or into a live catalog load path — no package in this repo declares `telemetry.policies` yet (the plan's `test-harness` package is flagged as "the first candidate" but adding policies to its `package.config.json` was not required by any Phase 5 exit criterion, and doing so speculatively without a real usage a user asked for felt like scope creep — noted as a clear-but-deferred decision, not a blocker).

**`telemetry-analyze.mjs`'s `analyzeTelemetry()` signature grew a second, fully optional argument**: `analyzeTelemetry(events, { cohortFilter, markers, markerId, compareMetric })`. Every existing call site (`telemetry.mjs`'s `telemetryReport`/`loadInsightsLlm`, `telemetry-correctness-check.mjs`) calls it with the old one-argument form and is unaffected — verified by rerunning `telemetry-correctness-check.mjs` unchanged after this edit. New report fields: `testing_efficiency` (an object of the 10 `test.*` metric ids to computed values, always present), `cohort` (`null` unless `cohortFilter` was passed; otherwise `{ filter, summary, active_filter_count }`), `marker_comparison` (`null` unless `markerId` resolved to a real marker in `markers`; otherwise the full actionable-finding-contract object from `describeMarkerComparison`). `regression` (the existing midpoint calculation) is unchanged in shape but gained two new keys, `exploratory: true` and a `label` string — this is the "labeled exploratory fallback" the plan calls for; `regression()` itself was not touched, only the object wrapping its result in `analyzeTelemetry`.

**`experimentStatus()` in `telemetry-markers.mjs`** (the Phase 2 stub that always returned `ready: false` with a "not yet implemented" warning) now does real work: resolves the experiment's start marker, splits/equalizes cohorts via `compareAcrossMarker` scoped to the experiment's `eligibility.task_categories` (via `filterSessionsByTaskCategory`) and `minimum_sessions_per_cohort`, and reports `ready` (true when confidence is `"strong signal"` or `"emerging pattern"`), `cohorts` (`{before, after}` session counts + metric values), `effect_size`, `confidence`, and `data_quality_warnings` (now the real `compareAcrossMarker` issues list, not a hardcoded string). This required adding a small private spool-reader (`readSpoolEventsForStatus()`) to `telemetry-markers.mjs`, duplicating `telemetry.mjs`'s `readSpoolEvents()` rather than importing it — importing `telemetry.mjs` back into `telemetry-markers.mjs` would create a circular dependency (`telemetry.mjs` already imports `createMarker`/`startExperiment`/etc. from `telemetry-markers.mjs`). The CLI's `telemetry experiment status` printer (`telemetryExperimentStatus` in `telemetry.mjs`) was extended to print the new `cohorts`/`effect_size`/`confidence` fields when present.

**Deferred to later phases, deliberately not attempted here:** wiring `telemetry-policy.mjs`'s evaluation into a live portal/CLI-visible policy-findings surface (plan's "how policy evaluation output surfaces in the CLI report" open question — no package declares policies yet, so there is nothing to surface; the evaluation functions exist and are tested, ready for Phase 8 documentation or a future package to adopt), any UI for the cohort/compare/metrics machinery (Phase 6/7 — this phase is backend-only, `analyzeTelemetry`'s new fields are not yet rendered anywhere in the portal).

**Decision log (noteworthy-but-clear calls, not asked about):**
- *Cohort filter shape*: matched the plan's JSON example field-for-field rather than inventing a different normalized shape — clear winner, no real alternative considered.
- *Where package/skill exposure resolves*: inside `applyCohortFilter` itself (reading snapshots on demand) rather than pre-joining snapshot data onto every capture at read time — keeps captures small and avoids a second full-file rewrite pass; the per-call snapshot cache keeps repeated lookups cheap.
- *Policy validator style (accumulate vs throw)*: chose accumulate-and-return (matching `package-catalog.mjs`) over the throw-based style the marker/snapshot/experiment schemas use, because a catalog-wide policy validation pass over N packages wants every package's errors in one report, same as `validatePackageCatalog`'s existing behavior — a real tradeoff (consistency with sibling schemas vs. consistency with actual caller), resolved in favor of the caller it will actually be validated alongside.
- *`experimentStatus`'s spool-reading duplication*: chose a small private duplicate of `readSpoolEvents()` in `telemetry-markers.mjs` over importing `telemetry.mjs` (would create a circular import) or extracting a shared spool-reader module (would touch more files than this fix needed) — smallest change that avoids the cycle.

Tests: `telemetry-metrics-check.mjs`, `telemetry-cohort-check.mjs`, `telemetry-compare-check.mjs`, `telemetry-policy-check.mjs` (all pure-module, no CLI process, following the classifier/inference test style), wired into `package.json` (`test:telemetry-metrics`, `test:telemetry-cohort`, `test:telemetry-compare`, `test:telemetry-policy`) and `test-roborepo.sh`. `telemetry-compare-check.mjs`'s fixtures mirror the plan's "Scenario fixture: full-suite debugging loop" shape (used again, expanded, in the Phase 8 recommended-experiment validation). Full suite: 314 passed, 0 failed after this phase (up from the 310 baseline).

## Phase 6 notes (portal global filters and markers)

Recorded 2026-07-21, ahead of Phase 7.

**Portal marker/experiment/analysis endpoints** live in `scripts/cli/portal-routes-telemetry.mjs` (extended, not split into a sibling file — the plan left this open as a design gap and the existing file was small enough that adding six more routes kept it cohesive rather than fragmenting the telemetry route surface across two files): `GET/POST /api/telemetry/markers`, `GET/POST /api/telemetry/experiments`, `POST /api/telemetry/experiments/:id/end`, `POST /api/telemetry/analysis`. All mutation handlers call straight into `telemetry-markers.mjs`'s `createMarker`/`startExperiment`/`endExperiment` — the same functions the CLI calls — via new wrapper functions in `telemetry.mjs` (`createMarkerFromPortalRequest`, `createExperimentFromPortalRequest`, `endExperimentFromPortalRequest`, `loadTelemetryAnalysisRequest`) that only add server-side field validation mirroring the CLI's own `parseMarkArgs`/`parseExperimentStartArgs` checks (a browser POST body skips the CLI's argv parsing entirely, so the validation has to be re-asserted here, but the actual marker/experiment creation logic is not duplicated). `portal-server.mjs`'s generic `route()` dispatcher required no changes — `handleTelemetryApi` already had a single call site there from Phase 0-era wiring.

**`/api/data`** gained `?model=`, `?repo=`, `?marker_id=` query params on top of the existing `?range=`/`&end=`/`?harness=`, all backward compatible (omitting them behaves exactly as before). New response fields: `available_models`, `available_repos`, `available_metrics` (26 ids from the registry, added in this phase specifically so the portal's future metric-select never hardcodes the list — used by Phase 7's Analysis explorer), `markers` (window-scoped via the existing `filterByWindow`, same function that already scoped captures), `experiments` (full `experimentStatus(null)` list, not just ids), `marker_comparison` (populated when `marker_id` resolves). `loadAnalysis`'s signature grew a third options argument (`{ model, repo, markerId }`) threaded into `analyzeTelemetry`'s cohort/marker options from Phase 5 — this is the first real UI consumer of that Phase 5 plumbing.

**Portal frontend**: the plan's file-split (`state.js`/`api.js`/`templates.js`/`renders.js`/`chart.js`/`panels.js`/`modals.js`/`app.js`) was already complete before this phase (per the parent task's briefing) — Phase 6 only extended these existing files, never re-split anything.
- `state.js` gained the URL-state helpers (`viewToSearchParams`, `viewFromSearchParams`, `syncViewToUrl`, `activeFilterCountFromView`) — all pure functions over `URLSearchParams`/`location`/`history`, independently testable in Node (see Tests below) without a DOM.
- `app.js`'s `view` object grew `model`/`repo`/`markerId` alongside the existing `rangeMs`/`panEnd`/`harness`, now initialized from `viewFromSearchParams(new URLSearchParams(location.search))` on load and synced back via `syncViewToUrl(view)` on every `load()` call — this is the "bookmarked filters restore correctly" exit criterion.
- Cohort filter bar (`#cohortfilt` in `index.html`): model/repo `<select>`s populated from `available_models`/`available_repos`, a marker-comparison `<select>` populated from window-scoped `change`/`experiment-start` markers, an active-filter-count summary, and a clear button. Each control's `change` handler sets the corresponding `view` field and calls `load(true, { wipe: true })`, mirroring the existing harness-filter-button pattern exactly.
- Marker-creation dialog (`#marker-modal`): a plain `<form method="dialog">` (type/title/metric/expected-direction/status fields), opened via a "+ mark change" button in the cohort filter bar, POSTing through `api.createMarker()`. Server-side errors (invalid type, missing title, etc.) render inline via `#markererr` rather than a browser alert.
- `chart.js` gained marker-overlay drawing: `drawMarkerOverlay()` renders one dashed vertical line + dot per marker (or per cluster) on top of whichever chart mode is active, computed from the SAME `t0`/`span`/`xOf` each mode's own draw function already derives from `points` — so overlay lines always land at the correct x position regardless of mode. Distinct color per marker `type` (`MARKER_STYLES` map). Markers within `MARKER_CLUSTER_PX` (10px) of each other collapse into one cluster dot (plan: "overlapping markers cluster rather than becoming unreadable"); hovering a cluster shows every marker in it via a dedicated `#markertip` tooltip element (kept separate from the existing `#tooltip` so both can never fight over the same DOM node); clicking a cluster opens the first marker's detail via a new `onMarkerClick` callback wired the same way `onBarClick`/`onSessionClick` already are.
- Marker click → detail: `app.js`'s `openMarkerDetailModal()` uses the existing generic `modal.open()` primitive (same one every other detail view uses) with a "compare across this marker" action (only shown for `change`-type markers) that sets `view.markerId` and reloads — this is how a user goes from "I see this marker" to "show me its before/after comparison" without leaving the chart.
- Marker-relative comparison rendering: a new `#markercomparisonpanel` section (under "cost analysis", next to the existing exploratory-midpoint-regression panel, which was re-labeled "(exploratory)" in its heading and legend text to make the distinction visible) shows the full actionable-finding-contract fields via `renders.js`'s new `renderMarkerComparison()`.

**Bug caught during manual portal smoke-testing (not by an automated test, worth recording):** none — the endpoint/UI wiring worked on first end-to-end curl test after the cohort-filter outcome bug (caught by the Phase 5 unit test) was already fixed. Every `curl` round-trip against a live `roborepo serve` instance (marker create/list, experiment start/status/end, analysis with and without a marker, unknown-metric rejection, missing-token 403, `/api/data` with `model=`) matched expectations on the first attempt.

**Portal verification approach (per the plan's "no Playwright" decision):** every Phase 6 exit criterion was verified via (a) real HTTP calls against a `roborepo serve` instance — `curl` for status codes/JSON shapes, `node --check` for served JS syntax — both manually during development and as permanent `test-roborepo.sh` assertions, and (b) direct code-level review of the DOM/event-wiring/URL-state functions. The one Phase 6 exit criterion with a genuine automated test: "bookmarked filters restore correctly" is covered by `telemetry-portal-state-check.mjs`, which drives `state.js`'s `viewToSearchParams`/`viewFromSearchParams` directly in Node (they have no DOM dependency — only the `URLSearchParams` global) and asserts an exact round-trip. The other criteria ("all existing panels reflect the same global cohort", "marker display remains usable when clustered") were verified by code review plus the live-server curl checks confirming the server-side cohort filter actually changes `/api/data`'s output, and reading `drawMarkerOverlay`'s clustering logic line-by-line — not executed inside a real browser.

**Decision log (noteworthy-but-clear calls, not asked about):**
- *Marker/experiment/analysis endpoints in `portal-routes-telemetry.mjs` vs. a new sibling file*: extended the existing file — the plan explicitly left this as an open choice ("your call, not a fork-worthy decision" per the task briefing), and six more route blocks in an already-small file reads more cohesively than a second file that would need to re-import the same handlers destructuring pattern.
- *Cohort-vs-cohort analysis (no marker) uses a simpler value+sample-size comparison, not the marker-relative confidence/data-quality machinery*: `compareAcrossMarker`'s before/after split and equalization only make sense relative to a single marker timestamp — with two independent cohort filters there is no shared timestamp to split sessions around, so `loadTelemetryAnalysisRequest`'s no-marker branch calls `computeMetric` directly per cohort instead. Both paths still report sample size and both are labeled `correlation_only: true`.
- *Marker click always opens detail via the existing generic modal, not a dedicated marker-detail component*: consistent with how every other clickable chart element (bars, session chips) already opens via the same `modal.open()` primitive — no new modal type needed.

Tests: `telemetry-portal-state-check.mjs` (pure, drives `state.js`'s URL helpers directly in Node), plus 13 new `test-roborepo.sh` assertions reusing the existing config-portal-test server (loopback HTTP checks: served page includes new markup, served JS parses, marker CRUD round-trip incl. 403-without-token and 400-on-invalid-type, experiment start/status/end round-trip incl. `ready`/`data_quality_warnings` shape, analysis endpoint's unknown-metric 400 and no-marker two-cohort mode). Full suite: 327 passed, 0 failed after this phase.

## Phase 7 notes (action items, testing panel, and explorer)

Recorded 2026-07-21, ahead of Phase 8.

**Actionable finding contract upgrade for deterministic insights**: `telemetry-insights.mjs`'s `deriveInsights()` still returns the original `{severity, headline, detail, metric}` shape every existing consumer (CLI's `printInsights`, `insightsSummary`) reads unchanged, but each finding now also carries `kind` (a stable identifier per rule, e.g. `"dominant_cost"`, `"runaway_loop"`), `sample_size`, and — via a new `attachActionableFields()` pass applied to every finding right before the final `slice(0, 8)` — `confidence` (`"strong signal"` when `sample_size >= STRONG_SIGNAL_MIN_CALLS` (40, = `MIN_CALLS`×2), else `"emerging pattern"`; these deterministic rules never reach `"insufficient evidence"` here because each rule's own firing threshold already gates on enough evidence to fire at all) and `analysis_filter_state` (`{ kind }`, consumed by the portal's "open analysis" button). Each of the six existing rules (`mcp_vs_native`, `spike_tail_risk`, `dominant_cost`, `runaway_loop`, `midpoint_regression`, `heaviest_tool`) also gained a deterministic `next_action` template string specific to that finding shape — never free LLM text, matching the plan's "Optional synthesis may explain those results, but cannot invent metrics, cohorts, confidence, or causal conclusions."

**Portal action-item rows** (`templates.js`'s `insightRow()`) now render `confidence`/`next_action` as extra lines under the existing headline/detail, plus an "open analysis ›" button when `analysis_filter_state` is present — additive DOM appended to the existing `tpl-insight` template, not a template replacement. `app.js`'s click delegation reads the button's `data-filter-state` (JSON) and calls into the Analysis explorer's `openWithFilterState()`.

**Testing-efficiency panel** (`#testeffpanel` in `index.html`, `renders.js`'s `renderTestingEfficiency()`): reads `telemetry-analyze.mjs`'s `testing_efficiency` object (10 `test.*` metric values, wired in Phase 5) and renders a headline sentence leading with the most actionable abnormality (redundant full-suite reruns without an intervening edit) per the plan's "should lead with the most actionable abnormality rather than a comprehensive table," followed by a compact metrics table. Placed directly under the "warnings & abnormalities" section head, per the plan's explicit panel placement. Hidden entirely when the cohort has no test-classified operations (all values null) rather than showing an all-dash table.

**Analysis explorer** (`portal/telemetry/analysis-explorer.js`, new file — the plan named this module explicitly): a collapsed-by-default `<details>` block (`#analysisexplorer`, placed as section ⑦ after the existing raw-breakdowns section) with metric selection (populated from `/api/data`'s `available_metrics`), a mode toggle (marker-relative vs. cohort-A-vs-cohort-B), marker/harness selects for each mode, a "run comparison" button hitting `POST /api/telemetry/analysis` via `api.js`'s `fetchTelemetryAnalysis()`, and a result panel rendering whichever response shape came back (full finding contract for marker-relative, simpler value+sample-size pair for cohort-vs-cohort). `createAnalysisExplorer()` returns `{ refresh, openWithFilterState, setMetrics }` — `refresh()` is called every `load()` tick (mirrors how the cohort filter bar's selects stay current) and `openWithFilterState()` is the "open analysis" entry point every insight/marker-comparison row's button calls, which expands the `<details>`, scrolls it into view, and pre-selects the metric/marker from the finding's `analysis_filter_state`. This satisfies the plan's "'open analysis' reproduces the alert's exact cohort and metric" exit criterion for the two dimensions findings currently carry (metric, marker); a finding's other cohort dimensions (harness/model/repo filters active at the time) are not yet threaded into `analysis_filter_state` — see Deferred below.

**Session detail extension** (plan: "Extend the current session modal with: model history, configuration snapshot, active packages/skills, explicit versus inferred task category and outcome, phase timeline, semantic operation totals, testing-efficiency summary, markers inside or adjacent to the session, data-quality flags"): a new `sessionSpoolContext(sessionId, markers)` in `telemetry.mjs` scans the already-loaded spool for one session's own captures (cheap — filtered from the array already in memory, not a second read) and derives everything the plan's list asks for that's computable from spool + marker data alone: model history (distinct models seen, first-seen order), the session's most recent configuration snapshot (id + packages + skills, read via `readSnapshot()`), a phase timeline (contiguous same-phase runs with start/end timestamps), semantic operation totals (count by `operation.category`), the session's explicit outcome marker if any (status + task_category, explicitly tagged `source: "explicit"` vs. `source: "none"` — there is no task-category *inference* wired to a live caller yet, per the Phase 4 notes' deliberate deferral, so "inferred" never actually appears here today), markers within a 15-minute adjacency window of the session's own capture span, and data-quality flags (missing snapshot, missing model, pre-v3-schema capture count). Wired into `loadSession`'s handler in `serveCommand` (`loadSession: (req) => loadSessionDetail({ ...req, spoolContext: sessionSpoolContext(req.id, readMarkers()) })`) and threaded through `loadSessionDetail`'s return value as `spool_context`, present whether or not the transcript itself was found on disk (so a rotated/missing transcript still shows what the spool knows). `modals.js`'s `fetchSessionContext()` renders these fields as a `spoolContextNodes()` block prepended before the existing heavy-turns/transcript-not-found rendering — testing-efficiency-per-session was intentionally left out of this render pass (the metrics registry's `test.*` formulas operate on multi-session cohorts, not gracefully on a single session's handful of captures; showing them here risked implying false precision) in favor of the operation-totals count, which is the honest single-session equivalent.

**Deferred to later phases, deliberately not attempted here:**
- Threading a finding's full cohort (harness/model/repo, not just metric/marker) into `analysis_filter_state` so "open analysis" reproduces every dimension, not just metric+marker — the six deterministic insight rules today are global (not scoped to the currently-active cohort filter), so there is no extra cohort information to carry yet; this becomes relevant once a rule fires *within* an active cohort filter, which is a natural Phase 8+/future-work item, not a Phase 7 exit-criterion gap (the exit criterion only requires reproducing "the alert's exact cohort and metric," and today's alerts have no cohort beyond "all data").
- Per-session testing-efficiency numbers in the session modal (see above) — the registry's formulas are multi-session by design; a future single-session variant would need its own explicitly-labeled formula, not a naive apply-to-one-session call.
- A live package declaring `telemetry.policies` (Phase 5's policy engine has no real-world caller yet) and a portal surface for policy findings — no exit criterion in Phases 5-7 requires this, and speculatively adding it without a concrete need felt like scope creep (same call as Phase 5's deferral).

**Decision log (noteworthy-but-clear calls, not asked about):**
- *`attachActionableFields`'s confidence threshold uses `MIN_CALLS`-scale sample sizes, not `telemetry-compare.mjs`'s session-count thresholds*: the six deterministic rules in `telemetry-insights.mjs` operate on calls/spikes/loops, not sessions, so reusing `STRONG_SIGNAL_MIN_SESSIONS` (20 sessions) directly would be a category error — scaled the philosophy (not the exact number) to `MIN_CALLS`×2 (40 calls), matching the existing rule-firing thresholds' own units.
- *Testing-efficiency panel hides itself entirely rather than showing an all-null/all-dash table*: consistent with how every other panel in this file already degrades (`renderPackageCost`/`renderAnatomy`/etc. all call `emptyPanel()` or hide when there's nothing to show) — no new pattern introduced.
- *Session modal's spool-context render is prepended, not replacing, the existing heavy-turns section*: preserves the plan's explicit "Retain the current 'surface chat context,' copy-prompt, and transcript-open behavior" requirement byte-for-byte; the new content is purely additive.

Tests: no new pure-module test file this phase (the additions are either DOM-rendering code covered by the existing "no Playwright" verification approach — code review + live-server curl checks confirming `/api/data`'s `insights[].confidence`/`next_action`/`analysis_filter_state` and `testing_efficiency` fields are populated correctly — or thin wiring with no independent logic worth a dedicated fixture). `telemetry-correctness-check.mjs` was rerun to confirm `deriveInsights`'s additive fields don't break existing assertions. Full suite: see Phase 8 notes for the final count after this phase's `test-roborepo.sh` additions.

## Phase 8 notes (documentation, migration, and hardening)

Recorded 2026-07-22, at plan completion.

**Documentation**: added `docs/user/reference/telemetry.md`, a single consolidated reference doc
(matching this repo's existing per-service-doc convention — see `developer-runtime.md` covering settings/
API/security/limits in one file rather than split guides) covering capture, markers, experiments,
configuration snapshots, the cohort/metrics/comparison model, package telemetry policies, the CLI
report, the portal (including every new Phase 6/7 UI piece), the full API surface (read and mutating
routes), privacy/retention, and a schema-version table. Added to `package.json`'s `files` array so it
ships with the package. Updated `docs/user/reference/portal.md`'s route inventory line for
`portal-routes-telemetry.mjs` to list the six new marker/experiment/analysis endpoints (it previously
only listed `/api/data`, `/api/session`, `/api/insights-llm` from the Phase 0-era wiring) and pointed
it at the new telemetry.md for the domain detail, keeping portal.md itself focused on the shared
server/route/mutation-token architecture rather than growing a second telemetry section inside it.

**Migration**: no destructive migration exists or was needed. Schema-v2 capture records remain
readable end to end — `readSpoolEvents()`/`analyzeTelemetry()` never gate on `.schema`, confirmed
unchanged by the existing `telemetry report: legacy metadata-only records still report` assertion in
`test-roborepo.sh`, which still passes. Every new capture-v3/marker/snapshot/experiment field is
additive; every new `analyzeTelemetry()` option is optional with a call-compatible one-argument form
still supported (verified: `telemetry-correctness-check.mjs`'s existing single-argument calls pass
unchanged). No existing install requires any manual step to pick up Phases 5-8 — the next capture
after upgrade starts writing the same schema-v3 shape it already was (Phase 3+), and the new metrics/
cohort/compare/policy modules activate automatically the first time a marker or cohort filter is used.

**Performance**: ran `analyzeTelemetry()` against a synthetic 40,000-capture spool (approximating the
~25MB per-harness spool cap's maximum record count) — completed in ~780ms, including cohort-free
testing-efficiency computation across the full dataset. Well within the plan's "portal response time
remains acceptable on maximum supported spool sizes" exit criterion; the portal's 5-second poll
interval has ample headroom. No new hot-path cost was added to `telemetry-capture.mjs` itself in
Phases 5-8 — all Phase 5-7 work is read-side (CLI report / portal / analysis endpoint), not touching
the capture hook's import graph or per-event work at all.

**jcodemunch changed-symbol/reference review** (plan's explicit Phase 8 requirement): ran
`get_changed_symbols(since_sha: 3c3d91b, until_sha: HEAD)` after re-indexing — 188 symbols added, 23
modified, **0 removed**, across the 26 files touched in Phases 5-7. The 23 modified (not newly added)
symbols are exactly the shared functions Phases 5-7 deliberately extended: `analyzeTelemetry`,
`deriveInsights`, `experimentStatus`, `handleTelemetryApi`, `loadSessionDetail`, `serveCommand`,
`telemetryReport`, `telemetryExperimentStatus` (backend) and `chart`/`load`/`view`/`wipeSections`/
`createChart`/`createModalOpeners`/`createRenders`/`insightRow` (frontend) — no accidental change to
any function outside this deliberate list. `find_references` was run before touching each of these
during implementation (not just retroactively at the end) — e.g. `analyzeTelemetry` (2 references),
`experimentStatus` (1), `handleTelemetryApi` (1), `createDetailModal`/`createChart`/`createRenders`/
`createModalOpeners` (1 each) — confirming low blast radius before each edit, consistent with the
plan's "Use changed-symbol and reference queries before changing shared functions" requirement.

**Bug found and fixed during this review pass:** re-reading `telemetry-cohort.mjs` while writing
these notes surfaced that `applyCohortFilter()` normalized and documented a `task_categories`
dimension but never actually applied it — only `describeCohortFilter()`/`activeFilterCount()`
referenced the field, and the real per-capture filtering only existed in the separate
`filterSessionsByTaskCategory()` helper `experimentStatus()` calls. This meant the portal's
`/api/telemetry/analysis` cohort-vs-cohort path (which calls `applyCohortFilter` directly) could not
actually filter by task category despite the field being documented in the cohort model. Fixed by
adding a `taskCategoryStatusBySession()` helper (mirroring `outcomeStatusBySession()`'s pattern
exactly — same never-infer-without-markers degrade-to-no-op rule) and wiring it into
`applyCohortFilter`'s per-capture pass; `filterSessionsByTaskCategory()` now reuses the same helper
instead of duplicating the marker-scan logic. Two new assertions
(`testApplyFilterByTaskCategory`/`testApplyFilterByTaskCategoryIgnoredWithoutMarkers`) added to
`telemetry-cohort-check.mjs`. This is the one correctness bug this phase's review pass caught — every
other Phase 5-7 code path checked out on inspection.

**CLI report additions** (closing a gap noticed while writing Phase 8 docs — the plan's "CLI report
changes" section listed sections that Phases 5-7 built the underlying data for but had not yet wired
into `telemetryReport()`): added `printRecentMarkers` (newest 5 markers), `printExperimentReadiness`
(mirrors `telemetry experiment status`'s wording so the two never disagree), and
`printTestingEfficiency` (same metric registry values the portal's testing-efficiency panel reads) to
`scripts/cli/telemetry.mjs`. `telemetryReport()` now calls `analyzeTelemetry(events, { markers })`
instead of the bare one-argument form, so outcome-aware metrics work from the CLI report too. This is
what makes acceptance criterion 11 ("CLI and portal results agree for the same cohort") actually true
end to end rather than true only for the portal.

**Recommended first real experiment — demonstration run** (plan's final section, validated not just
implemented): built a one-off demonstration script (kept outside the repo, in the session's scratch
directory, since it is a validation run rather than shipped product code) that seeds 24 synthetic
sessions (12 "before" / 12 "after") matching the plan's exact screenshot scenario per session — a
build/tooling task, a full-suite failure, four full-suite calls during debugging (three without an
intervening edit, one targeted reproduction), and a final successful full-suite run in finalization —
with the "after" cohort's redundant-rerun count reduced from 3 to 1 per session (simulating partial
guidance effectiveness, not an unrealistically clean 100% fix). Created a real `change` marker (via
the same field shape `createMarker()` produces) attached to `test-harness`, primary metric
`test.full_suite_calls_per_debug_phase`, guardrails `outcome.completion_rate`/
`outcome.verification_pass_rate`, at a timestamp between the two cohorts. Ran the actual
`analyzeTelemetry()`/`compareAcrossMarker()`/`experimentStatus()` functions (not reimplementations)
against this data. Results, matching the plan's documented example shape:

> **Observation:** "Full-suite runs per debugging phase changed from 4 to 2 after \"Test-harness
> guidance v2: no full-suite reruns without an intervening edit\"."
> **Evidence:** before = 12 sessions (value 4), after = 12 sessions (value 2), effect size −2,
> relative change −50%, equal-session-count window, zero excluded sessions.
> **Confidence:** "emerging pattern" (12 sessions per cohort clears the minimum-10 floor but not the
> strong-signal-20 floor — an honest result, not an artificially inflated one).
> **Interpretation:** "Sessions after this marker were exposed to test-harness, test-harness; this is
> a correlation, not a proven cause." (labeled `"labeled_as": "inference"`)
> **Next action:** "Continue monitoring full-suite runs per debugging phase across the next eligible
> sessions."

Also verified: `testing_efficiency` computed real values across the dataset (62.5% of tool time spent
testing, 0.25 targeted-to-full ratio, 2 redundant reruns, 2 unchanged-failure-signature reruns) and
`experimentStatus()` on an experiment whose start marker was this same historical `change` marker
reported `ready: true` with the identical before/after cohort values the direct comparison found. The
CLI report (`roborepo telemetry report`, pointed at this same seeded state directory) printed all
three new sections — recent markers, experiment readiness, testing efficiency — with matching numbers,
confirming criterion 11 end to end, not just via unit tests. This validates every link the plan's
final paragraph names: configuration snapshot (each capture carried a `config_snapshot_id`, distinct
between the before/after cohorts), event marker, semantic test classification (`operation.category`/
`scope`/`exit_status`), phase detection (`phase.name: "debugging"`/`"finalization"`), outcome
guardrails (present on the experiment record), cohort comparison, actionable alert (the full finding
contract above), and drill-down evidence (`testing_efficiency`'s per-metric breakdown).

**Deferred, deliberately not attempted here:** a `test-harness` package.config.json declaring a real
`telemetry.policies` entry (Phase 5's policy engine has no live caller; adding one speculatively
without a concrete need was judged scope creep, consistent with the Phase 5 notes' own deferral of
this) — the demonstration above used the metric/marker/cohort/experiment path directly, which does
not require a package to declare a policy.

Tests: no new test file this phase — Phase 8 work is documentation, a jcodemunch review pass, a
performance smoke check, three CLI report print functions covered indirectly by the existing
`telemetry report` assertions in `test-roborepo.sh` (which already grep for report output and would
catch a crash), and the recommended-experiment demonstration (run manually against real domain
functions, not encoded as a permanent automated test — it is a one-time validation exercise per the
plan's own framing "use ... as the first production validation," not a regression-test scenario;
the underlying comparison/metric logic it exercises is already covered by
`telemetry-compare-check.mjs`'s and `telemetry-metrics-check.mjs`'s fixtures, which mirror this same
scenario shape). Full suite: 328 passed, 0 failed (unchanged from Phase 7 — no test files were added
in Phase 8, only doc/CLI-report-wiring changes verified not to regress existing assertions).

## Phase 9 notes (post-merge UI polish and plan closure)

Recorded 2026-07-23, closing the plan out after PR #1 merged to `main` (`c1be1dc`).

**Filter bar bugs found and fixed during a user-driven UI review pass** (not a new phase of planned
work — reactive fixes to the Phase 6 filter bar surfaced by actually using it): the time-range/
source controls stayed right-aligned instead of sharing a left edge when wrapped to two lines; the
fix's first attempt targeted a stale `.ranges` selector left over from the `.filter-row` rename and
silently never applied (caught during this phase's own review pass) — corrected to target
`.filter-row .pan`. The redundant "filters" label was dropped from the cohort row (both filter rows
read as filters without it) and the info icon was moved into its own fixed-width gutter, bottom-
aligned to the cohort row via `align-items:flex-end`. The active-filter count/clear pair could split
across wrapped lines (`.filter-count-group` now wraps both as one flex item, right-aligned via
`flex-basis:100%` when it wraps alone). "time range" label shortened to "range"; the marker
dropdown's default option changed from "no marker comparison" to "all events".

**Real bug, not cosmetic: the marker-relative comparison panel (Phase 6/7's actionable-finding-
contract UI) was invisible in practice.** `#markercomparisonpanel` lived inside the collapsed-by-
default "④ cost analysis" `<details>` block — selecting a marker in the global filter bar correctly
populated `data.marker_comparison` server-side and correctly toggled the panel's own `display`, but
the ancestor `<details>` stayed closed, so the panel was invisible regardless. This directly
undermines acceptance criterion 9 ("every alert exposes evidence, cohort, sample size, confidence/
data-quality, and a concrete next action") — the alert existed but was unreachable without already
knowing to expand an unrelated collapsed section. Fixed by moving the panel out of tier-4 entirely,
into its own always-visible section right after the chart (tier 2) — it is a direct result of the
global filter bar above it, not a raw cost breakdown, so it does not belong gated behind a disclosure
widget. Also redesigned its content: before/after/change/confidence now render as scannable stat
tiles (this page's existing `.stat-row`/`.stat-item` language, reused rather than inventing a new
pattern) instead of one comma-packed sentence, and the data-quality caveats collapse into a
`<details class="quality-issues">` bullet list instead of a semicolon-joined paragraph.

**Mermaid diagrams in the "view docs" guide popup now render live**, closing a gap the Phase 6 notes
didn't call out: `docs/user/guides/telemetry.md`'s mermaid fenced blocks previously rendered as escaped
source text only (no CDN dependency, so no runtime renderer existed). Vendored `mermaid.min.js`
(v11.16.0, MIT, `portal/shared/vendor/`) rather than loading from a CDN, keeping the portal
loopback-only/offline-capable per its existing architecture constraint — `markdown-render.mjs` now
emits `<pre class="mermaid" data-mermaid-source="...">`, and `doc-guide-modal.js` lazy-loads mermaid
and renders each block to SVG (theme-matched light/dark), falling back to the escaped source
untouched if the script fails to load or a diagram fails to parse.

**Merge conflict resolved bringing `main` in before closing the plan:** `portal/plans/index.html` had
diverged — this branch had refactored the Plans page's control bar onto the shared `.control-panel`/
`.control-panel-row` classes, while `main` had independently shipped the lifecycle-tabs feature
(replacing an inline lifecycle `<select>` filter-row with a dedicated tabs nav) on the pre-refactor
structure. Resolved by taking main's content (lifecycle-tabs nav, dropped the now-redundant
lifecycle dropdown) with this branch's `.control-panel` class refactor applied on top — verified
against `styles.css`'s own documented rationale for those classes, not a guess.

Tests: `markdown-render-check.mjs` updated for the new mermaid markup shape and passing;
`plan-docs-check.mjs` passing after the merge. No new pure-module test files this phase — the UI
fixes are DOM-rendering/layout code verified via live-server checks (`curl` against a running
`roborepo serve`, `node --check` on served JS, tag-balance sanity checks), consistent with the
"no Playwright" verification approach the plan established in Phase 6.

**Closing status:** all 9 phases now implemented, tested, and documented. Acceptance criteria 1-15
remain met (see Phase 8 notes); this phase's fixes strengthen criterion 9's actual reachability
rather than changing its status. The one deliberate deferral from Phase 5 stands unchanged: no
package declares a live `telemetry.policies` entry yet — the mechanism is built, validated, and
tested, just unused by any real package. Branch `telemetry-events-experiments` merged to `main` via
PR #1 (`c1be1dc`); worktree and local branch removed post-merge.

## Current behavior that must be preserved

### Capture lifecycle

RoboRepo currently wires `SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `Stop` hooks for Claude and Codex. The hot capture path is intentionally isolated in `scripts/cli/telemetry-capture.mjs` so every hook does not load the portal and analysis dependency graph.

Each schema-v2 capture currently records:

- ISO timestamp;
- harness and event;
- session/conversation ID;
- hashed working directory plus its basename;
- repository label, hashed root/remote, branch, and short Git SHA;
- tool name, MCP identity, command hash/size, and privacy-safe file metadata;
- best-effort tool duration from paired pre/post hooks;
- prompt size, hash, and a 200-character normalized preview;
- transcript-derived model and cumulative token counters;
- assistant, tool, and MCP call counters;
- newest and largest transcript tool-result sizes without retaining full result content.

Capture is locally enabled/disabled through telemetry state. Records are appended to per-harness JSONL spools and capped at approximately 25 MB each.

### Current analysis

`scripts/cli/telemetry-analyze.mjs` currently derives:

- session rollups;
- delta-token spike thresholds and one worst spike per session;
- token contributors by repository, tool, MCP server, and event;
- spike-versus-normal cohorts;
- spike causes;
- recent estimated token windows;
- per-capture timeline data;
- per-tool, functional-group, and MCP-package result-size cost;
- spike anatomy and lift;
- earlier-versus-later midpoint regression;
- consecutive same-tool loop detection.

`scripts/cli/telemetry-insights.mjs` converts these facts into conservative deterministic findings. The optional deeper read sends only a computed summary—not the raw spool—to an available agent CLI.

### Current portal

The telemetry portal is frameworkless and dependency-free. It uses browser modules, HTML `<template>` elements, a canvas controller, pure state helpers, API wrappers, panel/modal controllers, and dedicated render functions.

Current global scope controls are:

- time range;
- panned time-window endpoint;
- harness.

The server applies these filters to the entire report. The page then presents:

1. deterministic action items;
2. token timelines;
3. warnings, loops, spikes, and spike causes;
4. collapsed cost analysis;
5. sessions;
6. raw supporting breakdowns.

This ordering, the local-only server, content-safe rendering, transcript-context actions, and five-second data polling must be preserved.

### Known limitations to correct

1. The model is captured but omitted from session rollups and portal filtering.
2. `package_cost` means MCP server or `native`; it does not represent RoboRepo package exposure.
3. Installed or active skills are not associated with sessions.
4. Midpoint regression is not aligned with a real implementation change.
5. A hashed Bash command cannot be classified as test/build/lint or targeted/full-suite.
6. Same-tool loop detection cannot distinguish repeated semantic operations performed through Bash.
7. A session-wide average can hide waste that occurs specifically during debugging.
8. Cost analysis does not include completion or verification outcomes.
9. Alerts do not expose cohort definitions, sample sufficiency, confidence, or data-quality limitations.
10. The single per-session tool-duration cursor can be overwritten by nested or concurrent calls; new pairing must use a stable call identifier when the harness supplies one.

## Product decisions

### 1. One event model

Use a general `telemetry marker` record rather than separate storage formats for releases, phases, outcomes, and experiments.

Supported marker types in the first complete implementation:

- `change` — implementation/configuration change;
- `phase` — explicit task phase boundary;
- `outcome` — session or task result;
- `experiment-start`;
- `experiment-end`;
- `note` — user-defined timestamped context.

Markers are immutable append-only events. Corrections append a superseding marker referencing the original ID; existing history is never edited silently.

### 2. Configuration exposure, not causal attribution

Represent relationships with explicit confidence levels:

| Relationship | Meaning | Permitted wording |
| --- | --- | --- |
| available | Installed on the machine | “available during the session” |
| active | Included in the effective session configuration | “session was exposed to” |
| observed | Invocation or loader event was directly captured | “observed in use” |
| caused | Not generally measurable | Never infer automatically |

Rules, root prompts, and active skills are composite context. RoboRepo may correlate their versioned exposure with outcomes but must not allocate portions of assistant output tokens to them.

Direct tool-result context cost remains attributable to the tool that produced the result, using the current result-size approximation. Clearly label this separately from total model tokens.

### 3. Hybrid filtering

Keep a compact global cohort bar and add a dedicated Analysis explorer.

Global filters define the cohort used by every panel:

- time range;
- harness;
- model;
- repository;
- saved experiment/cohort.

The Analysis explorer handles high-cardinality refinements:

- RoboRepo package and configuration version;
- skill and skill revision;
- tool, MCP server, functional tool group, and semantic operation;
- test scope and runner;
- marker-relative before/after window;
- branch, Git SHA, and configuration snapshot;
- task category, task scale, and phase;
- outcome status;
- metric.

Panel-local controls are permitted only for presentation or concepts unique to that panel, such as choosing calls versus duration in the testing panel. They must not silently redefine the global cohort.

### 4. Deterministic facts before synthesis

All portal alerts, comparisons, and experiment results must be computable without an LLM. Optional synthesis may explain those results, but cannot invent metrics, cohorts, confidence, or causal conclusions.

### 5. Advisory policies

Packages may define telemetry expectations, but policy violations remain advisory in this scope. Do not block tools or harness activity.

## Proposed storage architecture

Retain append-only local storage and the current dependency-free runtime.

Suggested paths under the existing telemetry state directory:

```text
telemetry/
  spool/
    claude.jsonl
    codex.jsonl
  events/
    markers.jsonl
  snapshots/
    <snapshot-id>.json
  experiments/
    <experiment-id>.json
  collector/
    ...existing cursors...
```

Do not move existing spool data in the first migration. Readers must accept schema-v2 records and the new schema side by side.

### Capture schema v3

Add fields without changing the meaning of existing fields:

```json
{
  "schema": 3,
  "capture_id": "cap_...",
  "call_id": "harness-call-id-or-derived-id",
  "config_snapshot_id": "cfg_...",
  "operation": {
    "category": "test",
    "runner": "npm",
    "scope": "full",
    "target": null,
    "signature": "hash",
    "failure_signature": "hash-or-null",
    "exit_status": "pass"
  },
  "phase": {
    "name": "debugging",
    "source": "inferred",
    "confidence": 0.83
  }
}
```

Requirements:

- `capture_id` is unique and stable.
- Prefer a harness-provided tool-use ID for `call_id`.
- When unavailable, derive a best-effort ID from session, tool, timestamp, and an incrementing cursor.
- Pair pre/post duration records by `call_id`, not only session.
- Preserve null/unknown instead of guessing.
- Do not store raw shell commands or full test output by default.
- Continue storing hashes, lengths, categories, bounded previews, and privacy-safe derived metadata.

### Marker schema

```json
{
  "schema": 1,
  "marker_id": "mark_...",
  "ts": "2026-07-19T23:10:00.000Z",
  "type": "change",
  "title": "Prevent full-suite debugging loops",
  "description": null,
  "repo": "roborepo",
  "branch": "main",
  "sha": "abc1234",
  "config_snapshot_id": "cfg_...",
  "packages": ["test-harness"],
  "skills": ["test-harness"],
  "tags": ["testing", "behavior"],
  "metric": "test.full_suite_calls_per_debug_phase",
  "expected_direction": "decrease",
  "supersedes": null
}
```

Automatically fill repository, branch, SHA, snapshot ID, and timestamp when available. User-supplied values override only optional descriptive fields, not machine-derived identity fields.

### Configuration snapshot schema

Snapshots are content-addressed and deduplicated. Capture the effective configuration, not merely repository source files.

Each snapshot should contain:

- snapshot ID and creation time;
- RoboRepo version/commit;
- harness name and harness version when detectable;
- active model when detectable at session start, with later captures allowed to override model per turn;
- enabled RoboRepo packages and package definition hashes;
- active rule source IDs and rendered-content hashes;
- installed/active skill IDs and content hashes;
- hook IDs and content/config hashes;
- commands and MCP configuration hashes;
- feature flags and relevant telemetry settings;
- source state needed to label configuration drift;
- a schema version.

Do not duplicate complete skill/rule text into every snapshot. Store normalized metadata and hashes. Existing repository or managed-cache sources provide the inspectable content.

Create the snapshot at `SessionStart` and reference it from later captures. If effective configuration changes during a session, create a new snapshot and use it for subsequent records.

### Experiment definition

```json
{
  "schema": 1,
  "experiment_id": "exp_...",
  "title": "Test-harness guidance v2",
  "start_marker_id": "mark_...",
  "end_marker_id": null,
  "primary_metric": "test.full_suite_calls_per_debug_phase",
  "expected_direction": "decrease",
  "guardrails": ["outcome.completion_rate", "outcome.verification_pass_rate"],
  "eligibility": {
    "task_categories": ["bug-fix", "build-tooling", "refactor"],
    "minimum_sessions_per_cohort": 10
  },
  "comparison": "previous-equivalent-window"
}
```

An experiment definition describes analysis intent. Its start/end remain marker events so they render naturally on the timeline.

## CLI design

### Marker command

Canonical command:

```bash
roborepo telemetry mark \
  --type change \
  --title "Prevent full-suite debugging loops" \
  --package test-harness \
  --skill test-harness \
  --metric test.full_suite_calls_per_debug_phase \
  --expect decrease
```

Required:

- `--type`;
- `--title`.

Optional repeatable fields:

- `--package`;
- `--skill`;
- `--tag`;
- `--metric`;
- `--expect increase|decrease|no-change`;
- `--description`;
- `--session`;
- `--phase` for phase markers;
- `--status` for outcome markers;
- `--supersedes`.

The command prints the created marker ID, timestamp, resolved repository/SHA, and snapshot ID. It must fail clearly for invalid enum values and never silently discard unknown flags.

### Convenience skill

Add a small RoboRepo skill that helps an agent create a meaningful marker, but keep the CLI as the source of truth.

The skill should:

- ask only for missing intent that cannot be derived;
- propose a concise title;
- associate likely packages/skills without claiming causation;
- suggest a primary metric and expected direction;
- invoke the CLI;
- report the marker ID.

Do not require a skill for ordinary use. A human must be able to create every marker directly through the CLI.

### Experiment commands

```bash
roborepo telemetry experiment start \
  --title "Test-harness guidance v2" \
  --metric test.full_suite_calls_per_debug_phase \
  --guardrail outcome.completion_rate \
  --minimum-sessions 10 \
  --expect decrease

roborepo telemetry experiment end <experiment-id>
roborepo telemetry experiment status [<experiment-id>]
```

`start` creates both the experiment definition and its marker. `end` appends an end marker and links it to the experiment. Status must show cohort size, eligibility, data-quality warnings, and whether the result is ready—not merely a provisional winner.

### Outcome command

```bash
roborepo telemetry mark \
  --type outcome \
  --session <session-id> \
  --status successful \
  --title "Portal refactor verified"
```

Supported outcome states:

- `successful`;
- `partial`;
- `failed`;
- `abandoned`;
- `unknown`.

Inferred outcomes must remain distinguishable from explicit outcomes.

### Existing command compatibility

Retain `install`, `stop`, `enable`, `disable`, `status`, `report`, `export`, `backup`, and `purge`. Update usage manifests and menus rather than adding undocumented command paths.

Backup, export, and purge must include markers, snapshots, and experiments. `purge --backup` must remain recoverable. Telemetry-only installs must still work even if configuration exposure is limited; missing snapshot dimensions should be reported as unavailable.

## Semantic tool-operation classification

Create a pure classifier module separate from the capture hot-path orchestration. The capture module may import it only if startup cost remains negligible.

### Initial categories

- `test`;
- `lint`;
- `typecheck`;
- `build`;
- `format`;
- `install`;
- `git`;
- `serve`;
- `file-read`;
- `file-write`;
- `search`;
- `mcp`;
- `other`.

### Test dimensions

- runner: `npm`, `pnpm`, `yarn`, `bun`, `node-test`, `vitest`, `jest`, `playwright`, `pytest`, shell script, or `unknown`;
- scope: `targeted`, `affected`, `full`, or `unknown`;
- safe target label when it can be derived without exposing a sensitive path;
- pass/fail/blocked/unknown;
- failure signature;
- duration;
- output-size estimate;
- whether an edit or changed failure signature occurred since the previous equivalent run.

### Classification rules

1. Prefer repository-declared command knowledge from `package.json`, Makefiles, scripts, and CI configuration.
2. Normalize wrappers such as `npm run`, `roborepo run`, and shell-script indirection.
3. Treat explicitly named test files, paths, filters, projects, or affected selectors as targeted/affected.
4. Treat a known repository-wide test script without selectors as full.
5. Return unknown when the command is ambiguous.
6. Store a rule/version identifier with the classification so historical data remains interpretable after classifier changes.

Never treat all `npm test` commands across all repositories identically without consulting repository command metadata.

## Intervening-work analysis

Repeated full-suite execution is actionable only when RoboRepo understands what happened between runs.

Track privacy-safe intervening signals:

- whether a write/edit tool completed;
- changed-file count and extension/category;
- whether Git diff fingerprint changed;
- whether a targeted test ran;
- whether the previous failure signature changed;
- whether the task phase changed;
- elapsed wall-clock time.

Derived testing findings:

- full-suite runs per session;
- full-suite runs per debugging phase;
- full-suite runs without an intervening edit;
- full-suite reruns with the same failure signature;
- percentage of captured tool time spent testing;
- targeted-to-full test ratio;
- time from full-suite failure to targeted reproduction;
- time from first failure to successful verification;
- finalization full-suite count;
- estimated tokens accumulated during testing activity.

Example deterministic finding:

> Testing consumed 51% of captured tool time. The full suite ran four times during debugging; three reruns had no intervening source edit or changed failure signature. Run one targeted reproduction after a failure and reserve the next full suite for the phase boundary.

## Phase detection

Use both explicit and inferred phases.

Supported phase names:

- `discovery`;
- `implementation`;
- `debugging`;
- `verification`;
- `finalization`;
- `unknown`.

Rules:

- Explicit phase markers take precedence from their timestamp forward until superseded.
- Inferred phases use explainable tool/activity patterns, not an opaque model.
- Store inference source, classifier version, and confidence.
- Low-confidence phases collapse to unknown in comparisons unless the user opts in.
- A session may move between phases more than once.

Initial inference examples:

- exploration/read/search with no edits → discovery;
- repeated edits with scoped validation → implementation;
- failing tests followed by edits and reruns → debugging;
- broad checks after implementation stabilizes → verification;
- final status checks, commits, and completion output → finalization.

Do not make the phase classifier responsible for determining whether the task succeeded.

## Outcomes and task cohorts

### Outcome signals

Capture or derive:

- explicit outcome marker;
- final verification status;
- completed, partial, failed, abandoned, or unknown;
- session end observed;
- user correction count when reliably detectable;
- retry count;
- time to first meaningful edit;
- time to passing targeted verification;
- time to passing final verification;
- tokens per completed task.

Never treat `Stop` alone as success.

### Task categories

Initial categories:

- documentation;
- UI;
- bug fix;
- feature;
- refactor;
- build/tooling;
- dependency/configuration;
- investigation;
- unknown.

### Task scale

Derive explainable scope dimensions:

- files and directories touched;
- insertions/deletions when Git data is available;
- localized versus cross-cutting;
- code, configuration, documentation, or generated-file mix;
- test surface affected.

Allow explicit correction through a marker or session-detail action. Preserve inferred and corrected values separately.

## Analysis engine

### Cohort model

Introduce a normalized filter object shared by CLI and portal analysis:

```json
{
  "time": { "range_ms": 604800000, "end": null },
  "harnesses": ["claude"],
  "models": ["sonnet"],
  "repos": ["roborepo"],
  "packages": [{ "id": "test-harness", "state": "active" }],
  "skills": [{ "id": "test-harness", "state": "active" }],
  "operations": ["test"],
  "phases": ["debugging"],
  "outcomes": ["successful", "partial"]
}
```

All panels must receive the same globally filtered event set. Analysis-specific refinements may produce a secondary result without changing unrelated page panels.

### Marker-relative comparisons

Replace the current midpoint-only regression as the preferred regression path.

For a selected change marker:

1. Resolve its timestamp and configuration snapshot.
2. Select eligible sessions before and after it.
3. Exclude sessions spanning the marker unless the analysis explicitly supports within-session phase comparison.
4. Match or stratify by harness, model, repository, task category, task scale, and outcome availability.
5. Use equal-duration or equal-session-count windows, selected explicitly and shown to the user.
6. Report cohort sizes and excluded-session reasons.
7. Retain midpoint regression as a labeled exploratory fallback when no marker is selected.

### Metrics registry

Create a declarative registry so alerts, experiments, CLI reports, and the portal share names, units, formatting, eligibility, and directionality.

Initial metric groups:

- Tokens: total, delta, tool-result context estimate, tokens per completed task.
- Time: session duration, captured tool duration, operation duration, time to first edit, time to verification.
- Calls: total tools, MCP calls, semantic-operation counts, calls per phase.
- Testing: full/targeted counts and ratios, redundant reruns, repeated failure signatures.
- Outcome: completion and verification rates, retries, corrections.
- Reliability: capture coverage, paired-call rate, known-model rate, known-snapshot rate.

Do not let UI components independently define formulas.

### Confidence and data quality

Every comparative finding returns:

- observation;
- evidence rows/aggregates;
- cohort definitions;
- sample sizes;
- effect size;
- baseline;
- data-quality issues;
- confidence label;
- interpretation labeled as inference;
- next action;
- a ready-to-apply Analysis filter state.

Initial labels:

- strong signal;
- emerging pattern;
- insufficient evidence;
- data-quality warning.

Suppress or downgrade conclusions when:

- cohorts are below their minimum size;
- model, snapshot, or outcome coverage is too low;
- capture coverage differs materially across cohorts;
- unmatched tool calls distort duration;
- one session dominates the result;
- task mix differs substantially;
- classifier confidence is low;
- an experiment is still collecting samples.

Use robust summaries such as median, percentile, rate, and trimmed mean where appropriate. Do not rely only on arithmetic means for heavy-tailed token or duration distributions.

### Actionable finding contract

Each insight must contain four user-visible layers:

1. **Observation:** measurable fact.
2. **Evidence:** values, cohorts, sample size, and effect size.
3. **Interpretation:** plausible explanation explicitly labeled as inference.
4. **Next action:** one concrete investigation, configuration change, or experiment.

Example:

> **Observation:** Full-suite runs increased from 1.3 to 3.8 per debugging phase after “Test-harness guidance v2.”  
> **Evidence:** 18 comparable build/tooling sessions using the same harness/model; emerging pattern.  
> **Interpretation:** The new wording may permit full-suite reruns during debugging.  
> **Next action:** Explicitly prohibit full-suite debugging loops and evaluate the next 10 eligible sessions.

No insight may say a skill or package “caused” the change unless the metric is a direct invocation property.

## RoboRepo package and skill correlation

### RoboRepo package identity

Add a separate concept from the existing MCP package rollup:

- `mcp_package_cost`: directly measured result context from an MCP server;
- `roborepo_package_exposure`: sessions whose effective snapshot included a RoboRepo package;
- `skill_exposure`: sessions whose snapshot included a skill;
- `observed_skill_use`: only when a harness or explicit loader emits a reliable event.

Rename portal labels and response fields carefully so old exports remain readable. A compatibility alias may be retained for one schema cycle.

### Skill-use limitations

Claude, Codex, and future harnesses may expose different skill invocation signals. Implement an adapter contract:

- `available` and `active` derive from the snapshot;
- `observed` derives only from an explicit harness event, tool invocation, or RoboRepo skill wrapper;
- reading a skill file may be supporting evidence but must not automatically be treated as proof the instructions influenced the response;
- unknown remains valid.

### Exposure comparisons

Permit statements such as:

> Sessions exposed to `test-harness@<hash-B>` averaged 1.4 full-suite debugging runs, compared with 3.8 for `<hash-A>`, after matching repository, model, harness, and task category.

Display the snapshot hashes, time windows, sample sizes, and unmatched dimensions. This is still correlation.

## Package telemetry policies

Allow an optional `telemetry.policies` section in package configuration:

```json
{
  "telemetry": {
    "policies": [
      {
        "metric": "test.full_suite_calls_per_debug_phase",
        "operator": "<=",
        "value": 1,
        "minimum_samples": 3,
        "severity": "warning"
      }
    ]
  }
}
```

Requirements:

- Validate metric IDs and operators when loading package definitions.
- Policies are attached to package exposure, not assumed global.
- Findings state whether the value violates an explicit policy or merely differs statistically.
- Policy findings link to filtered supporting sessions.
- Policies do not block commands in this implementation.

The `test-harness` package is the first candidate, but the policy mechanism must remain generic.

## Portal design

### Global filter bar

Extend the current server-side filter state with:

- model;
- repository;
- saved experiment/cohort.

Use compact buttons/selectors and show active-filter count. Provide “clear” and a readable cohort summary. Keep time panning behavior intact.

Filters must serialize into the URL so a filtered analysis can be copied, bookmarked, and restored after reload.

### Timeline markers

Overlay marker lines on the existing canvas timeline:

- distinct style by marker type;
- hover shows title, timestamp, SHA, packages/skills, and expected metric;
- click opens marker detail;
- overlapping markers cluster rather than becoming unreadable;
- selected experiment shades its active period;
- marker rendering respects the global time window.

Do not mutate marker positions client-side. The server supplies window-scoped markers.

### Action-item panel

Upgrade each deterministic insight row to show:

- severity;
- confidence/data-quality label;
- concise observation;
- evidence summary;
- next action;
- “open analysis” action;
- optional “mark change” or “start experiment” action when relevant.

The deeper-read feature remains secondary and receives only structured, deterministic summaries.

### Testing-efficiency panel

Add a first-class panel under warnings and abnormalities:

- testing share of captured tool time;
- full versus targeted runs;
- full-suite runs by phase;
- redundant reruns;
- unchanged failure-signature reruns;
- slowest sessions;
- direct links to session/transcript context.

The panel should lead with the most actionable abnormality rather than a comprehensive table.

### Analysis explorer

Add a collapsed-by-default or drawer-based explorer accessible from every insight and detail panel.

Structure:

1. Cohort A filters.
2. Cohort B or marker-relative comparison.
3. Metric selection.
4. Summary comparison.
5. Confidence/data-quality explanation.
6. Contributing sessions and tool calls.

Use exact filter chips for selected dimensions. Avoid placing every possible selector in the global header.

The explorer should answer:

- what was compared;
- what was excluded;
- whether the cohorts are comparable;
- which sessions dominate the result;
- where the user can inspect supporting events.

### Session detail

Extend the current session modal with:

- model history;
- configuration snapshot;
- active packages/skills;
- explicit versus inferred task category and outcome;
- phase timeline;
- semantic operation totals;
- testing-efficiency summary;
- markers inside or adjacent to the session;
- data-quality flags.

Retain the current “surface chat context,” copy-prompt, and transcript-open behavior.

### Framework and file organization

Preserve the established frameworkless architecture:

- `state.js`: pure formatting, filter serialization, and small selectors;
- `api.js`: requests only;
- `templates.js`: template cloning and slot filling;
- `renders.js`: panel orchestration;
- `chart.js`: canvas interaction and marker rendering;
- `panels.js` and `modals.js`: dialog controllers and modal data shaping;
- `app.js`: event wiring, shared view state, polling, and module orchestration.

Create focused modules when logic does not fit these responsibilities, for example `analysis-explorer.js`. Do not return to a monolithic `app.js`, add a build system, or introduce React/Vite for this feature.

## API changes

### `/api/data`

Extend query parsing to accept normalized multi-value filters. Retain existing `range`, `end`, and `harness` compatibility.

Add response fields including:

- available models, repositories, packages, skills, operations, phases, outcomes, and experiments;
- window-scoped markers;
- testing-efficiency summary;
- package/skill exposure rollups;
- data-quality summary;
- enriched actionable insights.

Ensure `version` changes when relevant markers, experiments, snapshots, or filters change—not only when spool capture count changes.

### Analysis endpoint

Add a dedicated endpoint for high-dimensional comparisons rather than inflating `/api/data` for every explorer interaction:

```text
POST /api/telemetry/analysis
```

Body:

```json
{
  "cohort_a": {},
  "cohort_b": {},
  "metric": "test.full_suite_calls_per_debug_phase",
  "marker_id": null
}
```

The server remains loopback-only. Validate request size, known metric IDs, enum values, and filter cardinality. Return structured evidence and never raw transcript content.

### Marker endpoints

Add local endpoints for portal-created markers:

- `POST /api/telemetry/markers`;
- `GET /api/telemetry/markers` through filtered data or a dedicated route;
- `POST /api/telemetry/markers/:id/supersede` if the simple route layer can support it cleanly.

All mutations use the same validation and persistence functions as the CLI.

### Experiment endpoints

Add create/end/status operations backed by shared CLI-domain functions. Do not duplicate experiment rules in the browser.

## CLI report changes

The terminal report must remain useful and numerically consistent with the portal.

Add sections for:

- active cohort summary;
- data quality;
- recent markers;
- testing efficiency;
- marker-relative regressions;
- outcome-normalized model/package comparisons;
- experiment readiness/results.

Retain current insight-first ordering, tool/group cost, spike analysis, loops, sessions, and supporting breakdowns.

Add filter flags only when they share the normalized cohort implementation. Do not create a second CLI-only filtering system.

## Implementation phases

### Phase 0 — Grounding and characterization

1. Use jcodemunch to map the current telemetry and configuration flows.
2. Capture representative schema-v2 fixtures for Claude and Codex.
3. Characterize current analyzer outputs so compatibility tests can detect accidental changes.
4. Document hook-field differences, especially tool-use IDs, commands, exit status, model reporting, and transcript timing.
5. Identify which effective configuration data is already available through `readConfigSnapshot` and which must be added.

Exit criteria:

- current behavior is covered by fixtures;
- schema differences between harnesses are documented;
- no implementation assumption depends on one harness only.

### Phase 1 — Domain schemas and persistence

1. Add schema validators and normalizers for captures, markers, snapshots, and experiments.
2. Add stable IDs and append-only persistence helpers.
3. Implement content-addressed configuration snapshots.
4. Update backup/export/purge.
5. Keep schema-v2 read compatibility.

Exit criteria:

- existing spools still analyze;
- new records round-trip;
- snapshots deduplicate;
- malformed records degrade safely and produce a data-quality count.

### Phase 2 — CLI markers and experiments

1. Implement shared marker domain functions.
2. Add `telemetry mark`.
3. Add experiment start/end/status.
4. Update command manifest, help, and menus.
5. Add the optional marker skill backed by the CLI.

Exit criteria:

- a user can mark the test-harness change from any Git checkout;
- automatic metadata is correct;
- invalid input is rejected;
- markers are visible in export and backup.

### Phase 3 — Capture v3 and operation classification

1. Add capture/call IDs.
2. Replace session-only duration pairing with call-aware pairing.
3. Add configuration snapshot references.
4. Add pure semantic command classification.
5. Capture exit/failure signatures where harness data permits.
6. Record classification version and unknowns.

Exit criteria:

- full and targeted RoboRepo test commands classify correctly;
- ambiguous commands remain unknown;
- privacy tests confirm raw commands/results are not persisted;
- concurrent call fixtures do not overwrite duration cursors.

### Phase 4 — Phases, intervening work, tasks, and outcomes

1. Implement explicit phase markers.
2. Add explainable phase inference.
3. Track edit/diff/failure-signature transitions.
4. Implement task category and scale inference.
5. Implement outcome markers and conservative inference.
6. Surface coverage/confidence for each derived dimension.

Exit criteria:

- the screenshot scenario is represented as full-suite runs during debugging;
- redundant runs can be distinguished from runs after meaningful changes;
- unknown outcome/phase remains valid.

### Phase 5 — Metrics, cohorts, and findings

1. Add the metric registry.
2. Add normalized cohort filtering.
3. Preserve current spike/tool/group analysis through the new filter pipeline.
4. Add testing metrics.
5. Add marker-relative comparisons.
6. Add robust summaries, exclusion reasons, data-quality gates, and finding contracts.
7. Add package telemetry policy evaluation.

Exit criteria:

- CLI and portal compute identical metrics;
- every comparative finding exposes cohorts and sample size;
- insufficient data produces no false conclusion;
- correlations use exposure wording.

### Phase 6 — Portal global filters and markers

1. Extend URL-backed global filter state.
2. Render model/repository/experiment filters.
3. Add marker overlays and detail modals to the existing chart.
4. Update the data version token and polling behavior.
5. Preserve canvas pan, mode toggles, session click-through, resize, and theme behavior.

Exit criteria:

- all existing panels reflect the same global cohort;
- bookmarked filters restore correctly;
- marker display remains usable when clustered.

### Phase 7 — Action items, testing panel, and explorer

1. Upgrade insight rows to the actionable finding contract.
2. Add testing-efficiency rendering.
3. Build the Analysis explorer.
4. Add filtered supporting session/tool-call drill-down.
5. Extend session detail.
6. Keep deeper-read synthesis fact-bound.

Exit criteria:

- each alert answers what happened, why it matters, evidence quality, and next action;
- “open analysis” reproduces the alert's exact cohort and metric;
- no unsupported causal language appears.

### Phase 8 — Documentation, migration, and hardening

1. Update telemetry reference and lifecycle documentation.
2. Document marker and experiment workflows.
3. Document attribution limitations and privacy behavior.
4. Add schema/version migration notes.
5. Run performance checks against capped large spools.
6. Review all new code paths with jcodemunch changed-symbol/reference queries.

Exit criteria:

- a new user can create a marker, run an experiment, and interpret the result;
- existing installs require no destructive migration;
- portal response time remains acceptable on maximum supported spool sizes.

## Verification strategy

Follow the repository's test-harness rule: use the smallest affected checks during development and reserve the full suite for phase boundaries/final verification.

### Unit tests

Cover pure modules with fixtures:

- capture/marker/snapshot/experiment normalization;
- content-addressed snapshot identity;
- CLI parsing and validation;
- command classification across supported runners;
- ambiguous classification;
- phase inference;
- intervening-edit and failure-signature logic;
- metric registry formulas;
- cohort filters;
- marker-relative windows;
- confidence/data-quality gates;
- package policy evaluation;
- causal-language safeguards.

### Integration tests

Cover:

- Claude and Codex hook payloads;
- call-aware duration pairing;
- schema-v2 plus schema-v3 mixed spools;
- marker CLI persistence;
- experiment lifecycle;
- backup/export/purge completeness;
- telemetry-only installs with partial configuration visibility;
- API validation and consistent filtered responses;
- data version changes from marker-only writes.

### Portal tests

Use real-browser Playwright checks against `roborepo serve` after each structural UI phase:

- existing telemetry page still loads;
- global filters scope every panel;
- URL state round-trips;
- markers render, cluster, and open;
- chart drag/hover/click behavior remains intact;
- testing findings open matching evidence;
- Analysis explorer reproduces an alert;
- dialog keyboard/backdrop behavior remains correct;
- dynamic content is rendered safely with `textContent`/templates;
- theme and narrow-layout behavior remain correct.

### Scenario fixture: full-suite debugging loop

Create a deterministic fixture containing:

1. a build/tooling task;
2. a full test-suite failure;
3. four full-suite calls during debugging;
4. three calls without an intervening edit or changed failure signature;
5. one targeted reproduction;
6. a final successful full-suite run;
7. a test-harness change marker between comparison cohorts.

Expected outputs:

- testing share of tool time;
- full-suite calls per debugging phase;
- redundant rerun count;
- unchanged-failure count;
- finalization run separated from wasteful debugging runs;
- marker-relative comparison;
- correlation-only wording for the test-harness skill revision;
- concrete next action.

### Final verification

At completion:

1. Run all targeted unit and integration checks.
2. Run real-browser portal verification.
3. Run the repository's full verification suite once at the stopping point.
4. Confirm documentation and command manifests match behavior.
5. Use jcodemunch to review changed symbols and affected references.
6. Verify exact changed files and report commands with pass/fail/blocked status.

## Performance constraints

- Keep the hot capture import graph small.
- Do not rescan or serialize the entire effective configuration on every tool call.
- Snapshot once at session start and on detected configuration change.
- Cache normalized repository command knowledge by repository/config fingerprint.
- Keep analysis pure where practical and avoid repeated parsing inside individual panel computations.
- Bound comparison cardinality and API request size.
- Preserve spool caps and add retention rules for orphaned snapshots only after proving they are unreferenced by captures, markers, or experiments.

## Privacy and security

- Continue binding the portal to loopback only.
- Do not store full prompts, shell commands, tool results, transcripts, or absolute paths by default.
- Hash commands, failure signatures, paths, remotes, and configuration content.
- Store only bounded previews already permitted by current behavior.
- Clearly distinguish estimates from provider token accounting.
- Expose deletion/export behavior for every new record type.
- Validate all portal mutation inputs server-side.
- Never shell-interpolate marker titles, tags, or filter values.
- Avoid unbounded cardinality from raw command strings, paths, or arbitrary model output.

## Documentation deliverables

Update or add:

- telemetry service reference;
- CLI reference and command manifest;
- event-marker guide;
- experiment guide;
- telemetry schema/version reference;
- attribution and confidence guide;
- privacy/data-retention documentation;
- package telemetry-policy documentation;
- portal filter and Analysis explorer help text.

Documentation must explicitly state:

- tool-result context estimates are based on result size;
- total session tokens are transcript/provider counters when available;
- package/skill exposure comparisons are correlations;
- missing data remains unknown;
- midpoint regression is exploratory, while marker-relative comparison is intentional;
- a higher-cost model must be evaluated against successful outcomes, not tokens alone.

## Out of scope

- Automatic causal claims about rules, skills, packages, or models.
- Allocating assistant-output tokens among individual prompt fragments.
- Blocking tool calls based on telemetry policies.
- Full raw-command or transcript retention.
- Opaque machine-learning anomaly detection.
- Cloud synchronization or multi-user telemetry aggregation.
- Replacing the local JSONL architecture with an external database.
- Introducing React, Vite, or a portal build step.

## Acceptance criteria

The work is complete when:

1. A user can create a timestamped, metadata-rich marker through the CLI.
2. Markers appear on the telemetry timeline and can drive before/after comparisons.
3. Sessions reference deduplicated effective-configuration snapshots.
4. Model, RoboRepo package exposure, skill exposure, tools, semantic operations, phases, task categories, and outcomes are usable analysis dimensions when known.
5. Full versus targeted test activity is classified conservatively.
6. RoboRepo detects repeated full-suite debugging runs and considers intervening edits/failure changes.
7. Token, time, call, testing, outcome, and reliability metrics share one registry.
8. Global filters remain compact while the Analysis explorer supports deeper refinement.
9. Every alert exposes evidence, cohort, sample size, confidence/data-quality, and a concrete next action.
10. Package/skill findings use correlation language unless invocation is directly observed.
11. CLI and portal results agree for the same cohort.
12. Existing schema-v2 telemetry remains readable.
13. Backup, export, and purge cover all new data.
14. The current frameworkless, dependency-free, local-only portal architecture is preserved.
15. Implementation and final impact review use jcodemunch as required.

## Recommended first real experiment

After implementation, use the screenshot scenario as the first production validation:

1. Record or reconstruct a baseline cohort using the current `test-harness` skill revision.
2. Add the explicit rule that a failed full-suite run must be followed by a targeted reproduction and that another full suite should wait until a stopping point.
3. Create a `change` marker attached to `test-harness` with primary metric `test.full_suite_calls_per_debug_phase` and guardrails for completion and verification success.
4. Collect at least the configured minimum number of comparable build/tooling, refactor, or bug-fix sessions.
5. Compare the same repository/harness/model/task categories where possible.
6. Report whether full-suite debugging runs fell, whether completion remained stable, and what data limitations remain.

This validates the entire chain: configuration snapshot, event marker, semantic test classification, phase detection, outcome guardrails, cohort comparison, actionable alert, and drill-down evidence.
