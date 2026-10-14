# Tokens portal review

Reviewed on 2026-09-21. This is a dated review of that implementation state; use
[Telemetry Internals](telemetry-internals.md) and the [Telemetry reference](../user/reference/telemetry.md)
for current behavior.

## Purpose

This review compares the conditions portal with the approved primary-checkout
`portal/mockups/tokens-connectivity-vision.html` and evaluates whether each section helps
someone choose an action. It covers the conditions feature in
`codex/telemetry-tokens-conditions-report` (committed, not yet merged), including the follow-up
simplification. Open follow-ups from this review are tracked in plan `nl40n9vr`.

The review used the repository copies of the requested code-style and JavaScript skills.
The GitHub links were unavailable during retrieval. JavaScript, ESM, DOM-template, ownership,
and test rules applied; TypeScript and React conventions did not.

## Findings and changes

### Mockup inventory

| Reference element | Finding before this review | Current implementation or remaining difference |
| --- | --- | --- |
| Compact event rows | Recent rows repeated repository labels and five long context labels. A session could appear many times. | One row per session, repository shown once, short model/harness chips, resource count. Full names are in session details. |
| Event evidence hierarchy | Recent sessions competed with Action items and the existing investigation lists. | Recent sessions start collapsed and scroll within 440px or 60vh. Action items recommend; recent sessions provide evidence. |
| Condition coverage band | Always visible below an already dense list. | Available under “What context was captured?” inside the evidence section. Unknowns stay explicit in comparison details. |
| Session title, subtitle, close control, fact grid | Present, but repeated the same metadata in two grids and chips. | Next step leads one condition fact grid. Captured findings remain available without a transcript. |
| Several model metric cards | Demo only had one model above the display threshold. Partial coverage was plain gray. | Demo showed three eligible models. The panel was later removed; see "Removed: relative model metrics". |
| Tokens per operation and exact attribution | Not supported by persisted cumulative session counters. | Still session-based and approximately attributed. Per-operation claims require new evidence. |
| Stacked condition cards | Present. | Retained, with named model/repository/package/skill rows and green/red outcomes. |
| Named condition items | The condition value was omitted from main-card rows. | Names now appear before outcome pills. Canonical repository identifiers remain in data and details. |
| Low-count raw rates | A null percentage was incorrectly presented as no difference. | “More evidence needed” opens a popup of raw counts and what each row still needs; full outcomes retains all rows. Missing baselines, small samples, and neutral outcomes are distinct. |
| Category full-outcomes dialogs | Tables existed, but low samples were mislabeled; refresh could remove an open dialog. | Correct labels, raw counts, coverage, and colored outcome text. Refresh waits while a dialog is open. |
| Section help controls | New condition/ledger/change sections lacked help entry points. | Added controls opening the corresponding guide sections. |
| Marked changes comparison | Duplicated full before/after numbers from Your changes. | Compact linked summaries; Your changes owns counts and next steps. This intentionally differs from the mockup’s repeated two-column layout. |
| Ledger panel and visual hierarchy | The initial review missed the enclosing panel, right-aligned date column, bold event titles, and purple change-row treatment. | Corrected to match the reference structure, including the “What happened, in order” heading, inset scope note, and quieter separators. Repeated “Session evidence” labels were removed. |
| Ledger time / event / status columns | Third column contained a long metadata paragraph; comparison statuses were absent. | Compact event description and a separate status column. Change rows are tinted; marker rows navigate to their comparison. |
| Ledger repository names | Canonical IDs appeared in ordinary prose. | Human-readable names in rows; canonical IDs retained for matching. |
| Ledger change timing and scope note | Coarse configured-package changes and scope note existed. | Retained. Exact changed files, content revisions, and “second spike this month” are still not supplied by the current projection. |
| Your changes verdict colors | Equal rates fell into “More”; small event counts could receive a confident-looking direction. | Equal rates are neutral. Small event counts say “Early signal.” Each verdict includes a concrete next step. |
| Available and collecting change examples | Demo showed collecting states only. | Demo now includes an available comparison and a separate collecting change. |
| Mark-change form | Working form with time, scope, watched kinds, and append-only corrections. Labels were technical. | Plain “making this change now / made it earlier” choices; form handlers are initialized once. |
| Multiple-repository marker scope | Mockup names two repositories in one change. | Current form supports one repository or everywhere. Arbitrary repository sets remain absent. |
| Weekly change frequencies | Mockup uses spikes/week. | Current cards use affected-session rates and explicit denominators. Weekly frequencies remain absent. |
| Narrow-screen full outcomes | Five table columns compete for space at 390px. | Page and cards fit without horizontal overflow, but the full-outcomes table remains dense. Stacked comparison details are a recommended mobile follow-up. |
| Shared page geometry | Reference uses a 1060px column and its own palette; portal uses shared page styles. | Shared portal width, palette, and surrounding section spacing remain. This is not a pixel-identical reproduction. |
| Page order | Existing waste, actions, investigate, conditions, ledger, changes, and prompt were preserved. | Retained. |

### Removed: relative model metrics

The "Model token usage per session" panel (average tokens per session, input/output mix, and
valid/eligible coverage for each model) no longer exists. It left the page in `74b60fc` without a
recorded reason. The code (`relativeModelMetrics`, `tokenCoverage`, the `relative_models` report
field, and the `minimum_model_sessions` policy) and its guide section were removed afterward,
because per-model averages compared sessions of different tasks with no shared baseline of activity, so they could not support a comparison between models; the panel's own copy already said not to rank models because tasks differ. Models are still compared through the Conditions cards, which
compare sessions with and without a condition rather than averaging usage per model.

### Code correctness and maintainability

| Finding | Resolution | Source |
| --- | --- | --- |
| An older action headline described a falling token share as “up,” because its trigger measures per-call cost. | Superseded by the 2026-09-30 audit below: the headline now speaks only in per-call cost. | `scripts/cli/telemetry-insights.mjs` |
| Missing percentages were treated as no difference. | Centralized presentation states distinguish missing baseline, low sample, neutral, fewer, and more. | `portal/tokens/conditions-format.js` |
| Equal before/after rates became “More.” | Explicit equality branch; low-count changes remain provisional. | `conditions-format.js` |
| A late session request could overwrite a later-opened session. | Request identity guards success and error paths. | `portal/tokens/app.js` |
| Background refresh replaced open comparison dialogs. | Defer rendering while a dialog is open; resume on later polls. | `app.js` |
| Session metadata lookup ignored harness identity. | Match the session and harness together in the modal lookup. | `app.js`, `conditions-context.js` |
| Demo sessions lacked useful fallback findings when transcripts were absent. | Render captured ledger findings when the session API has none. | `conditions-context.js` |
| Known resources concealed unknown resource dimensions. | Resource summaries preserve partial/unknown context alongside known resources. | `conditions-context.js` |
| Multiple problem records occupied multiple recent-session rows. | Group by harness/session identity; retain all underlying ledger events. | `conditions-evidence.js` |
| Coverage and ancillary panels could retain stale content when conditions disappeared. | Explicit visibility and empty-state updates for the whole feature. | `conditions-report.js` |
| “Show all” rebuilt the entire conditions feature and unbounded the ledger. | Ledger controller adds 12 rows at a time without rebuilding other panels. | `conditions-ledger.js` |
| Rendering, form submission, comparison wording, metrics, and context were mixed in one large function. | Separate feature modules with a short orchestration entry point; pure presentation is independently tested. | `portal/tokens/conditions-*.js` |
| Analysis rebuilt normalization, snapshot maps, and session context repeatedly. | Reuse normalized observations; index snapshots/sessions and memoize per-session context. | `scripts/cli/telemetry-conditions.mjs`, `telemetry-analyze.mjs` |
| Demo assignment performed repeated linear session lookups. | Index session positions once. Synthetic evidence still runs through production analysis. | `telemetry-conditions-demo.mjs` |
| Top-level session count omitted sessions without token-bearing captures while coverage counted them. | Page meta uses the canonical observed-session count when conditions are available. | `app.js` |
| Browser tests checked dialog visibility without loaded facts. | Assert observation unit and next step; cover session races, filtering, bounded scroll, active demo signals, and polling. | `scripts/test/portal-ui/telemetry-conditions.spec.mjs` |

### Logic audit, 2026-09-30

Two independent audits reproduced sixteen findings. The canonical conditions path was sound; the
risk sat in the older dashboard layer, in presentation gating the matrix check did not cover, and
in marker editing. All are resolved on `codex/telemetry-tokens-conditions-report`; the invariants
they protect are listed in [Telemetry Internals](telemetry-internals.md#analytics-correctness).

| Finding | Resolution |
| --- | --- |
| Regression headline mixed per-call trigger with share direction, so a worsening could read “down from”. | Trigger, worst-group pick and headline all use per-call cost; share is context. |
| Change verdicts ignored the display band, checked equality before the evidence floor, and showed percentages on tiny samples. | Evidence floor first, then band, then direction; counts only below the floor. Golden cases added. |
| Equal-timestamp ledger rows ordered by id. | Persisted order breaks ties, for markers and ambient changes. |
| Unknown-scope markers reported “below the minimum of 10”. | Reported as “can't compare fairly”. |
| A supersede could name a missing, non-change or already-superseded marker. | Validated when the marker is created. |
| Seed message said “5 sessions” for a spool with 105. | Counts real sessions and names the synthetic cohort. |
| Marker at the boundary was “before” in one path and excluded in the other. | One rule: `effective_at ?? ts`, boundary sessions excluded. Sequence-ordered at-boundary sessions are still assigned, since that is real ordering evidence. |
| Editing a change dropped packages, skills and tags, and “response” silently moved the boundary to now. | Exposure is carried through; moving to now needs confirmation. |
| Emerging patterns still said “Investigate why…”. | Anything below a strong signal reads as an early signal. |
| Demo baseline and focused cohorts differed in repo and model. | Both cohorts share both. |
| Legacy rollups keyed on bare `session_id`, merging harnesses and fabricating cross-harness loops; tables dropped tokenless sessions while conditions counted them. | One harness-keyed pipeline on canonical rows; the conditions report is always built. Meta line shows sessions and sessions with token data. |
| Findings on unidentified sessions vanished silently. | Counted in `data_quality.findings_lost_to_fallback` (not yet displayed). |
| Waste card read as a disjoint sum. | De-duplicated per turn server-side (`report.waste`); each turn counts once, under its largest source. |
| Change rows hid how many sessions had unknown condition data. | `unknown_condition` returned and shown. |
| Cross-mirror duplicate findings (latent). | Not possible now that analysis runs on deduplicated rows. |

### Remaining code opportunities

Except where noted, these are tracked in plan `nl40n9vr` (Phase 5).

| Priority | Opportunity | Why it matters |
| --- | --- | --- |
| Medium | Finish extracting legacy investigation and session markup from `app.js` into HTML templates and focused modules. | New condition markup follows the template convention; older renderers still contain HTML strings and the remaining file exceeds the skill’s size guideline. |
| Medium | Profile condition serialization on large spools. | Each ledger context still includes evaluated conditions. Index reuse reduces computation, but payload size grows with findings and condition cardinality. No large-spool performance benchmark was run. Tracked in `telemetry-analyze-single-pass-perf`. |
| Medium | Disambiguate repositories sharing the same display name in selectors. | Canonical values remain distinct, but readable basenames can still look identical. Show owner/path only when labels collide. |
| Low | Replace broad screenshot selectors in older portal tests with semantic locators. | New interaction checks use roles and names; some layout assertions still rely on IDs/classes. |

## Decisions the page should support

| Section | User decision | Evidence depth |
| --- | --- | --- |
| Action items | What should I investigate first? | Ranked recommendation and jump to evidence. |
| Recent problem sessions | Which session explains this recommendation or condition signal? | Collapsed, bounded list; session dialog contains the detail. |
| Conditions | Which setup is worth comparing on similar work? | Named signals and inspect-session actions; raw/unknown detail on demand. |
| Event ledger | Did problems appear around a recorded or observed change? | Chronology with change links and boundary status. |
| Your changes | Should I keep monitoring, investigate a regression, or collect more evidence? | Before/after rates, exclusions, and next step in one place. |

### Recommended next product iteration

Tracked in plan `nl40n9vr` (Phases 2 and 3).

1. Make Action items the single prioritized decision list. Fold condition signals into those
   recommendations once task comparability is established; keep conditions as supporting evidence.
2. Add “Record what I tried” beside an investigated finding, prefilling its scope and watched
   problem. The current form supports attachment but still requires a separate trip to Your changes.
3. Add task-type and time-window comparison controls before suggesting a model/package switch.
   Current associations cannot distinguish a setup effect from different work.
4. If the page remains too long in normal use, collapse the event ledger behind a compact
   recent-changes summary. Preserve the full chronology for investigations.
5. Present full outcomes as stacked comparisons on narrow screens. The current five-column
   table fits the modal but makes labels wrap heavily at 390px.

## Verification

The review checks are scoped to the modified conditions feature and its integration. They do
not establish causal model rankings or complete enumeration of all possible telemetry inputs.

| Check | Result |
| --- | --- |
| `node scripts/test/run-checks.mjs --filter telemetry` | 24 suites passed, including HTTP cache invalidation. |
| `node scripts/test/telemetry-conditions-matrix-check.mjs` | 2,850 deterministic scenarios passed within the declared bounded input spaces. |
| `bash scripts/doctor.sh --quiet` | 104 checks passed. |
| Browser suite and guide screenshots | 23 tests passed; one optional introduction screenshot skipped. Light/dark guide screenshots regenerated. |
| `bash scripts/test/test-cli.sh --quiet` | 423 passed, zero failures. |
| Visual inspection | Primary reference compared with rendered desktop conditions, session evidence, and dialogs; responsive checks cover 720px and 390px. |

The primary-checkout mockup was not edited. Existing unrelated worktree edits remain intact.
