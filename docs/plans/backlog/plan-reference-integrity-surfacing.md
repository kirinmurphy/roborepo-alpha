---
id: p3vbk03v
priority: medium
next_action: Add the DOC_LINK_NOT_FOUND finding and its extraction rule, scoping out fenced blocks and unchecked-task forward references so the live tree reports zero findings
blocked_by: []
depends_on: []
related:
  - 5qrzhfgu
reviewed_commit: 6ad2b6778ec406a3e03cf0a1c94bcbd1d43bef3c
---

# Surface Plan Reference Integrity Where Plans Are Edited

## Summary

Plan-doc reference integrity is almost entirely built and almost never run. The validation engine
already resolves every `depends_on`, `related`, and `blocked_by` id across all discovered
repositories and reports dangling ones as structured findings. What is missing is smaller and more
specific than it first appears:

1. Nothing validates the **file paths plans cite in prose**, so links to other docs rot silently.
   Auditing this repository found one such stale path in a live plan (since fixed) and eleven in
   `completed/`. The audit also surfaced four path-shaped strings that must *not* be reported, which
   turns out to constrain the design more than the true positives do.
2. There is no way for a user to **ask for validation on demand** — the `roborepo plans` namespace
   exposes only `repair`, and the portal surfaces findings only for plans a user happens to look at.
3. This repository's own `test:plans` suite runs the engine exclusively against synthetic fixtures
   in `mkdtemp`, so it proves the engine *can* detect breakage but never checks that this
   repository's 87 plans are actually intact.

This plan closes those three gaps without rebuilding what exists. The largest piece of work — the
cross-repository id graph — is already shipped and correct.

## Why this is not a CI feature

The obvious framing is "add a CI step." That framing is wrong here, and naming why prevents the
work from being rebuilt in the wrong place.

`plan-write` is a package this repository *ships to other repositories*. A CI job in roborepo would
validate roborepo's own plans and do nothing for any repository that installs the package — the
value would be built in the one location where it does not generalize. The validation engine is
already a runtime capability with a portal UI and a multi-repository snapshot; the gap is not a
missing checker but a missing moment at which the existing checker gets pointed at real trees.

Cadence follows from that. Plan-doc breakage is **edit-driven, not time-driven**: a reference breaks
the moment a plan is renamed, moved, or deleted, and between edits a rescan reports the same result
it reported last time. A background sweep on an interval would therefore spend most of its runs
re-reporting stale news while adding scheduling, state, and a surface for findings nobody requested.
The two moments that carry real signal are **when a user asks** and **when a mutation happens**.

## Current state

Verified against `6ad2b67`.

### Already built — do not rebuild

- `buildPlanSnapshot()` (`modules/plan-suite/index.mjs:164`) discovers every repository under the
  configured roots and returns all plans with validation attached. Multi-repository is not a future
  feature; it is the existing default.
- `relationshipFindings()` (`modules/plan-suite/index.mjs:769`) resolves `depends_on`, `related`, and
  `blocked_by` against a `${repositoryRoot}:${id}` map, so ids are correctly scoped per repository
  rather than globally. It emits `DUPLICATE_PLAN_ID`, `SELF_DEPENDENCY`, `DEPENDENCY_NOT_FOUND`,
  `RELATED_NOT_FOUND`, and `BLOCKER_NOT_FOUND`, and it already exempts external blockers.
- `modules/plan-suite/findings.mjs` holds a 34-code catalog with `kind`, `severity`, `message`, and
  `resolution`. Its header documents the extension contract: add a `DEFS` entry, then emit it from a
  validator. Findings flow unchanged into `plan.validation.findings`, the `LIFECYCLE_REQUIREMENTS`
  422 body, and the generated repair prompt.
- The portal reads findings: `portal/plans/state.js` filters on `has warnings` and splits blocking
  from advisory findings on a rejected move.
- `roborepo plans repair <root>` exists (`scripts/cli/plans.mjs:113`), scaffolding missing
  frontmatter. Commands are registered through manifests
  (`manifests/platform/cli/command-definitions/internal/plans.namespace.json`), not hardcoded in
  `main.mjs`.

### The actual gaps

| Gap | Evidence |
| --- | --- |
| No finding code for a referenced file path | All 34 codes in `findings.mjs` concern frontmatter, sections, lifecycle, parse errors, or plan-to-plan ids. None resolve a path. |
| No on-demand validate command | `plansCommand()` accepts only `repair`; anything else exits 2. |
| Repository's own plans never validated | `scripts/test/plan-suite-check.mjs` contains no reference to the repository root; every case builds fixtures under `mkdtemp`. |
| Mutations do not check inbound references | `movePlanLifecycle()` validates the destination lifecycle, not what still points at the plan. |

### Known-broken links today

None. A naive scan of live lifecycles (`backlog/`, `active/`) reported five unresolvable paths;
inspecting each one showed **four were false positives and one was genuinely stale**. That ratio is
the single most important input to this design, so the cases are recorded here rather than
summarized.

| Cited path | Source | Verdict |
| --- | --- | --- |
| `docs/plans/portal-react-vite-scaled-plan.md` | `backlog/portal-lit-native-scaled.md` | **Genuine.** The file had moved to `archived/`. Fixed by correcting the path. |
| `docs/user/reference/sessions.md` | `backlog/session-launching-milestone-{1,2,3}.md` | False positive. Every occurrence is an unchecked `- [ ]` task reading "Add"/"Update" that file. It does not exist because the work is not done. |
| `docs/plans/backlog/example.md` | `backlog/session-launching-milestone-1.md` | False positive. A `planRelativePath` value inside a fenced JSON payload sample. |

Eleven more sit in `completed/`, which is frozen history and out of scope.

These cases define the rule far more precisely than an abstract specification would:

- **A path inside a fenced block is data, not a reference.** The `example.md` case is a JSON field
  value; treating it as a link is simply wrong.
- **A path inside an unchecked task item is a forward reference.** Plans routinely name files they
  intend to create. Flagging those inverts the meaning of a to-do list and would fire on nearly every
  well-written plan — the noisiest possible failure mode.
- **A path in ordinary prose is a real reference** and is the only case worth reporting.

A validator that ignored these distinctions would produce four false alarms for every true finding.
At that ratio the check gets muted, and a muted check is worse than none because it looks like
coverage. Scoping is therefore not a refinement of this feature; it is the feature.

Most `completed/` breakage traces to the rename batch recorded in
`plan-identity-and-reference-integrity` (`5qrzhfgu`), whose checklist marks "grep for the old
basename and fix prose references" as done. It was not fully done, which is precisely the failure
mode an automated check exists to prevent.

## Goals

- Detect a cited document path that does not resolve, at the moment it breaks.
- Let a user validate plans on demand in any repository that installs `plan-write`.
- Keep this repository's own plan tree verified without pretending fixture tests already do it.
- Add no scheduled background scanning.

## Non-goals

- Anchor (`#heading`) resolution. Only one anchor-bearing reference exists repo-wide today; the
  machinery is not yet earning its cost. Revisit if anchor use grows.
- Validating external URLs. That requires network access and turns a deterministic check into a
  flaky one.
- Repairing `completed/` and `archived/` plans. They are historical records; a broken link there is
  accurate history.
- Rebuilding id-graph validation in any form.

## Proposed design

### 1. `DOC_LINK_NOT_FOUND`

Add one finding to `findings.mjs` following the documented contract:

```js
DOC_LINK_NOT_FOUND: {
  kind: "reference",
  severity: "advisory",
  message: ({ meta }) => `Referenced document not found: ${meta.target}.`,
  resolution: "Correct the path, point it at a durable reference doc, or remove the reference.",
},
```

`kind: "reference"` is a new group, distinct from `relationship` (plan-to-plan ids) because the
resolution differs: a dangling id means a plan vanished, a dangling path means a document moved.

Severity is advisory, matching every existing relationship finding. A broken prose link should not
block a lifecycle move.

### 2. Extraction scope

The three verified cases above dictate the rule. Extract candidate paths only from:

- Markdown links: `[text](path.md)`
- Inline code spans containing a path ending in `.md`

and then filter out:

- anything inside a fenced code block, which is illustrative rather than referential;
- anything inside an unchecked task item (`- [ ]`), which is a forward reference to a file the plan
  intends to create;
- external URLs (`http://`, `https://`);
- paths whose target lies outside the repository root after resolution.

Resolve both repository-root-relative paths (`docs/reference/...`) and document-relative ones
(`../completed/foo.md`), since plans in this repository use both.

Run the validator only for plans in `backlog/` and `active/`. Lifecycle is already available on the
plan record, so this is a filter, not new plumbing.

### 3. `roborepo plans validate [root]`

Extend `plansCommand()` with a `validate` subcommand. It builds the snapshot, filters to plans
carrying findings, and prints them grouped by repository and plan. Default to the current repository;
accept an optional root for a single-repository run.

Exit non-zero when any finding is present so the command is usable as a check in whatever CI a
consuming repository happens to have — supporting that use without owning it.

Keep `plansCommand()` an orchestrator: it parses arguments and dispatches. Snapshot loading stays in
`loadPlansSnapshot()`; formatting belongs in its own function, and in its own file if it grows past
roughly a screen. `scripts/cli/plans.mjs` is 131 lines and should stay well inside the ~200-line cap.

The command needs no manifest change — `plans.namespace.json` already routes the namespace.

### 4. Check inbound references at mutation time

Where `movePlanLifecycle()` already validates a destination, also report plans whose `depends_on`,
`related`, or `blocked_by` point at the plan being moved. The snapshot needed to answer this is
already in hand, so this is a reverse lookup over data already loaded, not a new scan.

This is the highest-leverage placement: it catches breakage as it is created rather than by a later
sweep, and it is the exact gap that let the `5qrzhfgu` rename batch leave 11 dangling links behind.

Deletion is deliberately excluded. Plans are deleted with `git rm` and no code path owns that today;
adding one is a larger change than this plan should absorb.

### 5. Validate this repository's own plans

Add a case to the existing suite that runs `buildPlanSnapshot()` against the real repository root
and asserts no `DUPLICATE_PLAN_ID`, `DEPENDENCY_NOT_FOUND`, `RELATED_NOT_FOUND`, or
`BLOCKER_NOT_FOUND`. This passes today — all 87 plans resolve — so it starts green and stays honest.

`DOC_LINK_NOT_FOUND` also starts green: the one genuine stale path was fixed while writing this
plan, and the other four reported paths were false positives the scoping rules must exclude by
design. No baseline or suppression list is needed — which is the desired end state, since a
suppression list is where rot hides.

This makes the false-positive cases the primary test material. Each one becomes a fixture asserting
the validator stays silent, so the scoping rules cannot regress unnoticed.

Prefer a repo-native scoped command over expanding `npm test`. The suite is
`scripts/test/plan-suite-check.mjs`, run via `npm run test:plans`.

## Open decisions

- **Whether unchecked-task exclusion should be lifecycle-aware.** A `- [ ]` item naming a
  nonexistent file is correct in `backlog/`, but the same line in `completed/` means the plan claims
  done work that left no artifact. That is a genuine signal, though it belongs to completion
  verification rather than link checking, and `completed/` is out of scope here.
- **Whether `validate` should offer `--fix`.** A dangling id cannot be auto-corrected safely, but an
  unresolvable path sometimes can when the file clearly moved. Out of scope until the read-only
  command has been used enough to show the pattern.

## Validation

- `npm run test:plans` passes, including the new real-repository case.
- `roborepo plans validate` in this repository reports no findings of any kind, confirming the
  scoping rules suppress all four known false-positive shapes.
- Introducing a deliberate dangling `related` id causes a non-zero exit; reverting restores zero.
- A plan citing `../completed/<real-file>.md` produces no finding, confirming document-relative
  resolution.
- A `.md` path inside a fenced code block produces no finding, confirming the `example.md` case
  stays clean.
- Moving a plan that another plan depends on reports the inbound reference.
- `bash scripts/doctor.sh --quiet` stays green.

## Implementation plan

- [ ] Add `DOC_LINK_NOT_FOUND` to `modules/plan-suite/findings.mjs` with `kind: "reference"`.
- [ ] Write path extraction as a named, independently testable function: takes markdown plus the
      plan's directory, returns resolved candidate targets, excludes fenced blocks and URLs.
- [ ] Emit the finding from the validator for `backlog/` and `active/` plans only.
- [ ] Add fixture cases: repository-root-relative hit, document-relative hit, fenced-block
      exclusion, unchecked-task exclusion, URL exclusion, `completed/` exemption.
- [ ] Add the real-repository relationship assertion to `scripts/test/plan-suite-check.mjs`, plus an
      assertion that the live tree reports zero `DOC_LINK_NOT_FOUND`.
- [ ] Add `validate` to `plansCommand()` with grouped output and a non-zero exit on findings.
- [ ] Report inbound references in the lifecycle-move path.
- [ ] Document `roborepo plans validate` wherever `plans repair` is currently documented.
