---
id: 5qrzhfgu
priority: high
next_action: Decide whether to extend filename normalization to `docs/plans/completed/`, where 19 files still carry a `-plan` suffix or a `roborepo-` prefix. Backlog filenames are done, reference integrity is enforced, and the id convention is adopted for new plans.
blocked_by: []
depends_on: []
related:
  - skills-vs-commands-invocation-policy
reviewed_commit: 6c94691
---

# Durable Plan Identity and Reference Integrity

## Summary

A plan has three names — its filename, its H1, and its `id` — and they serve different jobs. The
first two describe the work and are expected to change as it evolves. The third identifies the plan
and must never change, because every `related`, `depends_on`, and `blocked_by` entry resolves
against it.

This plan separates those roles and makes the separation enforceable:

- filenames follow the namespace convention declared in `docs/plans/plans-config.json`;
- ids become short opaque strings, so they cannot drift as the work is split or rescoped;
- every id-bearing field is resolved against the plan graph, so a reference pointing at nothing is
  reported rather than discovered by accident.

Renaming is deliberately not automated: a filename is a link target, and plans reference each other
in prose as well as in frontmatter.

## Context

An audit of `docs/plans/backlog/` found 30 plans, of which 19 deviated from the convention. Four
more plans landed after that audit, bringing the backlog to 34 and the rename set to 21. Three
recurring patterns:

- **Redundant `-plan` suffix** (6 files). Everything under `docs/plans` is a plan.
- **Status encoded in the filename** (`-todo`, `-followups`). Status belongs in frontmatter;
  filenames get linked to and should not change when status does.
- **No namespace, or a namespace that misdescribes the work.** The clearest case is the three
  `plan-terminal-session-launching-milestone-*` files: the `plan-` prefix means the plan-docs
  system, but these are about agent session launching.

## Goals

**Filenames**

- Every plan filename starts with a namespace from the universal set or `plans-config.json`.
- No filename carries a `-plan` suffix or encodes status.

**Identity**

- Frontmatter `id` values are unchanged by any rename, so inbound references keep resolving.
- No duplicate `id` values remain.
- New plans get an opaque short id that cannot drift as the work is renamed, split, or rescoped.
  Existing slug ids stay as they are — rewriting one breaks every reference pointing at it.

**Reference integrity**

- Every `depends_on`, `related`, and `blocked_by` entry resolves to a plan that exists, or is
  explicitly marked as an external blocker.
- Both YAML list syntaxes parse, so a reference is never silently dropped for being written in the
  form the parser happened not to implement.

**Bootstrapping**

- A repository with no `plans-config.json` gets one, derived from its own code and existing plans
  rather than copied from elsewhere.

## Bootstrapping a repository with no config

This repository already has `docs/plans/plans-config.json`. Most will not, and the convention is
useless without one — the universal namespaces alone cannot describe a project's domains.

When a rename or a new-plan request runs against a repository with no config, do not silently fall
back to universal namespaces or invent prefixes. Instead:

1. **Say the config is missing** and that namespaces are about to be guessed rather than read.
2. **Propose an initial vocabulary from evidence**, not from a template. Good sources, in order of
   signal strength:
   - top-level source directories (`modules/`, `portal/`, `packages/`) — these usually *are* the
     domains;
   - CLI namespaces or command groups the project already exposes;
   - recurring prefixes across existing plan filenames, which show the vocabulary the team has
     already been reaching for;
   - directory names under the docs tree.
3. **Show the evidence for each proposed namespace** — "`portal` because `portal/` has five
   surfaces and six plans already start with it" — so the user can judge rather than accept.
4. **Ask the user to refine before writing.** Namespaces are a controlled vocabulary; one chosen
   badly gets copied into every future filename. Expect to merge overlapping proposals, drop ones
   that are really a single plan, and rename to the project's own words.
5. **Write only the agreed set**, keeping the config to values (`schemaVersion` + `namespaces`).
   Rules live in the `plan-docs` skill, not in per-repository config.

Only then proceed to renames. Renaming against a guessed vocabulary produces a second cleanup pass.

## Non-goals

- Renaming plans outside `docs/plans/backlog/`. Active and completed plans can follow once the
  convention is proven here.
- Changing plan content beyond the H1 when it merely restates a filename.
- Automating the renames.

## Current state

### Resolved: duplicate id

`portal-homepage-plus-repository-scope-filtering.md` was a byte-identical, untracked copy of
`portal-homepage-repository-section.md`, sharing the id `portal-repository-scope-and-homepage`. It
was a leftover from a rename rather than a second plan, and has been deleted. No duplicate ids
remain across `docs/plans/`.

### Rename candidates

| Current | Proposed | Reason |
| --- | --- | --- |
| `harness-presence-signal-expansion-plan` | `harness-presence-signal-expansion` | redundant suffix |
| `portal-homepage-implementation-plan` | `portal-homepage-implementation` | redundant suffix |
| `portal-lit-native-scaled-plan` | `portal-lit-native-scaled` | redundant suffix |
| `roborepo-packaging-distribution-plan` | `infra-packaging-distribution` | redundant suffix; `roborepo-` restates the repository (since split into `infra-packaging-01`…`04`; the renamed file no longer exists) |
| `windows-provider-path-schema-plan` | `os-windows-provider-path-schema` | redundant suffix; OS-specific work |
| `wrap-up-coderabbit-integration-plan` | `agent-config-wrap-up-coderabbit` | redundant suffix; wrap-up is harness config |
| `harness-parity-todo` | `harness-parity` | `-todo` encodes status |
| `native-skill-tooling-followups` | `agent-config-native-skill-tooling` | `-followups` encodes status |
| `codex-cmux-hook-trust-review` | `agent-config-codex-cmux-hook-trust` | hook trust is harness config |
| `skill-reference-docs-and-conventions` | `agent-config-skill-reference-docs` | skill authoring is harness config |
| `skills-vs-commands-invocation-policy` | `agent-config-skills-vs-commands-policy` | skill/command policy is harness config |
| `plans-portal-live-refresh-and-static-preflight` | `portal-plans-live-refresh` | portal surface work |
| `web-portal-browser-tab-reuse` | `portal-browser-tab-reuse` | `web-portal` is the `portal` namespace |
| `usage-statusline-claude-refresh` | `usage-statusline-claude-refresh` | already conforms — `usage-statusline` is a project namespace |
| `usage-statusline-codex-hook-parity` | `usage-statusline-codex-parity` | `-hook-` is incidental; the namespace is already correct |
| `user-managed-packages-and-add-workflows` | `package-user-managed-and-add-workflows` | package system work |
| `plan-terminal-session-launching-milestone-1` | `session-launching-milestone-1` | `plan-` means the plan system; this is session launching |
| `plan-terminal-session-launching-milestone-2` | `session-launching-milestone-2` | see milestone-1 |
| `plan-terminal-session-launching-milestone-3` | `session-launching-milestone-3` | see milestone-1 |

### Added after the audit

Four plans landed after the audit table was written. `harness-capability-derived-resource-targeting`
already conformed. The other three were folded into the declared vocabulary rather than growing
`plans-config.json` with `antigravity`, `manifest`, and `permissions` prefixes:

| Current | Proposed | Reason |
| --- | --- | --- |
| `antigravity-cli-provider-integration` | `harness-antigravity-cli-integration` | provider integration is harness work |
| `manifest-tsv-provider-consolidation` | `harness-manifest-tsv-consolidation` | provider manifests are harness work |
| `permissions-ui-revamp` | `agent-config-permissions-ui-revamp` | permissions are harness config |

### Already conforming

`git-exec-consolidation`, `package-cli-test-guide`, `package-registry-live-state-reconciliation`,
`developer-runtime-metadata-suggestions`, `developer-runtime-remote-branch-status`,
`portal-homepage-repository-section`, `telemetry-analyze-single-pass-perf`,
`plan-integration-check-determinism`, and the three `plan-lifecycle-suite-*` files.

## Implementation plan

### Filenames

- [x] Resolve the duplicate-id conflict.
- [x] Add the missing-config bootstrap flow to the `plan-docs` skill. Already satisfied: the
      "When no project config exists" section of
      `globals/packages/plan-docs/skills/plan-docs/references/plan-schema.md` implements the
      propose-and-refine sequence, including evidence sourcing and the ask-before-writing step.
      No skill edit was needed.
- [x] Rename the six redundant-suffix files. Lowest risk: the namespace does not change.
- [x] Rename the status-encoding files (`-todo`, `-followups`).
- [x] Rename the files whose namespace changes, which is where inbound references are most likely
      to break.
- [x] Rename the three post-audit plans into the declared vocabulary.
- [x] After each batch, grep for the old basename across `docs/` and fix prose references.
      Confirmed: frontmatter `related`/`depends_on` use `id`, so none needed editing. Code comments
      did — `scripts/cli/harness.mjs`, `scripts/test/harness-cli-check.mjs`,
      `scripts/test/usage-statusline-check.mjs`, and
      `globals/packages/usage-statusline/README.md` all carried plan paths.
- [x] Update any H1 that merely restates its filename.

### Reference integrity

- [x] Resolve `related` and `blocked_by`, not just `depends_on`. `relationshipFindings` only
      checked dependencies, so a wrong id in the other two fields pointed at nothing and no one
      noticed. Added `RELATED_NOT_FOUND` and `BLOCKER_NOT_FOUND`.
- [x] Fix the ten dangling references this surfaced across 81 plans. Seven pointed at ids that were
      close but wrong; one pointed at a plan deleted in `ea341ec`.
- [x] Parse inline arrays (`related: [a, b]`). The parser reported `UNSUPPORTED_INLINE_ARRAY` and
      then emptied the field, so 13 valid references across 12 plans never reached the graph. Both
      YAML list forms now parse, splitting on commas outside quotes.
- [x] Allow external blockers. `blocked_by` may carry a non-plan entry marked `upstream:`,
      `external:`, `vendor:`, or `decision:`; unprefixed entries still resolve as plan ids.

### Identity

- [x] Adopt opaque short ids for new plans: 6-8 lowercase base36 characters, generated rather than
      derived from the filename. `modules/plan-docs/plan-id.mjs`.
- [x] Keep the legacy path to one branch. `classifyPlanId()` checks the current format first and
      returns `short`; a hyphenated slug falls through to a branch marked `LEGACY(slug-ids)` and
      returns `legacy`, reported as the informational `LEGACY_SLUG_ID`. Ordering matters — a short
      id also satisfies the slug pattern, so a slug-first check would misreport every new id.
- [x] Stop `repair.mjs` minting slug ids from filenames, which was a second source of the old
      format.
- [x] Document the convention and its reasoning in the `plan-docs` skill.
- [x] Decide the fate of the remaining slug ids. Resolved: they stay. See "Legacy ids are permanent,
      not transitional" below — converting them was dropped as a non-goal rather than left as
      standing work.

## Decisions made during execution

- **Historical references left intact.** `docs/plans/completed/primary-todo.md` names
  `harness-parity-todo.md` and `skills-vs-commands-invocation-policy.md` at lines 351, 381, and 382.
  That is a completed plan describing repository state as it was, not a live link, so rewriting it
  would falsify the record. Left deliberately; not a missed reference.
- **Two dangling id references fixed.** `completed/discoverable-harness-provider-architecture-plan.md`
  and `backlog/portal-homepage-repository-section.md` both listed
  `plan-terminal-session-launching-milestone-1` under `related`, but no plan has ever carried that
  id — the real one is `plan-session-launching-milestone-1`. Pre-existing breakage, unrelated to
  renaming, corrected here and called out in its commit.
- **Ids intentionally diverge from filenames.** Several files now carry an `id` that no longer
  matches their name (`portal-lit-native-scaled.md` has `id: portal-lit-native-scaled-plan`). This
  is the rule working as designed: ids are durable identifiers, and regenerating them would break
  every inbound `related` and `depends_on`.
- **Opaque ids chosen over readable slugs.** A descriptive id makes a promise it cannot keep — plans
  get split, rescoped, and renamed, and an id that follows would break its references. The counter
  argument was that readable ids make references auditable by eye; that turned out to be a
  convenience, not a safety property, once every field is resolved against the plan graph. A format
  check rejects a malformed id but passes a well-formed one pointing at nothing.
- **This plan's own id was changed**, from `docs-plan-filename-normalization` to `5qrzhfgu`, when it
  was renamed. That is an exception to the never-rewrite-an-id rule, taken only because a grep
  confirmed nothing referenced it. It is not precedent: any plan with even one inbound reference
  keeps its slug id.
- **Legacy ids are permanent, not transitional.** The original task was to convert slug ids
  opportunistically — only plans with no inbound references — and delete the legacy branch once none
  remained. That is unfinishable as stated: of 80 legacy plans, 41 are referenced
  in frontmatter across 116 reference edges, so under a never-touch-a-referenced-id rule the count
  cannot reach zero. Converting only the 22 unreferenced plans would move the counter to 58 without
  bringing the markers any closer to deletion, while churning the frontmatter of dormant plans.

  Decision: slug ids remain valid indefinitely. New plans use short ids; the two `TEMP` markers
  stay. The tiering still earns its keep — it keeps the legacy path to one branch and one
  informational finding, and documents the convention boundary for any future reader — it just is
  not a migration in progress. The alternative, a bulk rewrite of all 116 edges in lockstep, is
  exactly the expensive migration that choosing coexistence was meant to avoid.

  `LEGACY_SLUG_ID` therefore measures composition, not remaining work.
- **Inline arrays fixed rather than banned.** `plan-docs-and-plans-portal-plan` deferred them
  "unless a full YAML parser is adopted". Implemented as the narrow case instead — both list forms
  are valid YAML that authors keep writing, and rewriting the 13 affected files would have reset the
  counter without stopping the next occurrence.

## Validation

- [x] `git mv` for every rename, so history follows the file. All 21 showed as `R` in `git status`.
- [x] No `id` value changes: `git diff` over each batch showed no changed `id:` line. The only
      frontmatter edits were the two dangling-reference fixes above.
- [x] No duplicate ids remain across `docs/plans/`.
- [x] `npm run test:plans`, `npm run test:plans-findings`, and `npm run test:plans-portal-state` pass.
- [x] Grep the repository for each old basename; remaining hits are only `id:` values, frontmatter
      ids, this plan's own rename tables, and the intentional `primary-todo.md` history.
- [x] Every backlog filename starts with a namespace from `plans-config.json` or the universal set.
- [x] Zero unresolvable references across all 81 plans, checked by resolving every `depends_on`,
      `related`, and `blocked_by` entry against the snapshot.
- [x] `UNSUPPORTED_INLINE_ARRAY` is gone (13 → 0) and the 13 references it was hiding all resolve.
- [x] `npm run test:plans-repair` passes; regression tests cover the tiered id classifier, generated
      id format and uniqueness, all three reference fields reporting independently, and external
      blockers being skipped rather than reported missing.

## Risks

- **Broken inbound links.** Prose references filenames; frontmatter references ids. Only the former
  breaks on rename, and only a grep will find them.
- **Renaming plans another session has open.** A rename mid-session leaves the other context
  pointing at a path that no longer exists. Prefer a quiet moment.
- **Churn for its own sake.** Several already-conforming names differ only stylistically. Leave
  those alone; the goal is a working vocabulary, not uniformity.
