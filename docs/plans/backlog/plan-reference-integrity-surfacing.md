---
id: p3vbk03v
priority: medium
next_action: Add scoped advisory document-link validation to the existing plans validator, first characterizing current real-tree tests and transition stale-link coverage.
blocked_by: []
depends_on: []
related: ["5qrzhfgu"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Surface Plan Reference Integrity Where Plans Are Edited

## Summary

Add scoped document-path integrity findings to the existing plan validator, and close any remaining
real-tree and move-time reference gaps without rebuilding plan-ID validation or its CLI.

## Context

`modules/plan-suite/index.mjs` already validates plan-ID relationships. The canonical command is
`roborepo plans validate [<plan>] [--json]`, implemented in `scripts/cli/plans-command.mjs`.
The validate command exits nonzero for blocking findings. Transition gates have their own
kind/code filters and do not generally ignore advisory severity; characterize them separately. Atomic transition commands also report stale links; characterize their
current coverage before adding reverse lookups.

`DOC_LINK_NOT_FOUND` is not in `modules/plan-suite/findings.mjs`. Local prose document paths remain
a distinct check. Old audit counts and zero-finding claims are not a baseline: existing legacy-ID
and structure advisories are valid independent findings.

## Goals

- Detect broken local document references in actionable plans when requested or during owned edits.
- Keep false positives from examples and intended new files out of the finding stream.
- Exercise actual repository relationship integrity as well as synthetic validator fixtures.

## Proposed design

Add advisory `DOC_LINK_NOT_FOUND` with target and resolution metadata through the existing finding
catalog and snapshot flow. Initially inspect backlog and active plans; keep completed/archived
records historical. Ready/review coverage remains an explicit scope decision before promotion.

| Extract | Exclude |
| --- | --- |
| Markdown links to local `.md` files | Fenced examples, external URLs, and paths outside the repository |
| Inline-code local paths ending in `.md` | Unchecked task forward references to intended new files |
| Document-relative and repository-relative targets | Anchor validation and external URL availability |

Use the current CLI selector contract; do not add a second validate command. Define the proposed
link finding as non-gating explicitly in transition policy, because advisory severity alone does
not exempt a destination finding from current lifecycle gates. Inspect existing transition `staleLinks` behavior and add only
missing inbound prose-path coverage. Stable ID references do not break merely because a plan moves.

## Implementation plan

- [ ] Add the advisory finding and a pure, independently testable path extractor/resolver.
- [ ] Pin repository-relative/document-relative success, broken paths, fenced examples, URLs,
      unchecked forward references, and outside-root exclusion with fixtures.
- [ ] Emit findings for selected actionable lifecycles through the existing validation flow and
      test the explicit transition-policy treatment so the new link advisory remains non-gating.
- [ ] Inspect current real-tree tests and add only missing assertions for duplicate/dangling IDs
      and the new document-path finding; do not require zero unrelated advisory findings.
- [ ] Characterize transition stale-link reporting, then add missing inbound path coverage without
      duplicating existing stable-ID relationship checks.
- [ ] Document advisory severity, lifecycle scope, selector behavior, and safe manual repair.

## Validation

```sh
node scripts/test/plan-suite-check.mjs
node scripts/test/plan-suite-findings-check.mjs
node scripts/test/plan-suite-commands-check.mjs
node scripts/cli/main.mjs plans validate --json
```

A new broken local document link must emit the advisory. Removing it clears that finding. Existing
blocking findings still control exit status; intentional legacy IDs remain valid. Forward references
and historical records do not create false alarms. Measure the actual repository rather than
asserting a historical plan count. Use responsibility and testability to place code, not file size.

## Documentation impact

Update `docs/user/reference/plans-portal.md`, `docs/user/reference/roborepo-cli.md`, and
`docs/internal/plans-portal-internals.md` with finding scope and severity.

## Open questions

- Should ready/review plans be checked initially or in a later extension?
- Is safe path-repair assistance valuable after read-only findings have proven useful?
