# Review Loop

After a doc reads well, run a validation loop with two distinct roles before calling it done. The
point is to catch rule violations the drafting pass missed, then fix them — not to re-draft. Keep
the roles separate; do not let the writer grade its own work in the same pass.

- **Creator** — writes and revises the doc. Owns the prose.
- **Validator** — does not write. Resolves the applicable rule set below, reads every rule in it,
  and checks the current draft against each one. Its only output is a report of violations.

## Applicable rule set

The Validator resolves this table before its first pass and states which rows it applied. "Read
every rule in the skill" is not resolvable on its own, and a silently omitted reference is the
exact failure this loop exists to catch.

| Rule source | When required |
| --- | --- |
| Core Writing Philosophy in `SKILL.md` | Always |
| `anti-patterns.md` | Always |
| `section-guidance.md` | Always |
| `representation.md` | Always — the draft was authored under it, so it is checked against it |
| `doc-shapes.md` | Non-plan documents: the chosen shape |
| `plan-write` `references/plan-schema.md` | Documents under `docs/plans`, in place of `doc-shapes.md` |
| `doc-organization.md` | Only when revising a documentation set rather than a single document |
| Applicable paired skills | Whenever they materially constrain the guidance the document gives — an explicit request is one trigger, not the only one |

A paired skill constrains validation, not only drafting: when a document tells a reader how to
build something, the rules governing that construction are in scope. Within a paired skill, only
the references that actually apply are required — `javascript-typescript/references/framework-less-markup.md` matters when the
document covers DOM structure, and not otherwise.

The loop:

1. **Validator pass.** Go through the whole doc against the resolved rule set and find violations.
   For each, write one report line: the rule it breaks, the offending location (section or quoted
   phrase), and what is wrong.
2. **If the validator finds violations**, hand the report to the creator. The creator revises the
   doc to address every reported item, then the loop returns to step 1 for a fresh validator pass
   on the revised draft.
3. **If the validator finds nothing**, the doc passes — it is done.
4. **Cap the loop at 10 validator passes.** If the validator still reports violations on the 10th
   pass, stop and report the last validator report as an error — do not keep looping. Surface what
   remained unresolved so the user can decide.

Each pass validates the *revised* draft, not the original — a fix in one round may introduce a new
violation, which the next pass catches.

**Surface the validator's report to the user in chat on each pass** — the violations it found that
round. The creator's revisions don't need restating; they show up in the edited output already.
The user should be able to see what each validation round caught.

Report each violation as:

```text
<rule/reference> — <location> — <violation>
```

A passing round is reported too: say explicitly that the pass found no violations, and name the
rule sources it checked. A silent pass is indistinguishable from a skipped one.
