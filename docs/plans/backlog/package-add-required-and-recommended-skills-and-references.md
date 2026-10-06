---
id: ejsc769o
priority: high
next_action: After o9zwxuav lands, add explicit required/recommended relationships to built-in skill packages, create implementation-review, and rewrite Paired Skills guidance to consume the package relationship model.
blocked_by: []
depends_on:
  - o9zwxuav
related:
  - age4cm7r
  - skills-vs-commands-invocation-policy
reviewed_commit: e43770079a37cd5f6b1b23f806280c432b756551
worktree:
---

# Add Required and Recommended Skill Relationships

## Summary

RoboRepo skills already reference other skills in prose through `## Paired Skills` tables and ad hoc loading instructions. Those relationships are useful but invisible to the package system: users cannot see them from the Config/Skills page, required helpers can be disabled independently, and every workflow repeats its own package-status/prompt logic.

This plan adopts the dependency mechanism from [[o9zwxuav]] across the built-in skill catalog. It classifies existing cross-skill relationships as **required**, **recommended**, or **runtime-conditional**, updates package manifests to express the durable relationships, and keeps the skill body as the source of task-specific activation conditions.

The same rollout creates the new non-selectable `implementation-review` skill and rewires `/session-close` and `/plan-close` to share it. This is the first concrete consumer of dependency-only skills, but the plan applies the model consistently across `plan-write`, `plan-promote`, `plan-start`, `technical-writing`, `javascript-typescript`, and the other built-in skills that already reference one another.

## Context

Today the dependency model lives mostly in prose. For example:

- `plan-write` and `plan-promote` always load `technical-writing`, but the package manifests do not require it;
- `plan-write`, `plan-promote`, `plan-start`, and `technical-writing` conditionally load `code-style`, `javascript-typescript`, and `test-harness` based on the work;
- `javascript-typescript` conditionally loads `react`;
- `session-close` conditionally loads `plan-write` when the session touched a plan;
- `plan-close` pairs with `technical-writing` and `test-harness`;
- each workflow repeats the same package-state check and enable-or-skip prompt.

The result is two overlapping systems: package manifests control what is installed, while skill prose independently describes what another skill expects to be available. [[o9zwxuav]] supplies the package-level mechanics needed to bring those systems together.

## Goals

- [ ] Audit every built-in package skill that names, loads, or falls back to another skill.
- [ ] Classify each relationship as `requires`, `recommends`, or runtime-only reference using one consistent rule.
- [ ] Move unconditional foundational relationships into package `requires`.
- [ ] Move optional but useful cross-skill relationships into package `recommends` while preserving their task-specific `Load when` conditions in the skill body.
- [ ] Remove repeated generic package-status/enable/skip procedures from individual skills once the shared dependency workflow can provide them.
- [ ] Keep conditional activation decisions in the skill that understands the task; package metadata must not pretend that every recommendation applies on every invocation.
- [ ] Create `implementation-review` as a non-selectable dependency-visible package.
- [ ] Make `session-close` and `plan-close` consume the same implementation-review contract and the same `test-harness` verification contract where appropriate.
- [ ] Make required and recommended relationships visible and inspectable from the Config/Skills dependency sections supplied by [[o9zwxuav]].
- [ ] Keep package metadata and skill prose consistent: the manifest declares the relationship; the skill explains when and why it is used.

## Non-goals

- Backward compatibility with old package state, generated wrappers, or manifests. Wipe/rebuild local generated and desired state after the new manifests land; do not add migration branches for legacy builds.
- Making every named skill relationship required.
- Automatically enabling recommended packages merely because the parent package is enabled.
- Encoding natural-language task predicates such as "when the plan touches JS/TS" into the package graph. Those conditions stay in the owning skill.
- Creating a second skill-level enablement registry underneath packages.
- Finishing or promoting `tighten`; its relationship model can be revisited after the skill itself is stable.

## Relationship policy

Use these definitions consistently:

| Relationship | Use when | Package behavior | Skill behavior |
| --- | --- | --- | --- |
| `requires` | The parent cannot satisfy its advertised contract without the other package | Dependency is active automatically and cannot be declined while the parent is active | Load it whenever the parent runs |
| `recommends` | The other skill improves or specializes the workflow, but the parent remains correct without it | Visible as a recommendation; never auto-enabled | When the skill's `Load when` condition matches, prompt to enable or skip if unavailable |
| runtime reference only | The relationship is a fallback, alternative, inverse integration, or too context-specific to represent as a durable package recommendation | No package activation relationship | Keep the relationship in skill prose only |

A recommendation is **declarative metadata, not an installation-time prompt**. The package UI may show it before use, but the enable/skip prompt happens when the parent skill reaches a matching `Load when` condition. This avoids asking a user to enable React just because they enabled a JavaScript skill before any React work exists.

## Current relationship audit

The initial migration target is the current built-in skill catalog under `globals/packages/*/skills/*/SKILL.md`.

| Parent package | Referenced skill | Current condition | Target relationship | Reason |
| --- | --- | --- | --- | --- |
| `plan-write` | `technical-writing` | Always | **requires** | Creator/Validator writing rules are part of plan-write's completion contract |
| `plan-write` | `code-style` | Plan specifies code ownership/placement | **recommends** | Relevant only for some plans; plan-write can still produce a valid plan without it |
| `plan-write` | `javascript-typescript` | Plan touches JS/TS | **recommends** | Language-specific guidance is conditional |
| `plan-write` | `test-harness` | Plan specifies tests/verification | **recommends** | Verification design improves when applicable but is not universal |
| `plan-promote` | `technical-writing` | Always | **requires** | Promotion rewrites and validates plan prose as part of its core contract |
| `plan-promote` | `code-style` | Plan specifies code ownership/placement | **recommends** | Conditional implementation guidance |
| `plan-promote` | `javascript-typescript` | Plan touches JS/TS | **recommends** | Conditional implementation guidance |
| `plan-promote` | `test-harness` | Plan proposes tests/verification | **recommends** | Conditional verification guidance |
| `plan-start` | `code-style` | Work places/organizes code | **recommends** | Useful for implementation but not every plan contains code changes |
| `plan-start` | `javascript-typescript` | Work touches JS/TS | **recommends** | Language-specific and conditional |
| `plan-start` | `test-harness` | Work changes tests/verification/fixtures | **recommends** | Conditional verification guidance |
| `technical-writing` | `plan-write` | Document lives under `docs/plans` | runtime reference only | Avoid a reciprocal package dependency with `plan-write`; `plan-write` owns plan schema/lifecycle when that document type is actually in scope |
| `technical-writing` | `code-style` | Document specifies code ownership/placement | **recommends** | Conditional subject-matter constraint |
| `technical-writing` | `javascript-typescript` | Document covers JS/TS | **recommends** | Conditional subject-matter constraint |
| `technical-writing` | `test-harness` | Document proposes tests/verification | **recommends** | Conditional subject-matter constraint |
| `javascript-typescript` | `react` | Touched files use React/JSX/hooks/client state | **recommends** | React is a conditional specialization, not a prerequisite for JS/TS guidance |
| `session-close` | `implementation-review` | Every code-bearing close | **requires** | Shared review is foundational to the close contract; docs-only sessions can explicitly skip the review step because there is no implementation scope |
| `session-close` | `test-harness` | Verification is useful for the changed behavior | **recommends** | Session closure remains valid if the user declines additional verification |
| `session-close` | `plan-write` | Session touched a plan or sends work to backlog | **recommends** | Optional and task-specific plan integration |
| `plan-close` | `implementation-review` | Every implementation close | **requires** | Plan closure should use the canonical implementation-quality rubric |
| `plan-close` | `test-harness` | Every complete-plan verdict | **requires** | A complete verdict must use repository-native verification/test-selection rules |
| `plan-close` | `technical-writing` | Completion summary and Verification prose | **recommends** | Improves durable completion prose but must not block an otherwise provable close |
| `implementation-review` | `code-style` | General implementation review | **recommends** | Supplies canonical language-agnostic conventions without making review impossible when absent |
| `implementation-review` | `javascript-typescript` | Reviewed scope is JS/TS | **recommends** | Conditional language specialization; `javascript-typescript` can in turn recommend `react` |
| `supabase-integration-testing` | `test-harness` | Supabase-specific conditions do not match | runtime reference only | This is a fallback/alternative workflow, not a dependency of the Supabase skill |

During implementation, repeat the audit across the full catalog rather than assuming this table is exhaustive. Any newly discovered relationship must be classified by the same policy and added to the plan before the rollout is called complete.

## Proposed design

### 1. Package manifests own durable relationships

After [[o9zwxuav]], a package can declare both strong and weak relationships:

```json
{
  "requires": ["technical-writing"],
  "recommends": ["code-style", "javascript-typescript", "test-harness"]
}
```

The manifest answers **which packages are related**. It does not encode invocation predicates.

The corresponding skill body keeps a concise table explaining **when** each recommended skill applies:

```text
Skill                  Load when
code-style             plan specifies module boundaries or code placement
javascript-typescript  plan touches JS/TS
 test-harness           plan proposes tests or verification
```

Do not duplicate the package-manager algorithm in every skill. Skills should ask the shared package/dependency layer for recommendation state rather than spelling out `available/enabled/status` reconciliation steps independently.

### 2. Required dependencies are automatic and non-negotiable

A required package is part of the parent's contract. The parent skill should not ask the user whether to enable it at invocation time.

Examples:

```text
plan-write   -> requires technical-writing
plan-promote -> requires technical-writing
plan-close   -> requires implementation-review, test-harness
session-close -> requires implementation-review
```

If a required dependency cannot materialize or is drifted/broken, the parent package is not healthy and the workflow reports that package-state problem rather than silently running a degraded substitute.

### 3. Recommended dependencies are prompted only when relevant

A package-level recommendation makes the relationship visible in Config/Skills and available to the parent workflow. It does **not** mean "prompt when this package is enabled."

At invocation time:

1. the parent evaluates its existing `Load when` condition;
2. if the recommendation is irrelevant, do nothing;
3. if relevant and enabled/healthy, load it;
4. if relevant and disabled, ask to **enable** or **skip for this run**;
5. if relevant but partial/external/drifted, offer reconciliation or skip;
6. report skipped applicable recommendations in the workflow's final status.

This becomes one shared recommendation-resolution convention rather than repeated prose in every skill.

### 4. Create `implementation-review`

Create:

```text
globals/packages/implementation-review/
  package.config.json
  skills/implementation-review/SKILL.md
```

Manifest intent:

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

No slash command. Users reach it through dependency details or source inspection, not through a standalone toggle/command.

`implementation-review` receives scope from its caller and owns the shared rubric:

- correctness and functionality gaps;
- project-pattern and ownership-boundary conformance;
- naming/readability/API shape;
- avoidable duplication and misplaced responsibilities;
- appropriate failure/error handling;
- risk checkpoints for auth, ownership/admin, migrations/schema, API mutations, environment/deploy config, storage/uploads, and external integrations.

Use one severity model:

| Finding | Meaning | Pass? |
| --- | --- | --- |
| `blocking` | Incorrect/missing/unsafe required behavior or project-invariant violation | No |
| `actionable` | Concrete quality issue worth fixing before the work is clean | No |
| `note` | Low-risk/cosmetic/optional improvement | Yes |

Every finding names the concrete location, violated rule/pattern, fix, and risk. Generic cleanup advice is invalid.

### 5. Refactor close workflows around shared contracts

#### `/session-close`

- Keep session-file scoping, doc/plan sync, staging, commit, stray-work handling, and handoff ownership.
- Run `implementation-review` only when the session contains implementation code; explicitly report the review step as skipped for docs/planning-only sessions.
- Apply safe behavior-preserving fixes within session scope; unresolved blocking/actionable findings become handoff work rather than being silently ignored.
- Resolve `test-harness` as a recommendation when verification is relevant.
- Resolve `plan-write` as a recommendation only when the session touched a plan or the user sends an open thread to backlog.

#### `/plan-close`

- Keep lifecycle validation, complete/incomplete/blocked/superseded/abandoned verdicts, `## Not tested`, landing checks, plan move, and server cleanup.
- Require `test-harness` for repository-native completion verification.
- Require `implementation-review` for the implementation-quality pass across the whole plan-owned implementation.
- Recommend `technical-writing` for completion summary and `## Verification` prose.
- A blocking/actionable implementation-review finding makes the plan incomplete; `/plan-close` reports it and leaves implementation to `/plan-start` rather than fixing missing product work itself.

### 6. Keep package relationships and skill references in sync

The manifest and `Paired Skills`/loading prose serve different purposes but must not contradict each other.

For each migrated skill:

- every `requires` package appears as an unconditional foundational relationship in the skill body;
- every `recommends` package appears in the relevant `Load when` table or equivalent guidance;
- runtime-only references are clearly described as fallback/inverse/conditional integrations and are not presented as package recommendations;
- remove hand-copied generic package-state resolution instructions once a shared resolution mechanism exists;
- do not duplicate another skill's actual rules inside the parent skill.

## Implementation plan

### Phase 1 — Audit and manifest classification

- [ ] Re-scan every `globals/packages/*/skills/*/SKILL.md` for named skill/package references and loading instructions.
- [ ] Classify each relationship using the policy in this plan and update the audit table for anything not already listed.
- [ ] Add `requires` / `recommends` to the applicable built-in `package.config.json` files.
- [ ] Validate that required relationships remain acyclic; keep reciprocal/contextual relationships such as `technical-writing -> plan-write` runtime-only where a static edge would create the wrong ownership or a cycle.

### Phase 2 — Shared recommendation resolution

- [ ] Add/reuse one package-layer helper that returns relationship state for a parent package: required/recommended IDs, availability, desired/effective/live status, and inspect metadata.
- [ ] Replace repeated five-step package-status logic in skill prose with one concise shared convention/reference that workflows invoke when a recommendation's `Load when` condition matches.
- [ ] Ensure recommendation resolution never prompts for irrelevant task-conditional recommendations.
- [ ] Ensure skipped recommendations are reportable without turning the parent package into partial/blocked state.

### Phase 3 — `implementation-review`

- [ ] Add the non-selectable dependency-visible `implementation-review` package and skill.
- [ ] Move the shared review rubric, severity threshold, and risk checkpoints into it.
- [ ] Add `code-style` and `javascript-typescript` recommendations to its manifest; rely on `javascript-typescript -> react` for React specialization rather than duplicating React as another direct relationship.
- [ ] Keep lifecycle scope decisions out of the skill: callers supply the files/implementation area and requirements context.

### Phase 4 — Close workflow adoption

- [ ] Add `implementation-review` to `session-close.requires` and `plan-close.requires`.
- [ ] Add `test-harness` to `plan-close.requires` and `session-close.recommends`.
- [ ] Add `technical-writing` to `plan-close.recommends` and `plan-write` to `session-close.recommends`.
- [ ] Remove the duplicated review rubric and risk-checkpoint list from `session-close`.
- [ ] Remove duplicated test-selection guidance from `plan-close`; keep only plan-close's interpretation of verification evidence and closure blockers.
- [ ] Preserve the distinct session-vs-plan review scopes.

### Phase 5 — Remaining built-in skill adoption

- [ ] `plan-write`: require `technical-writing`; recommend `code-style`, `javascript-typescript`, `test-harness`.
- [ ] `plan-promote`: require `technical-writing`; recommend `code-style`, `javascript-typescript`, `test-harness`.
- [ ] `plan-start`: recommend `code-style`, `javascript-typescript`, `test-harness`.
- [ ] `technical-writing`: recommend `code-style`, `javascript-typescript`, `test-harness`; keep `plan-write` as a runtime-only reference for `docs/plans` to avoid inverted ownership/cycles.
- [ ] `javascript-typescript`: recommend `react`.
- [ ] Preserve `supabase-integration-testing -> test-harness` as fallback prose, not a package dependency.
- [ ] Leave `tighten` unchanged in this plan.

### Phase 6 — Presentation and documentation

- [ ] Verify the Config/Skills dependency sections from [[o9zwxuav]] show the new required/recommended relationships under their owning package/category.
- [ ] Verify non-selectable `implementation-review` is absent from normal toggle rows but opens in the existing source popup from Required dependencies.
- [ ] Verify recommended dependency rows remain independently toggleable when the recommended package is selectable.
- [ ] Update package-development and skill-authoring guidance with the relationship-classification policy and the rule that task predicates remain in skill prose.
- [ ] Regenerate package-owned command/skill outputs from current source; do not preserve legacy generated copies.

## Validation

- [ ] `roborepo package validate` passes all migrated manifests and catches missing/cyclic required relationships.
- [ ] Enabling `plan-write` or `plan-promote` derives `technical-writing` as required without recording it as an independent root selection unless the user separately selected it.
- [ ] Disabling the last requiring parent removes a dependency-only effective package; disabling one of several parents leaves it active.
- [ ] `/plan-write` and `/plan-promote` cannot run as healthy workflows when required `technical-writing` cannot materialize.
- [ ] Conditional recommendations do not prompt merely because a parent package is enabled.
- [ ] A relevant disabled recommendation prompts once at workflow runtime with enable/skip choices; skipping does not block the parent.
- [ ] `implementation-review` has no independent toggle or slash command and is inspectable through dependency presentation.
- [ ] `session-close` and `plan-close` use the same implementation-review severity/risk contract while preserving different scope and lifecycle behavior.
- [ ] `plan-close` uses `test-harness` as required verification guidance; `session-close` can proceed after an explicit skip of its recommended verification.
- [ ] The built-in skill audit has no remaining duplicated generic package-status prompt procedure where the shared relationship resolver applies.
- [ ] `npm run test:unit` passes package-catalog, dependency, skill/reference, and plan-suite characterization checks.
- [ ] `npm run test:portal-ui` passes required/recommended dependency presentation and source-popup behavior.
- [ ] `npm test` passes CLI package enable/disable/status/reconcile and plan-suite command flows.
- [ ] `npm run check` passes after the cross-cutting manifest, package-state, portal, and skill-source changes.

## Risks

- A static recommendation can become noisy if its skill body no longer has a precise `Load when` condition. The migration must preserve those conditions rather than treating `recommends` as "always prompt."
- Reciprocal conceptual relationships can create bad package graphs. The parent that owns the foundational contract should carry `requires`; inverse or document-type-specific relationships stay runtime-only when necessary.
- Required dependencies change package health semantics. A parent whose required dependency is missing or drifted must surface that as a real package problem rather than silently falling back to duplicated rules.
