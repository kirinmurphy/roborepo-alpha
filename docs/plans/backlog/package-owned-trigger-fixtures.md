---
id: e6f1pknt
priority: high
next_action: Design the per-package fixture location/schema and confirm it with the user before migrating existing entries
blocked_by: []
depends_on: []
related: []
reviewed_commit: 8697e52cb9e1f532631d95c8133b3240ccfee8ab
---

# Package-Owned Trigger Fixtures

## Summary

Move skill trigger fixtures out of the platform-owned `manifests/inventory/skill-trigger-tests.json`
and into each package's own directory, so the package system stays swappable: the platform should
never hold a file that names specific packages.

## Context

`roborepo skill triggers --check` verifies that a skill's `SKILL.md` description contains the
trigger/skip phrases a fixture claims, and that example prompts (`match`/`nearMiss`) actually
exercise them. The check itself (`scripts/cli/skill-trigger-check.mjs`) is generic — it walks
`loadPackageCatalog()` and reads whichever skill source a fixture names, without hardcoding any
package id in code.

The fixture *data*, however, is centralized: `manifests/inventory/skill-trigger-tests.json` is one
flat array under `manifests/`, alongside genuinely platform-owned files like
`manifests/inventory/package-categories.json` (the valid `presentation.category` values — a closed
platform vocabulary, correctly platform-owned). The trigger-tests file is different in kind: every
entry's `skill` field names one specific package's skill (`case-study`, `frontend-design`,
`plan-write`, `tighten`, `plan-promote`, `plan-start`). That content is package knowledge sitting in
platform territory.

This breaks the boundary the package system is meant to guarantee: swap out or remove any package
and the platform's own files should need no edit. Today, removing `tighten` would leave a dangling
package reference inside a file `manifests/` is supposed to own independently of which packages
exist. Every other package-specific fact already lives inside `globals/packages/<id>/` —
`package.config.json`, `SKILL.md`, `agents/openai.yaml` — this is the one exception.

## Goals

- Every trigger fixture lives inside the package directory it describes, alongside that package's
  `SKILL.md`.
- `manifests/` contains no file that names a specific package.
- `roborepo skill triggers --check` continues to validate the same things it does today, sourced
  from the new location.
- The `roborepo skill new` scaffold can generate the new fixture location (or a stub for it) as part
  of package creation, matching how it already scaffolds `package.config.json` and `SKILL.md`.

## Non-goals

- Changing what the trigger check validates (phrase-in-description, phrase-in-match-prompt,
  phrase-absent-from-near-miss). Only where the data lives changes.
- Making trigger fixtures mandatory. They stay optional per package, as today.
- Touching `manifests/inventory/package-categories.json` or other genuinely platform-owned
  manifests — those define closed platform vocabularies, not package-specific data, and are out of
  scope here.

## Current state

- Fixture data: `manifests/inventory/skill-trigger-tests.json`, one `tests[]` array, 6 entries
  (`case-study`, `frontend-design`, `plan-write`, `tighten`, `plan-promote`, `plan-start`).
- Reader: `scripts/cli/skill-trigger-check.mjs` — `TRIGGER_TESTS_REL` constant points at the file
  above; `packageSkillSources()` already resolves each fixture's `skill` id to its package source
  via `loadPackageCatalog()`, so the lookup mechanism generalizes cleanly to a per-package source.
- Scaffold: `scripts/cli/skill-new.mjs` writes `package.config.json`, `SKILL.md`, and
  `agents/openai.yaml` per package, but never touches trigger fixtures — a package author adds them
  by hand to the central file today, if at all.
- Fixtures are optional: `integration-check` (risk: `high`) has none, confirming nothing currently
  enforces their presence.

## Proposed design

Give each package an optional sibling file next to its `SKILL.md`, e.g.
`globals/packages/<id>/skills/<id>/trigger-fixture.json`, holding exactly one fixture object (the
shape currently nested inside `tests[]`, minus the redundant `skill` key since the id is implied by
location):

```json
{
  "match": ["..."],
  "nearMiss": ["..."],
  "triggerPhrases": ["..."],
  "skipPhrases": ["..."]
}
```

`skill-trigger-check.mjs` changes from reading one central JSON file to aggregating: walk
`loadPackageCatalog()`, and for each `skill` resource, check whether its source directory has a
`trigger-fixture.json`; if so, run the same validation it runs today. `manifests/inventory/` no
longer needs a trigger-tests file at all once migration completes.

This mirrors how `resources[]` entries already work — the platform loader (`package-catalog.mjs`)
knows the *shape* of a package (a skill has a source dir, may have entrypoints), never a specific
package's *identity*. The fixture becomes one more optional per-skill artifact, discovered the same
way `agents/openai.yaml` already is.

## Implementation plan

- [ ] Confirm the exact fixture file name/location with the user (this doc proposes
      `trigger-fixture.json` beside `SKILL.md`; alternatives include embedding it as a
      `resources[].triggerFixture` field inside `package.config.json` instead of a sibling file —
      pick one and record the reason).
- [ ] Update `scripts/cli/skill-trigger-check.mjs` to discover fixtures via the catalog instead of
      reading `TRIGGER_TESTS_REL`, preserving the existing pass/fail semantics and CLI output format.
- [ ] Migrate the 6 existing entries (`case-study`, `frontend-design`, `plan-write`, `tighten`,
      `plan-promote`, `plan-start`) from `manifests/inventory/skill-trigger-tests.json` into their
      respective package directories, then delete the central file.
- [ ] Update `scripts/cli/skill-new.mjs` / `skill-new-templates.mjs` so scaffolding a new
      skill-command package can optionally emit a starter fixture file (or document how to add one
      by hand, matching current `agents/openai.yaml` generation style).
- [ ] Update any docs referencing the central fixture file (`roborepo-support` `SKILL.md` mentions
      "add/update trigger fixtures") to point at the new per-package location.
- [ ] Confirm no other script reads `manifests/inventory/skill-trigger-tests.json` before deleting it
      (`grep -r skill-trigger-tests.json` across `scripts/`, `docs/`, tests).

## Validation

- `roborepo skill triggers --check` passes with the same 6 fixtures relocated, output unchanged in
  meaning (count and pass/fail).
- `node scripts/build/render-slash-commands.mjs --check` and `roborepo package validate <id>` remain
  unaffected for every package that gains a fixture file.
- `manifests/inventory/` contains zero occurrences of any package id after migration (grep check).
- Adding a fresh fixture for a new package requires touching only that package's directory, not
  `manifests/`.

## Risks

- `skill-trigger-check.mjs`'s current error messages assume a flat fixture list; aggregating from
  multiple package directories needs to preserve deterministic ordering for stable CI output.
- Migrating 6 existing entries by hand risks a transcription error (a phrase or prompt dropped or
  altered); diff each migrated fixture against its original entry before deleting the central file.

## Open questions

- Sibling JSON file next to `SKILL.md`, or a field inside `package.config.json`? A sibling file
  carries lower schema risk (no `normalizeResource()` or catalog-validation changes); a
  `package.config.json` field keeps all package metadata in one place but expands the schema this
  plan would otherwise leave untouched. This plan defaults to a sibling file; the user should
  confirm before implementation.
- Should the scaffold (`roborepo skill new`) prompt for trigger phrases interactively, or only
  document the manual step, matching how risk-medium/high guidance is advisory today?
