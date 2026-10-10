# Create Workflow

1. Understand the desired outcome.
2. Inspect relevant repository code and docs.
3. Check whether an existing plan already owns the work.
4. Create or revise one plan instead of duplicating scope.
5. **Identity checkpoint — complete before drafting any body content.** See below.
6. Write new plans into `docs/plans/backlog/`.
7. Add minimal frontmatter from `plan-schema.md`, including an empty `worktree:` line. Do not fill
   it at creation; a backlog plan has no implementation worktree yet.
8. Follow `writing-guidelines.md`.
9. Run both validation layers. See below.
10. Leave concrete `next_action`.

If the work is too vague to be implementation-ready, create a draft backlog plan and list missing decisions.

## Identity checkpoint

Resolve all four and state them before writing prose. Drafting first and naming afterward is how a
plan ends up with a namespace nobody checked against the repository's vocabulary.

| Decision | How to resolve it |
| --- | --- |
| Namespace | Read `docs/plans/plans-config.json`. Its keys are the project namespaces; `plan-schema.md` lists the universal ones. The project namespace wins whenever it is the more specific fit. If no key fits, propose adding one rather than inventing an unlisted prefix. |
| Filename | `<namespace>-<specific-slug>.md`, lowercase and hyphenated, with no lifecycle, status, date, or version suffix. |
| `id` | Generate a fresh opaque 6-8 character lowercase base36 string. **Do not derive it from the title, the filename, or the slug** — see "Plan ids" in `plan-schema.md`. |
| H1 | Reader-facing prose naming the outcome. Not the filename with the hyphens removed, and it does not restate the namespace. |

When `plans-config.json` does not exist, say so explicitly and propose an initial vocabulary drawn
from the repository, as described under "When no project config exists" in `plan-schema.md`. Do not
silently fall back to universal namespaces.

## Validation before delivery

A plan is both a lifecycle artifact and a durable document, so it passes two independent checks.
Neither substitutes for the other: a mechanically valid plan can still be unreadable, and clean
prose does not make an invalid namespace valid.

| Layer | Owns |
| --- | --- |
| `plan-write` validation (`workflow-validate.md`: the repository's plan validator, then repository consistency) | schema, frontmatter, lifecycle readiness, filename and namespace, cross-plan relationships, claims checked against the code |
| `technical-writing` Validator (`review-loop.md`) | organization, representation, anti-patterns, section content, reader clarity |

Ordering:

1. Run `plan-write` validation. Findings return to the Creator for revision.
2. Run the `technical-writing` Validator over the revised draft, surfacing its report on every
   pass as `review-loop.md` requires.
3. Any violation from either layer returns to the Creator, and the revised draft is rechecked by
   **both** layers — a prose fix can break a required section, and a schema fix can break the prose.
4. The plan is delivered when both layers report nothing.

If the user asked for the plan to be started, hand off to `/plan-start` only after the backlog
artifact passes both layers; it preserves the same `id` across the move into `docs/plans/active/`.
