# Plan Schema

Managed plans live under `docs/plans`.

Lifecycle is derived from folders, not frontmatter:

- `docs/plans/backlog`
- `docs/plans/active`
- `docs/plans/completed`
- `docs/plans/archived`

Files directly under `docs/plans/*.md` are `unclassified`. Show them and recommend moving them; do not treat them as backlog.

Recommended frontmatter:

```yaml
---
id: a3f9c2k1
priority: high
next_action: Implement the next concrete task
blocked_by: []
depends_on: []
related: []
reviewed_commit:
worktree:
---
```

Rules:

- `id`: a short opaque base36 string, 6-8 lowercase alphanumerics, unique within the repository and
  never changed once written. See "Plan ids" below.
- `priority`: `high`, `medium`, `low`, or `none`.
- `next_action`: required for ready backlog plans and active plans; empty for completed and archived plans.
- `blocked_by`, `depends_on`, and `related`: arrays.
- `reviewed_commit`: commit intentionally reviewed against repository state; empty means never reviewed.
- `worktree`: optional. Git's administrative name for the one linked worktree implementing this plan
  — the final segment of that worktree's per-worktree gitdir (`.git/worktrees/<name>`), which
  `git worktree list --porcelain` does not print directly; read it from the worktree's `.git` file
  or `git rev-parse --git-dir`. Never an absolute path and never a branch name: the value is
  repository-local and survives branch switches. Empty or absent means unassociated, which is valid
  in every lifecycle — planning, blocked, and manually managed work need no worktree. Main
  checkouts have no administrative name and cannot be named here. `plan-start` records it when
  implementation begins in a linked worktree; see "Worktree association" below.

## Worktree association

New plans and repaired frontmatter carry an empty `worktree:` line. Historical plans without the
line remain valid and are not bulk-migrated.

The field is an exact join key, not a hint. A plan/worktree integration joins an active plan to its
linked worktree's row only when exactly one active plan and exactly one linked worktree in the same
repository share the name. A stale name (the worktree was removed), a duplicate claim, or an empty
value leaves the plan as its own row with a **not started** or **worktree not running** badge; nothing
is inferred from branch names or plan prose.

Write a value only when live Git state proves the relationship — the worktree exists now and this
plan's implementation runs there. A value left behind after the worktree is removed is harmless: it
matches nothing, and only active plans are joined at all.

Do not add `status`, `validated`, `updated_at`, `created_at`, `owner`, `percent_complete`, `estimated_hours`, or `tags` unless a later plan explicitly adds them.

## Plan ids

A plan id is **opaque on purpose**. It identifies the plan; it does not describe it.

Generate one with `generatePlanId()` from `modules/plan-suite/plan-id.mjs`, or take 6-8 characters
from `[0-9a-z]` by any means. Write it once, at creation, and never change it.

The reason it is meaningless is that a descriptive id makes a promise it cannot keep. Plans get
split in two, rescoped, renamed, and moved between lifecycle folders. A filename and an H1 can
follow the story; an id cannot, because every `related` and `depends_on` pointing at it would break.
So the id stops describing and starts merely identifying — and then filename and title are free to
change as often as the work demands.

This means an id will often disagree with its filename, and that is correct, not drift. Nothing
resolves a plan by filename.

Correctness does not rely on ids being readable. Every `depends_on`, `related`, and `blocked_by`
entry is resolved against the plan snapshot, so an id pointing at nothing is reported
(`DEPENDENCY_NOT_FOUND`, `RELATED_NOT_FOUND`, `BLOCKER_NOT_FOUND`) whatever its shape. A format
check cannot do this: it rejects a malformed id but happily passes a well-formed one with two
characters transposed.

### Legacy slug ids

Plans created before this convention carry hyphenated slug ids (`harness-parity`,
`plan-session-launching-milestone-1`). These remain **valid and must not be rewritten** — changing
one breaks every inbound reference, which is the exact failure the durable id exists to prevent.

Validation reports them as `LEGACY_SLUG_ID`, an informational finding recording which convention a
plan uses. Do not "fix" it. New plans use short ids; old plans keep theirs; the two coexist
indefinitely.

This is a permanent split, not a migration in progress. Most plans with a slug id are referenced by
other plans, so converting them would mean rewriting every reference edge in lockstep — the exact
migration that accepting mixed ids exists to avoid. Treat the finding as describing composition,
never as a backlog of work to clear.

## Naming

A plan filename is `<namespace>-<slug>.md`, lowercase and hyphenated.

### Rules

- Never suffix a filename with `-plan`. Everything under `docs/plans` is a plan.
- Never encode lifecycle, priority, dates, or status in a filename (`-todo`, `-followups`,
  `-active`, `-v2`). Lifecycle is the folder; the rest is frontmatter. Filenames get linked to;
  status changes.
- Keep the slug specific enough to disambiguate from siblings in the same namespace.
- A milestone or suite series shares a prefix plus an ordinal: `<namespace>-<series>-<n>`.
- The H1 is prose for a reader — normal capitalization and spacing, naming the outcome. It is not
  the filename with the hyphens removed, and it should not restate the namespace.
- **`id` never changes when a filename changes.** It is opaque and durable by design, so a rename
  is a pure filename operation — see "Plan ids" above. Never regenerate an id to match a new
  filename; that breaks every `related` and `depends_on` pointing at it.

### Universal namespaces

These apply to most software projects and need no per-repository declaration:

| Namespace | Covers |
| --- | --- |
| `cli` | Command-line surface: commands, arguments, help output, interactive menus |
| `git` | Git operations, branch and worktree models, merge and history behavior |
| `infra` | Build, release, packaging, distribution, dependency and environment management |
| `os` | Operating-system-specific behavior: path semantics, platform detection, per-OS support |
| `test` | Test harness, fixtures, coverage, CI verification strategy |
| `docs` | Documentation systems, reference material, authoring conventions |
| `security` | Trust boundaries, permissions, secrets handling, supply-chain concerns |
| `perf` | Work whose primary goal is efficiency: latency, memory, cost |

### Project namespaces

Everything above is global. A repository declares only its own domain vocabulary, in
`docs/plans/plans-config.json`:

```json
{
  "schemaVersion": 1,
  "namespaces": {
    "ui": "The local user interface, any surface.",
    "telemetry": "Telemetry capture, classification, metrics, experiments, analysis."
  }
}
```

Read that file before creating or renaming a plan, and treat its keys as the allowed project
prefixes alongside the universal set above.

### Choosing between them

**A project namespace wins whenever it is the more specific fit.** The universal set is a fallback
for work a project has not claimed, not a preferred vocabulary. A project that declares `ui`
should file interface work under `ui`, not `cli`, because the specific namespace is what makes
the plan findable among its siblings.

Prefer the universal namespace only when the work genuinely is generic — cross-cutting Git
mechanics, platform path handling, or build tooling that no project namespace describes better.

If none of the available namespaces fits, propose adding one to the project config rather than
inventing an unlisted prefix — an unlisted prefix is how the vocabulary decays into the ad-hoc
naming this convention exists to replace.

### When no project config exists

Most repositories will not have this file, and the convention is weak without one — universal
namespaces alone cannot describe a project's domains. Do not silently fall back to them, and do not
invent unlisted prefixes.

Instead, say the config is missing, then propose an initial vocabulary **derived from the
repository itself**:

- top-level source directories (`modules/`, `src/`, `packages/`) — these usually *are* the
  domains;
- CLI namespaces or command groups the project already exposes;
- recurring prefixes across existing plan filenames, which reveal the vocabulary the team has
  already been reaching for.

Show the evidence behind each proposal ("`ui` because `ui/` holds five surfaces and six
plans already start with it") so the user can judge it, then **ask them to refine before writing
the file**. A namespace chosen badly gets copied into every future filename, so it is worth one
round of discussion. Expect to merge overlapping proposals and rename to the project's own words.

Write only the agreed set, and keep the file to values — `schemaVersion` and `namespaces`. These
rules stay here in the skill, not in per-repository config.

Until such a file exists, follow the repository's dominant existing convention and say which one
you inferred.

Readiness requires: H1 title, Summary, Goals or desired outcome, Current state or Context, Proposed design or Implementation plan, Validation or acceptance criteria, frontmatter `id`, frontmatter `priority`, and non-empty `next_action`.

Section headings are matched by label against a synonym list, so several common titles satisfy the same requirement — `Purpose` or `Overview` for Summary, `Current behavior` or `Background` for Context, `Implementation checklist`/`sequence`/`phases` or `Proposed behavior` for Proposed design, `Exit criteria` for Validation. The authoritative list is `modules/plan-suite/section-synonyms.mjs`; add to it rather than renaming existing documents.

Completed plans additionally need a `Verification` section with real content under it — evidence the work was checked, or an explicit statement of what was not verified. A bare heading does not satisfy it.

Validation reports each problem as a finding with a stable code, a plain-language message, and a resolution. Findings are advisory by default: moving a plan into a lifecycle whose requirements it does not meet raises `LIFECYCLE_REQUIREMENTS` (422) listing every problem at once, along with a generated repair prompt, but the move can still be confirmed. Nothing here blocks a move outright.

Use Markdown checkboxes for executable work:

```md
- [ ] Add parser fixture
- [x] Define schema
```

## Not tested

An optional section of checkboxes for work that exists but that no test covers:

```markdown
## Not tested

- [ ] The report line renders a per-skill reference tally. Requires a live session; no test can assert what an agent writes.
```

- Write an entry the moment a gap is known: a check skipped, an assumption not exercised, a claim
  resting on indirect evidence. `plan-start` writes them during its run; a sync adds them.
- Each entry states what to check and why a test cannot.
- Only the user clears an entry: by confirming it by hand and checking it off, or by deleting it
  with the reason recorded in the plan's `## Decision Log`.
- Unchecked entries on an active or completed plan are a finding (`UNCONFIRMED_NOT_TESTED`), and
  `/plan-close` refuses to close a plan while any remain.
- The heading must be exactly `## Not tested`. Headings and checkboxes inside fenced code blocks,
  like the example above, are never plan structure.
