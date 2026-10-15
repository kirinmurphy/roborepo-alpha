# Telemetry Internals

How telemetry is built, for people changing it. User-facing behavior is in
[Telemetry](../user/reference/telemetry.md).

## Modules

| Module | Owns |
| --- | --- |
| `scripts/cli/telemetry-capture.mjs` | The hot hook path, `roborepo telemetry capture`. A minimal-import module so every hook invocation does not pay to load the portal/config/analysis dependency graph — a `node` cold-start just to append one JSONL line. |
| `scripts/cli/telemetry-metrics.mjs` | The metrics registry: every formula, unit, and direction. UI components never define their own formulas. |
| `scripts/cli/telemetry-cohort.mjs` | The normalized cohort filter shared by the CLI and portal. |
| `scripts/cli/telemetry-compare.mjs` | Marker-relative comparison. |
| `scripts/cli/telemetry-analyze.mjs` | Analysis, including the exploratory midpoint `regression()`. |
| `scripts/cli/telemetry-policy.mjs` | Package telemetry policy validation and evaluation. |
| `scripts/cli/telemetry-markers.mjs` | `createMarker()`, shared by the CLI and the portal's marker dialog. |
| `scripts/cli/telemetry-task-infer.mjs` | An analysis-time task inference path with no live caller; outcome categories are always explicit. |

## Analytics Correctness

The analysis is one pipeline: `analyzeTelemetry()` normalizes events into observations, keeps one
representative row per operation (`canonicalFlowRows`), derives spikes, loops, read warnings and
tool costs from those rows, then always builds the conditions report from the same findings. There
is no second "legacy" rollup. Sessions are identified by `[harness, session_id]` everywhere; a bare
`session_id` is never a key, because providers reuse ids across harnesses.

Each rule below is an invariant a change must not break, with the code that holds it and the check
that fails if it breaks. When adding analytics, add the rule's check first.

| Invariant | Held by | Enforced by |
| --- | --- | --- |
| Correlation only, never causal wording | `buildFinding`, `comparisonPresentation`, `changePresentation` | `telemetry-compare-check`, `telemetry-conditions-presentation-check` |
| Unknown condition data is not absence; known presence is compared only with known absence | `aggregateCondition` cohorts; `unknown_condition` on change comparisons | `telemetry-conditions-matrix-check`, `telemetry-audit-tier1-check` |
| Thin evidence never yields a percentage or a direction (minimum cohort, minimum events, 20% display band) | `CONDITIONS_POLICY` in `telemetry-observations.mjs`; both presentation functions | matrix check, presentation check (equal, near-equal and below-floor cases) |
| Mirrored rows never double-count | `canonicalFlowRows` | `telemetry-conditions-check` (duplicate flows) |
| One session id under two harnesses stays two sessions; loops never cross harnesses | `sessionKeyOf` in `telemetry-analyze.mjs` | `telemetry-conditions-check` (collision, alternating-harness loop) |
| Boundary sessions are excluded, not assigned; one rule for every marker | `splitObservationBoundary`, which `splitCohortsByMarker` delegates to | `telemetry-boundaries-check`, `telemetry-audit-tier1-check` (equivalence) |
| An unknown-scope marker is "can't compare fairly", not "too little data" | `compareObservationBoundary`, `compareAcrossMarker` | `telemetry-audit-tier1-check` |
| Ledger ties break on persisted order | ledger sort in `telemetry-conditions.mjs`, `ambientChanges` | `telemetry-audit-tier1-check` |
| A supersede names a real, active change marker | `assertSupersedable` in `telemetry-markers.mjs` | `telemetry-audit-tier1-check` |
| Marker corrections keep packages, skills and tags, and never move the boundary silently | `conditions-change-form.js` | portal UI spec "mark change records backdated scope" |
| Findings that cannot be tied to a session are counted, not silently dropped | `data_quality.findings_lost_to_fallback` | `telemetry-audit-tier1-check` |
| Shell results group by the command behind them, never by shell tool name; only shell tools are classified | `linkShellResultCategories` in `telemetry-analyze.mjs`; `SHELL_TOOL_NAMES`/`shellOperation` in `telemetry-classify.mjs` | `telemetry-shell-groups-check`, `telemetry-classify-check` |
| `edit_since_last_test` compares with the previous test run, not the previous capture; a run's Pre and Post agree | `editSinceLastTestRun` in `telemetry-capture.mjs` | `telemetry-phase4-integration-check` (edit between passing runs, Codex `apply_patch`, shell edit on a clean tree) |
| The demo must not confound the intervention with repo or model | `telemetry-conditions-demo.mjs` | `telemetry-conditions-presentation-check` |

`telemetry-conditions-matrix-check.mjs` enumerates 2,850 deterministic scenarios. It is exhaustive
for these small input spaces, not for all telemetry records or browser states:

| Cases | Space |
| --- | --- |
| 2,592 | Condition/event cases: all 6³ three-observation states, all six orderings, with and without duplicated observations |
| 162 | Session token validity (valid, missing, invalid) across all small-input orderings |
| 35 | Invalid token fields |
| 24 | Mirrored-flow and cross-harness permutations |
| 16 | Snapshot evaluability, including missing snapshots and v2 unavailable evidence |
| 10 | Rate, sample, and event-floor golden cases |
| 10 | Marker boundaries, including sequence ties and unrelated sequence domains |
| 1 | `scripts/test/fixtures/telemetry-conditions-documentation.mjs`: independently specified cohort counts and rates (the 3/12 vs 9/12 example in the user guide) |

Known limits, so they are not mistaken for bugs:

- The waste card counts each turn once (`telemetry-waste.mjs`): loops, redundant reads, spike excess
  and testing each nominate turns with a token amount, and the largest nomination wins, so category
  totals add up to the headline. The families still use different measurement bases (hook deltas vs.
  characters/4 for reads), and over-testing counts only full-suite reruns with no edit since the previous test run.
- Token tables skip captures with no token data; the session count includes them.
- A shell result is linked to its command by session order, because a PreToolUse row carries the
  previous call's result. Parallel calls can misattribute, and a Codex `exec` that ran several kinds
  of command groups as `shell-mixed`. Raw commands are never stored, so operations recorded by
  classifier v1 cannot be reclassified: their reads stay `other`, and reads of test files stay `test`.
- `edit_since_last_test` is stored at capture time. Rows captured before it compared with the previous
  test run nearly always read `false` after an edit, so historical over-testing waste is overstated
  for both harnesses; only new captures are accurate.
- Every comparison is an association. Task mix, model and repository can differ between cohorts.
- The bundled demo is synthetic and deterministic; it exercises the pipeline, not real usage.

### Gaps in confidence

Every check above asserts behavior on hand-built fixtures. None recomputes a headline number
independently from the raw spool, so a bug that is wrong the same way in the fixture and the code
would pass. Closing that gap means an oracle test: recompute session counts, affected-session
rates and before/after cohorts naively from raw events and require the report to match.

## Configuration Snapshots

The snapshot builder is dynamic-imported only on `SessionStart`, to keep the hot capture path's
import graph small. `readConfigSnapshot()` has documented gaps (no full hook command strings, no MCP
server registration detail, no parsed Codex `config.toml`), recorded as `unavailable` dimensions.

## Portal Page

The `/tokens` page (`portal/tokens/`) is a frameworkless, dependency-free page polling `/api/data`
every 5 seconds. See `docs/internal/portal-architecture.md` for the shared portal architecture
(loopback bind, mutation-token contract, route dispatch). Telemetry-specific pieces:

- **Session detail** — model history, the session's configuration snapshot (id +
  packages/skills), a phase timeline, semantic operation totals, its explicit outcome/task category
  (marked `source: "explicit"`), markers within a 15-minute
  window of the session, and data-quality flags — alongside the "surface chat context" /
  copy-prompt / transcript-open actions.
- **Marker creation** — the conditions section's "+ Mark a change" dialog posts through
  the same validation/persistence path as the CLI (`createMarker` in `telemetry-markers.mjs`); no
  browser-side duplication of marker rules.

## API

- `GET /api/data?range=&end=&harness=&model=&repo=&marker_id=` — the full analysis report, cohort-
  scoped. Response includes `available_harnesses`/`available_models`/`available_repos`/
  `available_metrics`, window-scoped `markers`, `experiments`, `testing_efficiency`, `cohort`
  (present when a model/repo filter is active), and `marker_comparison` (present when `marker_id`
  resolves).
- `GET /api/session?id=&harness=&finding=&repo=` — bridges a flagged event to its transcript, plus
  `spool_context` (model history, config snapshot, phase timeline, operation totals, outcome, nearby
  markers, data-quality flags) derived from the spool alone, present even when the transcript itself
  is not found on disk.
- `GET /api/insights-llm` — on-demand LLM synthesis of deterministic facts (may take seconds).
- `GET/POST /api/telemetry/markers` — list or create a marker. POST reuses `createMarker()`.
- `GET/POST /api/telemetry/experiments`, `POST /api/telemetry/experiments/:id/end` — list, start, or
  end an experiment. Reuse `startExperiment()`/`endExperiment()`.
- `POST /api/telemetry/analysis` — `{ metric, marker_id }` for a marker-relative comparison, or
  `{ metric, cohort_a, cohort_b }` for a direct two-cohort comparison (no before/after language — no
  shared timestamp to split sessions around). Validates the metric id against the registry and
  returns `400` for an unknown one along with the full known-metric list.
- `GET /api/telemetry/guide` — server-rendered `docs/user/guides/telemetry.md`, backing the page's
  "view docs" popup (`portal/shared/doc-guide-modal.js`) so the popup and the on-disk guide are
  the same content, never a second copy. `renderMarkdown()` (`scripts/cli/markdown-render.mjs`)
  gives every heading a stable slug `id`; a panel's info icon names its heading, and the popup
  shows only that section. Guide headings mirror the page's section titles, and
  `telemetry-documentation.spec.mjs` fails when an icon names a heading the guide lacks; fenced ` ```mermaid ` blocks render as diagrams through the locally vendored mermaid
  runtime (`portal/shared/markdown-mermaid.js`), loaded lazily on first use.

All mutating routes are POST-only and use the portal's standard loopback-origin + mutation-token
guard (see `docs/internal/portal-architecture.md`).

See [Portal Architecture](portal-architecture.md) for the shared server, route, and mutation-token
architecture.
