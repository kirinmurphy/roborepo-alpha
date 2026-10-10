---
id: nl40n9vr
priority: medium
next_action: Add time range, harness, and model controls to the Tokens page, wired to the existing /api/data parameters and serialized into the URL
blocked_by: []
depends_on: []
related:
  - k8mngttv
  - pljvmyh
  - tk6s43x3
  - jqi1dof
  - n8kw3rp2
  - telemetry-analyze-single-pass-perf
reviewed_commit:
---

# Tokens Report: Scope Controls and Deeper Change Comparison

## Summary

The Tokens page answers "what went wrong and under which conditions" for everything the spool holds.
It cannot yet answer "what went wrong this week, for Codex, on this model", and a marked change is
judged only by problem rates. This plan adds the controls and comparisons the page lacks, and
decides what happens to the server endpoints that lost their only caller when the legacy
`/tokens_v1` dashboard was removed.

It consolidates three sources that would otherwise drift apart:

- the recommended next product iteration in [Tokens portal review](../../internal/tokens-portal-review.md);
- the Tokens migration inside [[tk6s43x3]] (shared repository scope), which owns only the repository
  dimension;
- the endpoint and filter capabilities the legacy dashboard used and the current page does not.

## Context

[[k8mngttv]] delivered the conditions report on `/tokens`: condition cards, the event ledger, marked
changes, and a per-turn waste ledger. The legacy dashboard (`portal/telemetry/`, route
`/tokens_v1`) was deleted afterward. It owned the time/harness/model/repository filter bar, the
Analysis explorer, and experiment controls. None of those were carried over, by design: the new
page replaced them with fixed sections.

## Goals

- Scope the whole report by time range, harness, model, and (through [[tk6s43x3]]) repository.
- Show a change's effect on a headline metric, not only on spikes, loops, and read warnings.
- Make the page's recommendations a single prioritized list and shorten the path from a finding to
  a recorded change.
- Leave no server endpoint without a caller, test, or documented purpose.

## Non-goals

- Changing analysis semantics, evidence floors, or the ±20% display band from [[k8mngttv]].
- Exact file revision tracking; that remains [[f0j4j8y2]].
- Repository discovery (owned by [[pljvmyh]]), `urlKey`, or the shared selector (owned by [[tk6s43x3]]).
- Causal claims. Every comparison stays association-only.

## Current state

| Capability | Backend | `/tokens` UI |
| --- | --- | --- |
| Time range (`range`, `end`), `harness`, `model`, legacy `repo` label, canonical `repository`, `marker_id` on `/api/data` | Present in `scripts/cli/portal-routes-telemetry.mjs`, cached per window, harness, and cohort | None. The page requests `/api/data` with no parameters |
| Marker-relative comparison of any registry metric (`POST /api/telemetry/analysis` with `marker_id`) | Present; ~28 metrics across tokens, calls, testing, outcome, reliability | None. Change cards compare spike, loop, and read-warning rates only |
| Two-cohort metric comparison (`POST /api/telemetry/analysis` without a marker) | Present; returns one value per cohort, correlation-only | None. Condition cards cover model, repository, harness, package, and skill |
| Experiments (`GET/POST /api/telemetry/experiments`, `POST .../:id/end`) | Present; the `roborepo telemetry experiment` CLI calls the domain functions directly | None |
| LLM deeper read (`GET /api/insights-llm`) | Present; shells out to `claude -p`. The CLI report has its own `runDeepRead` call | None. The page offers a copy-prompt panel instead |

Within this repository, the only callers of the analysis and experiment endpoints are assertions in
`scripts/test/test-cli.sh`; `/api/insights-llm` has no caller.

## Proposed design

### Phase 1: Report scope controls

- Add range, harness, and model controls near the page header. Repository joins them when
  [[tk6s43x3]] lands, using its shared selector rather than a page-local one.
- Serialize the selection into the URL and restore it on load, so a scoped view can be shared.
- Send the selection to `/api/data`; the server already returns a scoped report and caches by
  signature. The mock report ignores scope and must say so.
- The header's period line reports the scoped window, not the whole spool.
- Keep the existing guard that skips a poll repaint while a dialog is open.

### Phase 2: Deeper change comparison

- On each marked change that has a comparison, add the before/after value of one headline metric
  using `POST /api/telemetry/analysis` with the change's `marker_id`. Reuse the existing
  confidence and evidence-floor language; show counts instead of a percentage below the floor.
- Add task-type and time-window comparison controls before the page suggests switching a model or
  package, because current associations cannot separate a setup effect from different work.

### Phase 3: Decision flow

From the review's recommended iteration:

1. Fold condition signals into Action items so there is one prioritized decision list.
2. Add "Record what I tried" beside an investigated finding, prefilled with its scope and watched
   problem.
3. Collapse the event ledger behind a recent-changes summary if the page stays long in normal use.
4. Present full outcomes as stacked comparisons on narrow screens.

### Phase 4: Endpoint disposition

| Endpoint | Proposed disposition |
| --- | --- |
| `/api/data` scope parameters | Keep; Phase 1 uses them |
| `POST /api/telemetry/analysis` with `marker_id` | Keep; Phase 2 uses it |
| `POST /api/telemetry/analysis` two-cohort path | Remove unless Phase 2 needs combined filters |
| `/api/telemetry/experiments*` | Remove the HTTP routes and their `test-cli.sh` assertions; the CLI is unaffected |
| `/api/insights-llm` | Remove the portal route; the CLI's separate `runDeepRead` call stays |

### Phase 5: Code health

From the review's remaining opportunities:

- Finish moving the older investigation and session markup out of `portal/tokens/app.js` into
  HTML templates and focused modules; the file still exceeds the size guideline.
- Show repository owner or path only when two display names collide in a selector.
- Replace broad ID and class selectors in older portal tests with role and name locators.
- Display `data_quality.findings_lost_to_fallback`, which the report returns but the page does not.

Profiling condition-payload size on large spools moved to [[telemetry-analyze-single-pass-perf]],
which already owns analysis cost.

## Implementation checklist

- [ ] Phase 1: range, harness, and model controls wired to `/api/data`, URL-serialized
- [ ] Phase 1: repository control through the shared selector once [[tk6s43x3]] lands
- [ ] Phase 2: headline-metric before/after on marked changes
- [ ] Phase 2: task-type and time-window comparison controls
- [ ] Phase 3: single prioritized decision list
- [ ] Phase 3: "Record what I tried" from a finding
- [ ] Phase 3: ledger collapse decision and narrow-screen full outcomes
- [ ] Phase 4: remove or keep each endpoint per the table, with tests updated to match
- [ ] Phase 5: code-health items

## Validation

- `node scripts/test/portal-ui/run.mjs` covers each new control: scoped request, URL round trip,
  and a poll that preserves the selection.
- `bash scripts/test/test-cli.sh --quiet` stays green after any endpoint is removed, with its
  assertions removed in the same change.
- `node scripts/test/telemetry-conditions-presentation-check.mjs` and the telemetry suite confirm
  analysis semantics are unchanged.
- `bash scripts/doctor.sh --quiet` and `git diff --check` before handoff.

## Risks

- Scope controls multiply cached report variants. Mitigation: reuse the signature-based cache and
  confirm memory stays bounded with a repository, harness, and model combination.
- A headline metric beside a change can read as proof of effect. Mitigation: reuse the
  association-only wording and show counts below the evidence floor.
- Removing endpoints may break an undocumented caller. Mitigation: search the repository and the
  CLI before each removal and keep the change separately revertable.

## Open questions

- Which metric leads on a change card: `tokens.total`, `tokens.delta_per_call`, or a per-change
  choice? The registry supports all of them; the page has room for one.
- Should the time range default to all time, as today, or to a trailing window?
- Are the experiment routes wanted by anyone outside this repository's own portal? None found
  in-repo.
