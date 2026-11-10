---
id: telemetry-analysis-io-performance
priority: high
next_action:
blocked_by: []
depends_on: []
related:
  - roborepo-telemetry-events-experiments
  - telemetry-immediate-correctness
reviewed_commit:
---

# Telemetry Analysis I/O Performance

## Summary

The telemetry dashboard recomputes its full analysis report on the request path,
re-reading and re-parsing the entire append-only spool from disk every time the
data changes. On a 31MB / ~35k-event spool that is ~780ms of work per compute,
dominated by re-parsing all lines. Because the portal server is single-threaded
(Node stdlib `http`), that work blocks every other request while it runs — which
is why navigating between portal pages while telemetry is capturing feels
unresponsive, and why the loading overlay lingers.

This plan makes the dashboard a lightweight I/O layer: keep parsed events in
memory and read only newly-appended bytes (incremental read), and debounce the
recompute so bursts of captures do not each trigger a full re-analysis. Both
changes stay on the main thread — no worker thread, no separate process, no new
lifecycle to manage.

## Context

Prior session work already landed two smaller fixes on top of commit `d2e19b5`
(not yet committed at plan-write time):

- Loading overlay is now real server-rendered markup (no flash) and fully opaque;
  the spinner is viewport-centered on tall pages.
- `/api/data` results are memoized by spool signature + window + harness
  (`cachedAnalysis` in `scripts/cli/telemetry.mjs`), so an unchanged spool returns
  the cached report instead of recomputing.
- Static assets send an ETag + `Cache-Control: no-cache` so page navs revalidate
  with a 304 instead of re-downloading CSS/JS.

Those fixes removed redundant work when nothing changed. The remaining problem is
the cost of the compute itself when the spool *does* change — which, while
telemetry is actively capturing, is every few seconds. That is the work this plan
targets.

### Measured cost (commit d2e19b5, ~35,686 events, 31MB, 2 spool files)

Steady-state (JIT-warmed) breakdown of one full compute:

| Stage | Cost | Notes |
|---|---|---|
| `fs.readFileSync` (all files) | ~150ms | raw 31MB disk read |
| `split("\n")` + `JSON.parse` per line | ~316ms | **dominant cost**; re-parses all 35,686 lines |
| `analyzeTelemetry` (pure) | ~183ms | ~15 full passes over the captures array |
| `JSON.stringify(report)` | ~98ms | response serialization |
| **Total** | **~780ms** | grows with spool size |

The first cold call measures higher (~1.5s) because of JIT warmup; the numbers
above are the honest steady-state cost the running server pays.

Key structural fact: **the spool is append-only.** Every compute currently throws
away all previously-parsed events and re-reads + re-parses the whole file. A newly
landed event should cost one parsed line, not 35,686.

## Goals

- Remove the full re-read + re-parse of the spool on every changed compute.
- Decouple analysis frequency from both capture frequency and page-load
  frequency: page loads become pure reads of a precomputed report.
- Keep the change on the main thread — no worker/child-process lifecycle.
- Preserve exact report correctness (byte-identical output to a full re-read for
  the same event set) and the existing window/harness/pan behavior.

## Non-goals

- Worker threads or a separate analyzer process. Explicitly deferred (see Open
  questions) until steady-state analyze cost alone (currently ~183ms) becomes a
  problem — e.g. if the spool grows ~10x.
- Changing the analysis semantics, spike classifier, or report shape.
- Persisting a computed-report cache to disk across server restarts.
- Spool compaction / rotation / retention (a separate concern; noted as a future
  lever under Open questions).

## Current state

- `scripts/cli/telemetry.mjs`
  - `readSpoolEvents()` — reads every `*.jsonl` file fully, splits, and
    `JSON.parse`s each line into a fresh array on every call.
  - `spoolSignature()` — cheap change token: file count + newest mtime + total
    size across spool files. Already used to key `cachedAnalysis`.
  - `cachedAnalysis(window, harness)` — memoizes the computed report per
    `signature | window | harness`; on a cache miss it calls `readSpoolEvents()`,
    filters by window/harness, runs `analyzeTelemetry`, backfills up to 20
    transcript titles, and stores the result (max 32 entries).
  - `_titleCache` — per-session transcript title cache (append-only transcripts).
  - The `serve` wiring passes `loadAnalysis: (window, harness) => cachedAnalysis(...)`
    to `startPortalServer`; the route calls it synchronously inside `/api/data`.
- `scripts/cli/telemetry-analyze.mjs` — `analyzeTelemetry(events)` is a pure
  function over an events array (no I/O); it makes many separate passes over the
  captures array (`topBy` x4, `toolCost`, `groupCost`, `spikeAnatomy`,
  `packageCost`, `regression`, `detectLoops`, `usageWindows`, `comparison`,
  timeline `map`+`sort`).
- `scripts/cli/portal-routes-telemetry.mjs` — `/api/data` handler:
  `send(res, 200, ..., JSON.stringify(loadAnalysis(window, harness)))`. Purely
  synchronous.
- Client (`portal/telemetry/app.js`) polls `/api/data` every 5s and repaints only
  when the report's `version` field changes; range/pan/harness interactions issue
  their own `/api/data` requests with query params.

## Proposed design

Two tiers, both main-thread.

### Tier 1 — Incremental spool read (in-memory event store)

Introduce a module-level event store in `telemetry.mjs` that holds parsed events
plus a per-file cursor:

- Track, per spool file, `{ path, size, offset }` — how many bytes have been
  read and parsed so far.
- On each `readSpoolEvents()` (or a new `syncSpoolEvents()`):
  - `readdir` the spool; for each `.jsonl` file, `stat` it.
  - If a known file **grew** (size > stored size): read only bytes
    `[offset, size)` via a file handle / `fs.readSync`, split the new chunk into
    lines, parse, and append to the in-memory array. Carry a partial trailing
    line (a capture written mid-append) to the next sync rather than dropping or
    mis-parsing it.
  - If a file is **new**: read it fully, parse, append, record its size.
  - If a file **shrank or vanished** (rotation, truncation, manual edit): fall
    back to a full rebuild of the store (clear array + cursors, re-read all).
    Correctness over cleverness for the rare case.
- Return the accumulated in-memory array.

Net effect: nothing changed → a few `stat` calls (microseconds). A few new events
→ parse only those lines (~sub-ms). The ~466ms read+parse collapses to near-zero
except on the rare full-rebuild path.

`cachedAnalysis` stays as-is on top of this; the signature still gates whether
`analyzeTelemetry` re-runs. Tier 1 only makes the "read the events" half cheap.

### Tier 2 — Debounced recompute of the default view

Even with cheap reads, `analyzeTelemetry` (~183ms) should not run once per event
during a capture burst. Keep the **default view** (`window = null`,
`harness = null` — what the page loads with) warm via a debounced refresh:

- A spool change schedules a recompute of the default report after a quiet
  interval (proposed ~10-20s), with a max-wait cap so a continuous stream still
  refreshes periodically. Implemented with `setTimeout`/`clearTimeout` — a timer,
  not a worker.
- `/api/data` for the default view always returns the last computed default
  report immediately (may be up to the debounce interval stale — acceptable for a
  telemetry dashboard; surfaced to the user via the existing "updated" timestamp).
- Windowed / panned / harness-filtered requests keep computing on demand (cached
  by signature+window+harness as today). These are user-initiated interactions
  where a brief spinner is acceptable and precomputing every combination is
  infeasible.

Tier 2 depends on Tier 1: the debounced recompute reads events cheaply, so the
only main-thread cost per refresh is the ~183ms analyze, happening at most once
per debounce interval and between requests rather than inside one.

### Tier 1.5 — bounded analyze pass reduction

`analyzeTelemetry` makes ~15 passes over the captures array. Folding the
independent single-pass aggregations (the `topBy` calls, `usageWindows`,
per-tool/group tallies) into one loop could cut the ~183ms materially. This is a
pure-function optimization with strong test coverage available
(`telemetry-correctness-check.mjs`). Tier 1.5 deliberately stayed bounded:
consolidate the low-risk independent summaries into one capture index, but leave
deeper result-cost helpers alone because they have more subtle ordering and
rounding behavior for less certain gain.

## Implementation plan

- [x] Add a micro-benchmark harness (`scripts/test/telemetry-spool-bench.mjs`)
      reporting read / parse / analyze / stringify timings against the live spool.
- [x] Tier 1: in-memory event store + incremental read in `telemetry.mjs`
      (`readSpoolEventsCached` + `syncSpoolFile`, module-level `_spoolStore`).
      Both live-server readers (`cachedAnalysis`, `loadInsightsLlm`) route through
      it; the one-shot CLI paths (`telemetryReport`/`telemetryExport`) keep the
      plain full-read `readSpoolEvents`. Handles append, new-file, shrink/rotate
      rebuild, file removal, and partial-trailing-line carry.
- [x] Tier 1 correctness: `scripts/test/telemetry-spool-store-check.mjs` asserts
      the store == a fresh full re-read across initial multi-file read, append,
      partial-line hold + completion, `capSpool` shrink, and file removal.
- [x] Measure Tier 1: steady-state read collapsed from ~450-590ms (full read) to
      **~1.3ms** (warm incremental). See Results.
- [x] Decision (locked before implementation): build Tier 1 + Tier 2 in one pass.
- [x] Tier 2: debounced default-view refresh (`startAnalysisRefresh` /
      `tickAnalysisRefresh`, 2s poll / 12s quiet / 60s max-wait). ALSO cache the
      serialized JSON (`cachedAnalysisJson`) — the ~10MB default response was being
      `JSON.stringify`'d (~100ms) per request in the route; the hot `/api/data`
      path now writes the cached string. Route uses `loadAnalysisJson`.
- [x] Tier 2 verification: default `/api/data` served in **~0.4ms** warm; nav to
      other portal pages instant while an on-demand windowed compute is in flight;
      append → `capture_count` increments after the debounce refresh (correctness).
- [x] Tier 1.5: bounded single-pass aggregation in `analyzeTelemetry`. A new
      `indexScopedEvents` pass builds `captures` and harnesses together, and
      `indexCaptures` builds top repos/tools/MCP/events, sorted timeline rows,
      latest Codex rate limits, and the usage-window clock in one pass. Kept
      the deeper result-cost helpers (`toolCost`, `groupCost`, `spikeAnatomy`,
      `packageCost`, `regression`, `detectLoops`) separate to avoid a broader
      behavioral rewrite with weaker payoff.
- [x] Documented the store + debounced-refresh model (this plan's Results +
      `docs/user/reference/portal.md`).
- [x] Extracted the incremental byte-tail read (offset advance, partial-line hold,
      shrink/rotate detection) into `scripts/cli/jsonl-tail.mjs`
      (`readAppendedLines`), shared by the spool store (`syncSpoolFile`) and the
      transcript reader (`telemetry-transcript.mjs`, which had a second hand-rolled
      copy). Covered by `scripts/test/jsonl-tail-check.mjs` (9 cases incl.
      partial-line, shrink-rebuild, UTF-8 byte-offset — the exact drift point
      between the two old implementations).

## Results (measured, ~35.7k events / 31MB / 2 spool files)

| Path | Before | After |
|---|---|---|
| Spool read+parse (steady state, no change) | ~450-590ms full re-read | **~1.3ms** incremental |
| Default `/api/data` response (warm) | ~100ms (per-request stringify) + read | **~0.4ms** (cached serialized JSON) |
| Nav to another page during a compute | queued behind the ~780ms block | **instant** (~0.5ms) |
| Analyzer summary passes | separate capture filter, harness map, topBy x4, timeline map, rate-limit reverse scan | **one indexed pass** for those summaries |

`analyzeTelemetry` (~180-270ms) and its stringify (~70-100ms) still run on a
change, but now on the background debounce timer between requests — not inside a
page/API request. The default view is kept warm proactively, so the request path
reads a ready serialized report.

## Decision log

- **Tier 1.5 scope:** chose a bounded pass-reduction rather than a full analyzer
  rewrite. The clear win was consolidating independent summaries that had direct
  one-to-one replacements. The less clear work was folding cost/regression/loop
  helpers into the same pass; that would couple currently readable helpers and
  risk subtle sort or rounding drift. This can still be revisited later if a
  benchmark shows analyzer CPU is again user-visible.

## Validation

- `node --check` on every changed `.mjs`.
- `node scripts/test/telemetry-correctness-check.mjs` passes (report shape/values
  unchanged — this is the guardrail for Tier 1 and any Tier 1.5 work).
- `telemetry-correctness-check.mjs` now includes `testAnalyzerIndexedSummaries`,
  pinning the outputs consolidated by Tier 1.5: harnesses, top rollups, timeline
  ordering, usage-window clock/totals, and latest Codex rate limits.
- New/updated equality assertion: incremental store == full re-read for the same
  spool state.
- CI: the three guardrails (`jsonl-tail-check.mjs`, `telemetry-spool-store-check.mjs`,
  `telemetry-correctness-check.mjs`) are wired into `scripts/test/test-roborepo.sh`
  (the "test suite" step in `.github/workflows/ci.yml`), so a regression in the
  incremental reader, the store's equality with a full re-read, or the analyzer
  output fails CI. `telemetry-spool-bench.mjs` stays a manual profiling tool, not a
  CI check (timing-dependent).
- Live measurement via the benchmark harness: changed-compute read+parse before
  vs after Tier 1; end-to-end `/api/data` timing under active capture.
- Manual: with telemetry capturing, navigate across portal pages and confirm no
  perceptible stall; confirm the telemetry page still reflects new captures within
  the debounce window.

## Risks

- **Partial trailing line**: a capture written between a stat and a read could
  leave a half line at the file tail. Mitigation: track byte offset precisely and
  carry any trailing non-newline-terminated remainder to the next sync; never
  parse a line that lacks its terminating newline.
- **Silent divergence from full read**: an incremental-store bug could make the
  dashboard show stale/wrong numbers that look plausible. Mitigation: the
  equality assertion in tests, and the shrink/rotate full-rebuild fallback.
- **Stale default view during a burst**: Tier 2 trades freshness for smoothness.
  Mitigation: bound staleness with the debounce max-wait and keep the "updated"
  timestamp honest so the user can see the report's age.
- **Memory growth**: the in-memory event store grows with the spool (31MB of
  JSON → more as live objects). Acceptable for a local single-user tool at
  current scale, but noted as a driver for future spool rotation.

## Deferred follow-ups

- Debounce interval and max-wait shipped as 12s quiet / 60s max-wait. Revisit
  only if the default dashboard view feels too stale during sustained capture.
- Keep the in-memory store on the live-server path only. One-shot terminal report
  and export paths continue using a full read, which is simpler and avoids
  cross-command process-state assumptions.
- Worker threads remain deferred. Revisit only if analyzer CPU again becomes
  user-visible as spool size grows.
- Spool rotation / compaction remains a separate future lever to cap memory and
  long-term spool size.
