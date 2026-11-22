---
id: ejsc769o
next_action: Review renewed at commit 2efa3ecc after merging main; it awaits the user's approval of that commit, then merge pull request 76 and run `/plan-close`.
blocked_by: []
depends_on:
  - o9zwxuav
  - bysyzl1e
related: ["age4cm7r", "gqzjlzgx", "7e21olcs", "skills-vs-commands-invocation-policy"]
reviewed_commit: 46f37fbc51d551f49999d757a328694c176555b8
worktree: skills-required-and-recommended
---

# Declare Which Skills Need or Suggest Each Other

## Summary

RoboRepo skills already name other skills in prose, through `## Paired Skills` tables and ad hoc
loading instructions. The package system cannot see those relationships: the Config page does not
show them, a skill another one always needs can be turned off on its own, and several skills repeat
the same "check the package, then ask the user to enable it or skip it" procedure on every run.

[[o9zwxuav]] shipped the package-level mechanism: `requires`, `recommends`, dependency-only
packages, and the Config page's Requires and Recommended dependencies lists. No built-in package
uses it yet. This plan declares the real relationships across the built-in catalog, creates the
dependency-only `implementation-review` package that the plan suite and `/session-close` share, and
replaces the per-run enable-or-skip prompts with one rule: the user is asked about a recommendation
once, when its parent package is enabled, and never again at run time.

## Context

### Current behavior

- Package manifests support `requires` and `recommends` (`scripts/cli/package-catalog.mjs`,
  `scripts/cli/package-graph.mjs`), but no file under `globals/packages/*/package.config.json`
  declares either.
- Enabling a package with disabled recommendations offers each one once: the interactive CLI asks
  "Also enable recommended package …?" (default No, `offerRecommendations` in
  `scripts/cli/packages.mjs`), the portal lists them, and scripts or `--dry-run` print one
  `recommended (not enabled): …` line. The terminal setup wizard (`buildOnboardSteps` /
  `applyWizardChanges` in `scripts/cli/presets.mjs`) shows nothing; [[o9zwxuav]] left that choice
  to this plan.
- [[bysyzl1e]] merged `plan-write`, `plan-promote`, `plan-execute`, `plan-review`, `plan-close`,
  `plan-archive`, and `plan-suite-init` into one package, `plan-suite`. A relationship is declared
  per package, so the plan skills' needs combine into `plan-suite`'s manifest.
- Several skills tell the agent to check a paired package's state and ask "Enable it, or skip it for
  this run?" when it is off. A skipped recommendation is asked about again on the next run.
- The plan-suite validator rubric lives in `plan-suite/skills/plan-execute/references/validation-loop.md`
  (checklist, three convention checks, and the `fix` / `escalate` / `base` classes; eight-pass cap).
  `plan-suite/skills/plan-review/SKILL.md` restates the checklist, convention checks, and classes inline. `session-close` has its own short
  review list and a `## Risk Checkpoints` section, and loads "a dedicated code-quality review skill"
  only if one happens to exist.

### Proposed behavior

- Each built-in package's manifest declares what it requires and recommends.
- Enabling a package keeps the one-time recommendation offer that ships today. The setup wizard
  prints one line naming recommendations still off.
- At run time a skill loads an applicable recommended skill when it is available and skips it
  silently when it is not, naming the skip in one line of its final report. No skill asks the user
  to enable a package.
- `implementation-review` holds the one review rubric that `/plan-execute`, `/plan-review`,
  `/plan-close`, and `/session-close` all use.

## Goals

- [x] Every cross-package skill relationship in the built-in catalog is declared as `requires`,
      `recommends`, or kept as a prose-only reference, by one policy.
- [x] Skills keep their task-specific `Load when` conditions; manifests carry no task predicates.
- [x] No skill prompts at run time to enable a package; a skipped recommendation is reported once.
- [x] The setup wizard names recommendations left off, in one line.
- [x] `implementation-review` exists as a dependency-only package and is the single home of the
      review rubric.
- [x] Manifests and skill prose agree.
- [x] `roborepo skill audit` warns about package-boundary candidates.

## Non-goals

- Backward compatibility with old package state, generated wrappers, or manifests. Wipe and rebuild
  local generated and desired state after the new manifests land; no migration branches.
- Making every named relationship required.
- Enabling recommended packages automatically.
- Encoding predicates such as "when the plan touches JS/TS" in the package graph.
- A second, skill-level enablement registry under packages.
- Changing `tighten`, which is still unstable.
- Changing the enable-time offer that [[o9zwxuav]] shipped.

## Relationship policy

Terms used below: the **Config page** is the portal page for turning packages on and off; each
package there has a **row** with a toggle and a **source popup** that shows its files and the
packages it requires. A **dependency-only** package (`selectable: false`) has no row and turns on
and off only with the packages that require it.


| Relationship | Use when | Package behavior | Skill behavior |
| --- | --- | --- | --- |
| `requires` | The parent cannot meet its contract without the other package | Active whenever the parent is; cannot be turned off while the parent is on | Loaded whenever the parent's step needs it |
| `recommends` | The other skill improves the work, but the parent is correct without it | Offered once when the parent is enabled; never auto-enabled | Loaded when its `Load when` condition matches and it is available; otherwise skipped and named once in the final report |
| prose-only reference | A fallback, an alternative, a boundary statement ("X does this instead"), or an inverse link | None | Stays in prose |

Prompting happens in one place only: the enable-time offer (user decision 2026-11-22). Run-time
skips are not package problems: they never mark the parent `partial` or blocked.

## Package relationships

Rescanned on 2026-11-22 across `globals/packages/*/skills/*/SKILL.md` and their `references/`.
References between skills in the same package are not relationships.

| Package | `requires` | `recommends` | Prose-only references |
| --- | --- | --- | --- |
| `plan-suite` | `technical-writing`, `implementation-review`, `test-harness` | `code-style`, `javascript-typescript`, `feature-verification` | — |
| `session-close` | `implementation-review` | `test-harness`, `plan-suite` | — |
| `implementation-review` (new) | — | `code-style`, `javascript-typescript` | — |
| `technical-writing` | — | `code-style`, `javascript-typescript`, `test-harness` | — |
| `javascript-typescript` | — | `react`, `code-style` | — |
| `feature-verification` | — | — | `test-harness` (boundary: test-harness chooses and runs tests) |
| `supabase-integration-testing` | — | — | `test-harness` (fallback when Supabase conditions do not match) |
| `tighten` | none | none | `code-style`, `javascript-typescript`, `react` (out of scope) |
| `plan-suite` (descriptions) | — | — | `session-close` (boundary: "ending a session (session-close)") |
| `response-output` | — | — | `caveman` (precedence: an enabled caveman mode governs length) |
| `skill-visibility` | — | — | `technical-writing` (example output only) |
| `tool-call-optimization`, `plan-write` schema | — | — | `telemetry` (a word in prose, not a skill reference) |
| `implementation-review` | — | — | `plan-execute`, `plan-review`, `plan-close`, `session-close` (inverse links: its callers) |

Why each edge, by source skill:

| Edge | Source in the skills | Reason |
| --- | --- | --- |
| `plan-suite` → `technical-writing` (requires) | `plan-write` and `plan-promote` load it always; `plan-archive`, `plan-close`, `plan-review` pair it | Plan prose is part of the suite's contract |
| `plan-suite` → `implementation-review` (requires) | Validator passes in `plan-execute` and `plan-review`; `plan-close`'s quality pass | One rubric for every pass |
| `plan-suite` → `test-harness` (requires) | `plan-close` needs repository-native verification for a complete verdict; the other plan skills pair it | Required by one skill, so required by the package. Enabling `plan-suite` now turns `test-harness` on |
| `plan-suite` → `code-style`, `javascript-typescript` (recommends) | `code-style` pairs in `plan-write`, `plan-promote`, `plan-execute`, `plan-review`; `javascript-typescript` in the first three | Apply only to plans and diffs with code or JS/TS |
| `plan-suite` → `feature-verification` (recommends) | `plan-execute` pairing; `plan-write`'s `references/completion-report.md` reuses its captures | Only for behavior that needs a demonstration |
| `session-close` → `implementation-review` (requires) | Its "Review the code" step | Replaces "load a code-quality review skill if one exists" |
| `session-close` → `test-harness` (recommends) | New: verification of the session's changes | Useful, not required to close a session |
| `session-close` → `plan-suite` (recommends) | `plan-write` pairing for plan sync and backlog hand-off | Only when the session touched a plan |
| `implementation-review` → `code-style`, `javascript-typescript` (recommends) | New skill | `javascript-typescript` brings `react` through its own recommendation |
| `technical-writing` → three packages (recommends) | Its `## Paired Skills` table and `references/review-loop.md` | Subject-matter constraints, conditional |
| `javascript-typescript` → `react` (recommends) | Its `## Paired Skills` table | React is a specialization |
| `javascript-typescript` → `code-style` (recommends) | "as `code-style` describes" for helper placement | Its placement rule defers to code-style |

`requires` stays acyclic: no required package requires anything back. `recommends` may form
cycles, which the catalog allows.

## Proposed design

### 1. Manifests own the relationships

Each manifest in the table gains `requires` / `recommends` arrays of package IDs. The skill body
keeps its `## Paired Skills` table, with the `Load when` condition for each recommended skill. The
manifest says which packages are related; the skill says when each one applies.

### 2. Required dependencies

A required package is on whenever its parent is. The parent skill loads it without checking its
state or asking. If it cannot materialize, the parent package is unhealthy (`roborepo package status`
reports it, through the `requires` component [[o9zwxuav]] added), and the workflow reports that
problem instead of running on duplicated or missing rules.

### 3. Recommended dependencies

At enable time, the [[o9zwxuav]] offer is unchanged. After the setup wizard applies its changes, it
prints one line listing the recommendations of the selected packages that are still off, with the
command to enable them, in the same form as the non-interactive `recommended (not enabled): …` line.

At run time, a parent skill:

1. evaluates its `Load when` condition; if it does not match, does nothing;
2. if it matches and the skill is available in the session, loads it;
3. if it matches and the skill is not available, continues without it and names it once in the
   final report ("Skipped `react`: not enabled").

The skill decides availability from the skills the session lists, not by calling the package
manager. This rule is written once, in the always-loaded skill-loading rule
(`globals/system/rules/shared/05-skill-loading.md`), and the per-skill enable-or-skip procedures are
deleted: six plan skills and `session-close` carry one today.

### 4. Create `implementation-review`

```text
globals/packages/implementation-review/
  package.config.json
  skills/implementation-review/SKILL.md
```

```json
{
  "schemaVersion": 1,
  "id": "implementation-review",
  "label": "Implementation Review",
  "description": "Shared implementation-quality review rules used by lifecycle workflows.",
  "lifecycle": "optional",
  "selectable": false,
  "presentation": {
    "visibility": "dependency",
    "category": "skills-code-quality",
    "order": 5
  },
  "recommends": ["code-style", "javascript-typescript"],
  "resources": [
    {
      "type": "skill",
      "id": "implementation-review",
      "source": "skills/implementation-review",
      "invocation": "auto",
      "risk": "medium"
    }
  ]
}
```

No slash command and no Config row: it appears under **Requires** in the source popup of
`plan-suite` and `session-close`.

The caller supplies the scope (files or plan-owned implementation) and the requirements. The skill
owns the rubric:

- the checklist now in `validation-loop.md`: acceptance criteria against code and test evidence,
  observable-outcome tests, docs of record, `## Not tested` entries, gate failures, constraints of
  loaded paired skills;
- the three convention checks: flow and cohesion, data and state, comments and abstractions;
- `session-close`'s current points: functionality gaps, naming, project-pattern conformance;
- the risk checkpoints from `session-close`: authentication; authorization, ownership, and admin;
  schema and migrations; API mutations; environment and deploy config; uploads and storage;
  external integrations;
- one finding format. Severity says how much a finding matters; class says who resolves it:

| Severity | Meaning | Blocks a clean pass? |
| --- | --- | --- |
| `blocking` | Incorrect, missing, or unsafe required behavior, or a project-invariant violation | Yes |
| `actionable` | A concrete quality issue worth fixing before the work is clean | Yes |
| `note` | Low-risk or optional | No |

| Class | Meaning |
| --- | --- |
| `fix` | The right fix is clear and stays within the caller's scope and contracts |
| `escalate` | The fix chooses between real alternatives, changes requirements or a contract, or lands outside the scope |
| `base` | A gate failure the base branch has too; recorded, not a finding |

Every finding names its location, the violated rule, the fix, and the risk. Generic cleanup advice
is not a finding. Loops, roles, pass caps, and where findings are recorded stay with each caller.

### 5. Callers

| Caller | Keeps | Changes |
| --- | --- | --- |
| `/plan-execute` | The validation loop, its eight-pass cap, the `## Review` record, the submit gate | `references/validation-loop.md` loses its `## The rubric` section and points to `implementation-review` |
| `/plan-review` | Base sync, its fixes, the review packet, approval | The inline rubric copy is replaced by a reference to `implementation-review` |
| `/plan-close` | Verdicts, `## Not tested`, landing checks, the plan move, cleanup, and its current rule that it fixes agent-resolvable in-scope gaps before the verdict | Runs `implementation-review` over the plan-owned implementation. A `blocking` or `actionable` finding it cannot fix within the plan's scope makes the plan incomplete. Its test-selection prose defers to `test-harness`, keeping only how it reads verification evidence |
| `/session-close` | Session-file scoping, doc and plan sync, staging, commit, stray work, handoff | Step 1 runs `implementation-review` on the session's files; docs-only sessions skip it and say so. Its review list and `## Risk Checkpoints` move into `implementation-review` (`tighten`'s own copy stays, out of scope). Unresolved `blocking` / `actionable` findings become handoff items |

### 6. Package-boundary warnings

`roborepo skill audit` (`scripts/cli/skill-audit.mjs`) gains warnings, never errors:

| Audit finding | Suggests |
| --- | --- |
| A skill unconditionally hands off to, or loads, a skill in another package, and neither package requires the other | Merge the packages, or add `requires` |
| Two packages each unconditionally hand off to the other | Merge them |
| A package holds several skills and none references another | Split them, in a collection if users want them together |

An **unconditional** reference is a `## Paired Skills` row whose `Load when` is `Always`, or an
instruction outside that table to load or hand off to another skill. References inside one package,
such as between plan skills in `plan-suite`, are not reported.

The audit also warns when manifest and prose disagree: a `recommends` or `requires` package with no
`## Paired Skills` row in any of the parent's skills, or a row naming a package the manifest neither
requires nor recommends (prose-only references in the "Package relationships" table excepted).

## Implementation plan

### Phase 1 — Manifests

- [x] Add `requires` / `recommends` to `plan-suite`, `session-close`, `technical-writing`, and
      `javascript-typescript` manifests as in "Package relationships".
- [x] Rescan the catalog for references missing from that table; classify any new one and add it to
      the table before continuing.
- [x] `roborepo package validate` passes; `requires` is acyclic.

### Phase 2 — `implementation-review`

- [x] Create the package and skill from section 4, moving the checklist, convention checks,
      classification table, and `session-close`'s review points and risk checkpoints into it.
- [x] Add it to `plan-suite.requires` and `session-close.requires`.
- [x] Rewire `/plan-execute`, `/plan-review`, `/plan-close`, and `/session-close` as in section 5;
      delete the moved text from each.

### Phase 3 — Run-time recommendation rule

- [x] Add the three-step rule from section 3 to `globals/system/rules/shared/05-skill-loading.md`.
- [x] Delete the enable-or-skip procedure from the six plan skills that carry it (`plan-write`,
      `plan-promote`, `plan-execute`, `plan-review`, `plan-close`, `plan-archive`) and from
      `session-close`; keep each `## Paired Skills` table and its `Load when` conditions.
- [x] Make each skill's `## Paired Skills` table agree with its package's manifest: every required
      package marked as always loaded, every recommended one with a `Load when` condition, prose-only
      references not presented as recommendations.

### Phase 4 — Setup wizard line

- [x] After `applyWizardChanges` in `scripts/cli/presets.mjs` applies, print one line naming the
      selected packages' recommendations that are still off, using the same recommendation data the
      enable path returns.
- [x] Add a check in `scripts/test/` that a wizard run selecting `plan-suite` prints the line and
      enables nothing it did not select.

### Phase 5 — Audit warnings

- [x] Add the section 6 warnings, including the manifest-and-prose agreement warning, to
      `scripts/cli/skill-audit.mjs`, with a fixture for each finding.
- [x] Regenerate `docs/internal/skill-invocation-audit.md`.

### Phase 6 — Docs and generated outputs

- [x] Update the docs listed under "Documentation impact".
- [x] Regenerate package-owned command and skill outputs; drop legacy generated copies.

## Validation

- [x] `roborepo package validate` passes the migrated manifests.
- [x] Enabling `plan-suite` in a clean home makes `technical-writing`, `implementation-review`, and
      `test-harness` effective without recording them as selected roots; disabling `plan-suite`
      while `session-close` is on leaves `implementation-review` effective, and disabling both
      removes it.
- [x] With `technical-writing` removed from disk, `roborepo package status plan-suite --json`
      reports the package unhealthy.
- [x] Interactive `roborepo package enable plan-suite` offers `code-style`, `javascript-typescript`,
      and `feature-verification` once each and enables none on No.
- [x] The setup wizard check from Phase 4 passes.
- [x] No `SKILL.md` or reference under `globals/packages/` asks the user to enable or skip a package
      (a text check added to `scripts/test/skill-reference-matrix-characterization-check.mjs`).
- [x] `implementation-review` has no Config row and no slash command, and appears under Requires in
      the `plan-suite` and `session-close` source popups.
- [x] `/plan-execute`, `/plan-review`, `/plan-close`, and `/session-close` reference
      `implementation-review` and no longer contain the rubric or risk-checkpoint text.
- [x] `roborepo skill audit` reports each section 6 finding, including manifest-and-prose
      disagreement, on its fixture and none on the built-in catalog.
- [x] `npm run test:unit` passes, including `package-catalog-check.mjs`, `package-graph-check.mjs`,
      `plan-suite-skills-check.mjs`, and `skill-reference-matrix-characterization-check.mjs`.
- [x] `npm run test:portal-ui` passes the Requires and Recommended dependencies presentation.
- [x] `npm test` passes the CLI package enable, disable, and status flows. — 426 passed, 0 failed at 76a693a
- [x] `npm run check` passes (manifests, package state, and skill sources are cross-cutting). — CI
      on the pull request passed at b9bac966 (macOS and Ubuntu `check`, `windows-installer`).

## Documentation impact

| Doc | Update |
| --- | --- |
| `local/skills/roborepo-development/references/package-development.md` | The relationship policy table, and that task predicates stay in skill prose. Fix "offered after an enable" wording if the wizard line changes it |
| `globals/system/skills/roborepo-support/SKILL.md` | "Pairing another skill": manifests declare the relationship; skills never prompt to enable; how to classify a new reference |
| `globals/system/rules/shared/05-skill-loading.md` | The run-time recommendation rule (section 3) |
| `docs/user/reference/config-control-panel.md` | Example of Requires and Recommended dependencies using the real `plan-suite` / `session-close` edges; the wizard line |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | `## Paired Skills`: which packages the suite now turns on, which it recommends, and that skipped ones are named in reports |
| `docs/internal/skill-invocation-audit.md` | Regenerated by `roborepo skill audit` |

## Related plans

| Plan | Relationship |
| --- | --- |
| [[o9zwxuav]] Package Management: Part 02 | Landed dependency. Supplies `requires`, `recommends`, dependency-only packages, the enable-time offer, and the Config page lists. Its deferred decision on onboarding recommendations is settled here (wizard prints one line) |
| [[bysyzl1e]] Package Management: Part 01 | Landed dependency. Made `plan-suite` one package, so plan-skill edges are declared on `plan-suite` |
| [[7e21olcs]] Make Coding Conventions Clearer | Landed. Its convention checks are the current rubric text this plan moves unchanged |
| [[age4cm7r]], [[gqzjlzgx]] | Landed plan-lifecycle commands this plan edits; no conflict |
| [[skills-vs-commands-invocation-policy]] | Backlog. Overlaps on `roborepo skill audit`; no conflict, since this plan adds warnings only |

## Risks

- Requiring `test-harness` from `plan-suite` turns it on for every plan-suite user. It already pairs
  with five of the seven plan skills, so the added surface is small.
- A recommendation whose skill body loses its precise `Load when` condition would load too often.
  The Phase 3 consistency pass guards against that.
- Required dependencies change package health: a missing required package now shows the parent as
  unhealthy instead of silently degrading.

## Not tested

- [x] `npm test` passes the CLI package enable, disable, and status flows. — Verified by agent
      2026-11-22 at 76a693a: `npm test` outside the sandbox → "roborepo tests: 426 passed, 0 failed".
- [x] `npm run check` passes. — Verified by agent 2026-11-22 at b9bac966: CI run 45039912600 on
      pull request 76 → `check (macos-latest)`, `check (ubuntu-latest)`, and `windows-installer` passed.

## Review

### Findings
- [x] Four Validation items had no passing evidence — portal UI run fixed and passing (76a693a); `npm test` and `npm run check` moved to `## Not tested` for CI
- [x] plan-execute and plan-review restated the finding classes — fixed (76a693a)
- [x] config-control-panel example split the composition list — fixed (76a693a)
- [x] skill audit re-parsed its own markdown for warnings — fixed (76a693a)
- [x] Boundary test read the committed doc and lacked the reverse-requires case — fixed (76a693a)
- [x] Plan record not synced; inverse links missing from the relationships table — fixed in this save
- [x] Each skill restated the run-time rule — decided: one pointer per skill (Decision Log), fixed (76a693a)
- [x] `npm test` Not tested entry was runnable by an agent — run outside the sandbox and cleared (426 passed)
- [x] `npm run check` entry gave the wrong reason — reworded: CI runs the full gate
- [x] Wizard comment misstated the shared line — fixed (13629d5)
- [x] javascript-typescript and technical-writing restated the run-time rule — fixed (13629d5)
- [x] Audit shape check and boundary warnings parsed the Paired Skills section differently — fixed (13629d5)
- [x] `npm run test:unit` was ticked without a full passing run — run outside the sandbox: 203/203 passed
- [x] `npm run check` Validation item was ticked while waiting on CI — unticked; open under `## Not tested`
- [x] A comment sat above the wrong function in skill-package-boundaries.mjs — fixed (7447670)
- [x] `proseInstruction` kept its own copy of the section pattern — fixed (7447670)
- [x] Two pointer forms across the nine skills with Paired Skills tables — one form, test extended (7447670)
- [x] Grammar in the config panel wizard example — fixed (7447670)
- [x] Wizard restated the enable path's recommendation filter in presets.mjs — reuses `disabledRecommendations` (17519cd4)
- [x] No-op `.map((p) => p)` in skill-package-boundaries-check.mjs — removed (17519cd4)

### Verification
- Validator pass 1 at 40dae82 (fresh-context subagent): 3 actionable, 4 notes; all fixed in 76a693a.
- Validator pass 2 at 76a693a (fresh-context subagent): 1 actionable, 4 notes; all fixed in 13629d5.
- `npm test` outside the sandbox at 76a693a: 426 passed, 0 failed.
- Validator pass 3 at 13629d5 (fresh-context subagent): 3 actionable, 3 notes; all fixed in 7447670.
- Validation: clean on pass 4 at 7447670 (fresh-context subagent).
- `npm run test:unit` outside the sandbox, started at 13629d5: "check suites: 203/203 passed". The
  pass-3 edits in 7447670 (prose, one comment, one shared regex constant) were rechecked with
  skill-package-boundaries, plan-suite-skills, skill-reference-matrix-characterization,
  skill-structure, docs-reference checks and `skill audit --check`, all passing.
- Local, inside the sandbox: plan-suite-skills, skill-reference-matrix-characterization,
  package-catalog, package-graph, package-lifecycle, config-dependency-sections,
  skill-package-boundaries, wizard-recommendations, package-relationships, orphan-test,
  docs-reference, skill-structure checks pass; `roborepo package validate`, `skill audit --check`,
  `skill triggers --check`, `skill render-commands --check`; `bash scripts/doctor.sh --quiet`
  (100 checks); `git diff --check`.
- Outside the sandbox: config-bulk-toggle, cli-surface-integration, plan-suite-commands,
  plan-suite, repository-scope-portal checks pass; `npm run test:portal-ui` 275 passed and 1
  failed at 40dae82, the failure fixed in 76a693a and rerun passing.
- `npm run test:unit` inside the sandbox: about 34 suites fail on sandbox limits (local ports, git
  worktree writes, browsers); the catalog-adjacent ones among them pass outside the sandbox.
- Interactive `roborepo package enable plan-suite` under a pty in a temporary home offered
  `code-style`, `javascript-typescript`, and `feature-verification` once each; answering No left
  only `plan-suite` recorded.
- Portal at http://127.0.0.1:4523/agents from the worktree: the plan-suite and session-close
  source popups list Implementation Review under Requires; it has no row or toggle.
- Plan review 2026-11-22: base `main` at 46f37fbc already merged (sync-base: up to date).
- CI run 45039912600 at b9bac966 (`npm run check` on macOS and Ubuntu, `windows-installer`): passed.
- Plan review Validator pass at b9bac966 (fresh-context subagent): 2 actionable, 1 note; fixed in
  17519cd4 and in this record.
- At 17519cd4: wizard-recommendations, skill-package-boundaries, plan-suite-skills,
  skill-reference-matrix-characterization, package-relationships, package-catalog checks pass locally.
- Plan review Validator pass at 17519cd4 (fresh-context subagent): clean.
- CI run 45059404551 at 17519cd4 (`npm run check` on macOS and Ubuntu, `windows-installer`): passed.

- Approval of 17519cd4: the user replied "Approve 17519cd4" in the /plan-review session on 2026-11-22.

- Base moved after approval of 17519cd4: main gained 97f0d5b1 (install-drift doctor warning). Merged
  cleanly in 2efa3ecc; the only shared file, scripts/test/check-groups.json, keeps both sides' checks.
- Validator pass at 2efa3ecc (fresh-context subagent): clean; install-drift detection does not read
  package manifests or skills, so the two changes do not interact.
- CI run 45071990953 at 2efa3ecc (`npm run check` on macOS and Ubuntu, `windows-installer`): passed.

### Result
- Status: complete
- Reviewed implementation commit: 2efa3ecc41d2c573990f837c96ff46f9714ae8d8
- Base commit: 97f0d5b139cf4eddf6eae8a5fab338bc7998e93e

### Approval
- Decision: approved
- Reviewed implementation commit: 2efa3ecc41d2c573990f837c96ff46f9714ae8d8
- Confirmed by: human

## Decision Log

- **2026-11-22 (user decision): Ask about a recommendation once, at enable time.** The plan earlier
  said recommendations never prompt at enable time and skills prompt at run time. The user does not
  want repeated questions: keep the shipped enable-time offer, and at run time skip unavailable
  recommendations silently and report the skip once.
- **2026-11-22 (user decision): The setup wizard prints one line** naming recommendations still
  off after it applies. Settles the question [[o9zwxuav]] deferred to this plan.
- **2026-11-22: Relationships are per package.** After [[bysyzl1e]], the plan skills share
  `plan-suite`, so their edges combine there and `test-harness` becomes required by the suite.
- **2026-11-22: `/plan-close` keeps fixing agent-resolvable gaps.** The earlier draft said it would
  leave findings to `/plan-execute`; the landed skill fixes in-scope gaps before its verdict, and this
  plan does not change that.
- **2026-11-22: `technical-writing` → `plan-write` dropped.** The reference no longer exists in
  `technical-writing`.
- **2026-11-22: Paired Skills tables gain a `Relationship` column** (`requires` / `recommends`).
  Alternatives: a sentence above each table, or a marker in the Skill cell. The column is the only
  form the audit can compare with the manifest row by row, and it reads as plainly as the others.
- **2026-11-22: A `requires` row keeps its `Load when` condition.** "Marked as always loaded" was
  read as "always available, so loaded without a state check", not "loaded on every run":
  `plan-archive` needs `technical-writing` only for a long reason. The audit counts a row as
  unconditional only when its condition starts with "Always".
- **2026-11-22: Skills point to the Skill Loading rule instead of restating it.** Each Paired
  Skills section keeps one sentence naming the rule and where a skip is reported. A full
  restatement in each of nine skills was the first draft; the Validator flagged it as nine copies
  of one policy, and the plan says the rule is written once.
- **2026-11-22: `tighten`'s references are exempt in the audit** through `PROSE_ONLY_REFERENCES`
  in `scripts/cli/skill-package-boundaries.mjs`. Without it the audit warns twice on the built-in
  catalog; `tighten` is out of scope and its references are classed prose-only in this plan's table.
- **2026-11-22: The audit counts a prose instruction to load a skill as unconditional only when the
  skill's own table does not declare that skill.** Otherwise a conditional "load `plan-write`" in
  `session-close` prose reads as unconditional. A declared row carries the condition.
- **2026-11-22: `implementation-review` findings carry a severity and a class.** Only `blocking`
  and `actionable` findings are recorded in a plan and hold up the validation loop; a `note` stays
  in the pass's report. This is how section 4's "Blocks a clean pass?" column reaches each caller.
- **2026-11-22: The real-catalog dependency flows got their own check**
  (`scripts/test/package-relationships-check.mjs`) rather than a block in
  `package-lifecycle-check.mjs`, which tests the engine with fixture packages. The per-package loop
  there now skips dependency-only packages, which cannot be enabled on their own.
- **2026-11-22: The Agents-page category check ignores dependency-only packages.**
  `implementation-review` is the first package in `skills-code-quality`, and it has no row by
  design, so the category correctly renders no section.
