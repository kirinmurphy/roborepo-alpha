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
| `scripts/cli/telemetry-analyze.mjs` | Public analysis entry point: cohort filtering, normalization, conditions, and report version. |
| `scripts/cli/telemetry-analysis/` | Production report assembly (`rows.mjs`), capture indexing, sessions, costs, findings, regression, data-quality warnings, and testing metrics in focused modules. |
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
| One session id under two harnesses stays two sessions; loops never cross harnesses | `sessionKeyOf` in `telemetry-analysis/captures.mjs` | `telemetry-conditions-check` (collision, alternating-harness loop) |
| Midpoint per-call regression never divides equal timestamps; without a distinct time boundary it is unavailable | `regression` in `telemetry-analysis/regression.mjs` | `telemetry-oracle-check` (fixed tie regressions) |
| Boundary sessions are excluded, not assigned; one rule for every marker | `splitObservationBoundary`, which `splitCohortsByMarker` delegates to | `telemetry-boundaries-check`, `telemetry-audit-tier1-check` (equivalence) |
| An unknown-scope marker is "can't compare fairly", not "too little data" | `compareObservationBoundary`, `compareAcrossMarker` | `telemetry-audit-tier1-check` |
| Ledger ties break on persisted order | ledger sort in `telemetry-conditions.mjs`, `ambientChanges` | `telemetry-audit-tier1-check` |
| A supersede names a real, active change marker | `assertSupersedable` in `telemetry-markers.mjs` | `telemetry-audit-tier1-check` |
| Marker corrections keep packages, skills and tags, and never move the boundary silently | `conditions-change-form.js` | portal UI spec "mark change records backdated scope" |
| Findings that cannot be tied to a session are counted, not silently dropped | `data_quality.findings_lost_to_fallback` | `telemetry-audit-tier1-check` |
| The demo must not confound the intervention with repo or model | `telemetry-conditions-demo.mjs` | `telemetry-conditions-presentation-check` |

Known limits, so they are not mistaken for bugs:

- The waste card counts each turn once (`telemetry-waste.mjs`): loops, redundant reads, spike excess
  and testing each nominate turns with a token amount, and the largest nomination wins, so category
  totals add up to the headline. The families still use different measurement bases (hook deltas vs.
  characters/4 for reads), and over-testing counts only full-suite reruns with no edit since the previous test run.
- Token tables skip captures with no token data; the session count includes them.
- Every comparison is an association. Task mix, model and repository can differ between cohorts.
- The bundled demo is synthetic and deterministic; it exercises the pipeline, not real usage.

### Independent oracle

The oracle protects against arithmetic errors by computing covered values again from raw events.
Its five core modules import only Node built-ins and each other. They share no production analysis
or presentation helpers, fixtures, logging, or filesystem reads.

| Module under `scripts/cli/` | Owns |
| --- | --- |
| `telemetry-oracle-observations.mjs` | Raw acceptance, operation deduplication, harness-scoped sessions, and independent repository identity resolution. |
| `telemetry-oracle-findings.mjs` | Spike, loop, and read-warning detection. |
| `telemetry-oracle-cohorts.mjs` | Condition rates, marker boundaries and exclusions, and locally encoded evidence policy. |
| `telemetry-oracle-regression.mjs` | Per-call regression at distinct timestamp boundaries. |
| `telemetry-oracle-run.mjs` | Independent calculation and evidence coverage inspection. |
| `telemetry-oracle-compare.mjs` | Black-box production invocation, covered projections, and sanitized comparison output. This boundary alone knows both implementations. |

The CI runner, `scripts/test/telemetry-oracle-check.mjs`, owns the bundled demo, fixed regressions,
seeded spools, and failure shrinking. It uses the independent core and the same comparison
projections as the runtime boundary. Synthetic failures retain detailed values and replayable
JSONL; live comparisons return only aggregate counts, fixed coverage categories, and disagreeing
field names. Exceptions yield a fixed error category rather than the original message. In GitHub
Actions, the runner also appends a concise pass/fail result and evidence totals to the job summary;
the exit code and detailed failure log remain the build gate and replay source.

```mermaid
flowchart LR
    raw[Raw events and metadata] -->|supply identical evidence| production[Production analyzer]
    raw -->|supply identical evidence| oracle[Independent oracle core]
    production -->|return covered values| compare[Comparison boundary]
    oracle -->|return expected values| compare
    compare -->|report sanitized agreement and coverage| result[Runtime comparison result]
    compare -->|expose synthetic projections to CI| runner[CI fixture runner]
    runner -->|reject disagreement and shrink failures| gate[Build gate and replay evidence]
```

An oracle pass establishes agreement on harness-scoped session and token-session counts, operation
deduplication, affected-session condition rates, marker cohorts and exclusions, evidence gating,
per-call regression, and harness-local loops. Unrelated dashboard totals, insight prose, marker
persistence, approximate waste attribution, and browser rendering retain their focused checks.

`compareTelemetryOracle()` reports one of four comparison statuses:

| Status | Meaning |
| --- | --- |
| `passed` | Covered values agree and supplied evidence has no coverage gaps. |
| `partial` | Covered values agree, but evidence is incomplete or unresolved. |
| `failed` | Comparable input produces disagreement on covered fields, even if coverage is incomplete. |
| `unavailable` | Input is empty or unsafe to compare, or a calculation throws. |

The one-shot `telemetry-oracle-worker.mjs` reads raw spool, marker, snapshot, and registry evidence
once, calls the comparison boundary, posts one sanitized result, and exits. It accepts explicit
store paths and a caller-supplied `sha256:` evidence signature. The controller captures
that signature before starting the worker and re-reads it when the worker exits. Parsed evidence
goes to the boundary with non-enumerable spool provenance; malformed JSON contributes
reader-skipped counts. Read failures produce `unavailable` with `evidence_read_error`.

`telemetry-schemas/oracle-health-schema.mjs` projects schema version `1`, aggregate counts,
coverage, checked time, duration, signature, fixed summaries, and allowlisted diagnostic categories.
The pure transitions in `telemetry-oracle-observer.mjs` require the current signature when accepting
a result. A mismatch yields `stale`; a missing signature yields `unavailable`. Stale results retain
their checked metadata and cannot become current again without a new accepted comparison.

The portal starts the observer after listening and caches only its latest sanitized result in
memory. Restarting the process starts with `checking`. `GET /api/telemetry/oracle-health`
re-projects that cache through the versioned schema and performs no analysis or evidence read; a
cached value that fails validation is served as `unavailable` with `invalid_cached_health`, distinct
from a worker's `invalid_worker_result`. With live telemetry, the Tokens page polls the endpoint
every five seconds while visible. In the demo and telemetry-off states it polls only until the first
settled status, because no live evidence can change. Endpoint failures change only the badge to
`Unavailable` and do not block or re-render the report.

### Observer scheduling and freshness

```mermaid
flowchart TD
    stores[Spool, markers, snapshots, repository registry] -->|supply file metadata| signature[Complete evidence signature]
    signature -->|schedule latest changed evidence| observer[Observer controller]
    observer -->|start one isolated run| worker[One-shot comparison worker]
    worker -->|return sanitized result and exit| fresh{Signature still current?}
    signature -->|re-read after worker exit| fresh
    fresh -->|accept current result| cache[In-memory health cache]
    fresh -->|mark stale and schedule latest evidence| observer
    cache -->|project cached schema| endpoint[Oracle health endpoint]
    endpoint -->|poll every five seconds| badge[Tokens badge and details dialog]
```

| Control | Behavior |
| --- | --- |
| Startup | Begin one run from the deferred portal-listening callback. |
| Change detection | Poll every two seconds; debounce for 12 seconds of quiet, with a 60-second maximum wait under continuous changes. |
| Signature | Hash sorted filenames plus each file's device, inode, size, nanosecond modification time, and change time. Read no evidence content on this path. |
| Covered stores | Spool JSONL files, the marker file, snapshot JSON files, and the raw repository registry. The production report cache also includes experiments. |
| Unreadable evidence | Return `unavailable`; retry when signatures can be read. A disappearing directory member is an unstable read, not missing evidence to ignore. |
| Concurrency | Retain one active worker until its exit event; coalesce changes to the newest signature. A message or termination request does not release the worker slot. |
| Completion | Re-read the signature after exit. Any observed change during the run invalidates it, even if the signature later reverts. |
| Failure | Terminate after 30 seconds; startup failures, crashes, invalid messages, and timeouts are `unavailable`. Retry unavailable results after the quiet interval on unchanged evidence. |
| Shutdown | On server close, SIGTERM, or SIGINT, stop timers, request worker termination, and reject late outcomes. Signal-driven process exit awaits worker exit. |

`telemetry.mjs` owns file signatures and worker construction. The controller accepts those
dependencies and clock/timer functions; `getHealth()` copies cached state without reading files or
starting work. The independent calculation modules remain separate from both.

### Runtime measurements

The runtime check generates supported synthetic evidence, runs the real isolated worker, and polls
a lightweight portal route while calculation is in progress. A representative final run produced:

| Target | Written evidence | Events | Worker duration | Portal responses during calculation |
| --- | ---: | ---: | ---: | ---: |
| 4 MiB | 4,196,474 bytes | 1,905 | 189 ms | 9 |
| 24 MiB | 25,167,813 bytes | 11,405 | 1,016 ms | 46 |

Reproduce the two sizes with:

```bash
node scripts/test/telemetry-oracle-runtime-check.mjs --size-mib 4
node scripts/test/telemetry-oracle-runtime-check.mjs --size-mib 24
```

Durations and response counts vary with machine load. The assertions require successful agreement,
one worker that exits, and multiple portal responses while that worker is active.

### Verification layers

| Layer | Primary check | What a pass establishes |
| --- | --- | --- |
| Capture and schema | telemetry capture/schema checks | Persisted events have the supported shape and provider fields. |
| Analytics arithmetic | `telemetry-oracle-check` | Covered values agree with an independent raw-event implementation. |
| Oracle independence | `telemetry-oracle-core-check` | Imports respect the core boundary; calculations preserve inputs and evidence-policy behavior. |
| Live comparison contract | `telemetry-oracle-live-check` | Unsupported evidence prevents a pass; injected disagreements fail; output excludes raw values and exception text. |
| Health status contract | `telemetry-oracle-health-check` | Versioned results reject malformed output; pure transitions cannot accept a stale pass as current. |
| Worker isolation and reading | `telemetry-oracle-worker-check` | A real worker counts skipped records, preserves raw evidence support checks, emits one sanitized result, and exits. |
| Scheduling and lifecycle | `telemetry-oracle-observer-check` | Fake-clock checks enforce debounce, maximum wait, coalescing, freshness, retries, timeout, and exit-before-restart behavior. |
| Evidence freshness | `telemetry-oracle-signature-check` | All consumed stores participate in a metadata-only signature, including replacements and same-size edits. |
| Runtime responsiveness | `telemetry-oracle-runtime-check` | Portal status requests complete during a real worker comparison over a near-cap synthetic spool. |
| Cached HTTP boundary | `telemetry-oracle-route-check` | The GET route returns only the versioned allowlist, never starts analysis or reads evidence, and rejects malformed cache state. |
| Browser status | portal UI oracle-health checks | All six text statuses, accessible singleton details, visibility-aware polling, guide linking, responsive layout, and report independence work in a real browser. |
| Presentation rules | conditions presentation checks | Thin evidence, neutral bands, and correlation-only language are presented honestly. |
| Browser integration | portal UI suite | The report reaches the Tokens page and its interactions render correctly. |

Run `npm run test:telemetry-oracle` for the deterministic comparison summary. Run
`node scripts/test/telemetry-oracle-core-check.mjs` and
`node scripts/test/telemetry-oracle-live-check.mjs` for the comparison boundary checks. Run
`node scripts/test/run-checks.mjs --filter telemetry-oracle` to include the health, worker, observer,
signature, runtime, route, and job-summary checks. All ten belong to the `ci` check group run by
`npm run check`. The synthetic CI summary lists case and evidence counts; a failure includes the
seed, disagreement, metadata, and minimized replayable JSONL.

### Live evidence support

The independent acceptance rules follow the analyzer's raw acceptance boundary in
`telemetry-observations.mjs`, repository resolution in `telemetry-repository.mjs` and
`modules/repositories/associations.mjs`, and snapshot/marker condition semantics in
`telemetry-conditions.mjs` and `telemetry-boundaries.mjs`. Bare tool attribution was checked against
`mcpServerOf()` in `scripts/harnesses/transcript-parse.mjs`. These are reference sources, not imports
of the independent calculation modules.

| Raw evidence form | Independent handling and coverage |
| --- | --- |
| Capture schema absent/null, `2`, or `3` | Supported. Exact v3 calls deduplicate by harness/session/call; derived or missing calls use capture/content fallback. |
| Explicit schema `1`, other versions, non-object rows, unidentified sessions, invalid timestamps, malformed token fields | Explicit unsupported/malformed categories; live comparison is `unavailable`. Such rows never disappear into a pass. |
| Direct `repo.repository_id` | Supported and takes precedence over legacy hashes. Malformed values are unsupported. |
| `repo.normalized_remote_hash` with raw registry evidence | Independently hash each registry `normalizedRemote` with SHA-256, truncate to 24 hex characters, and resolve its canonical `id`. Conflicting hash identities make the input unavailable. |
| Missing repository data, unmatched normalized hash, `remote_hash`, `git_root_hash`, basename/label, or path-only evidence | Unresolved. Neither a label nor a path hash establishes canonical identity; agreeing calculations remain `partial`. |
| Token data absent/null | Supported absence; session and token-session counts remain distinct. |
| Missing model, missing referenced snapshot, unknown snapshot evaluability, or conflicting session condition evidence | Counted coverage gaps; agreeing calculations remain `partial`. A session that changes snapshot IDs is conservatively partial. |
| Snapshot schemas `1` and `2` | Independently evaluate package/skill arrays and v2 evaluability. Unknown schemas, malformed arrays, and duplicate IDs make input unavailable. |
| Native `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, `NotebookEdit`, and prefixed `mcp__...` tool names | Supported. Other bare names, including production-recognized bare MCP aliases, are explicitly `unsupported_bare_tool`; independent alias support remains a possible later extension. |
| Marker schemas `1` and `2` | Supported arithmetic for active change markers watching spike, loop, and read-warning. Unknown scope, missing watched kinds, or unresolved supersede references prevent a pass. |
| Unsupported watched kinds such as `over-testing`, malformed/unknown markers, or duplicate marker IDs | Input unavailable. Phase, outcome, experiment, and note markers have no covered change projection. |
| Filtered analysis options or a caller-supplied production hash index | Unsupported. The live boundary accepts an unfiltered snapshot plus raw repository registry evidence. |
| Reader-skipped or malformed persisted records | The worker supplies nonnegative parse-failure counts for events, markers, snapshots, and registry evidence through `skippedEvidence`; any positive count prevents a pass. Parsed unsafe shapes remain in the supplied evidence. |

`inspectOracleEvidence()` counts supplied event rows and fixed coverage categories before analysis.
`compareTelemetryOracle()` compares the same full in-memory event array on both sides when its
shape is comparable; it does not filter away unsupported rows to manufacture agreement. An unsafe
shape returns `unavailable` without invoking analysis. Interpretable unknown conditions can still
be compared, but agreement returns `partial`.

The live comparison returns aggregate counts, coverage categories, and names of disagreeing
projection fields. CI uses the same core and comparison projections while retaining its synthetic
values, shrinker, and replay output. The comparison result describes agreement over the supplied
input. The worker wraps that result in the versioned schema; the observer establishes freshness
using the complete signature and worker lifecycle described above.

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
  gives every heading a stable slug `id` so a panel's info icon can deep-link straight to its
  section; fenced ` ```mermaid ` blocks render as diagrams through the locally vendored mermaid
  runtime (`portal/shared/markdown-mermaid.js`), loaded lazily on first use.

All mutating routes are POST-only and use the portal's standard loopback-origin + mutation-token
guard (see `docs/internal/portal-architecture.md`).

See [Portal Architecture](portal-architecture.md) for the shared server, route, and mutation-token
architecture.
