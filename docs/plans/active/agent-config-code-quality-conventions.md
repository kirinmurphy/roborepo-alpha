---
id: 7e21olcs
priority: high
next_action: Rewrite code-style around responsibilities and comment examples, align javascript-typescript, add the three focused checks to both rubric texts with test assertions, then run and record the authoring/review sample.
blocked_by: []
depends_on: []
related:
  - ejsc769o
  - gqzjlzgx
reviewed_commit:
worktree: agent-config-code-quality-conventions
---

# Make Coding Conventions Clearer and More Consistently Applied

## Summary

Improve RoboRepo's shared coding skills and their use in implementation review so agents favor comprehensible, cohesive code instead of procedural commentary or mechanical decomposition. The standard is how easily a developer or agent can trace, test, and safely change a behavior—not file length or the number of helpers.

## Context

RoboRepo distributes cross-language and language-specific conventions through package-owned skills. Agents still produce redundant procedural comments, and current rules can encourage splitting cohesive code into too many files. Guidance must improve code as it is written; existing reviews should catch consequential problems without flagging harmless stylistic differences. Both matter beyond plan-specific workflows.

## Current state

### Coding skills

| File | What it says today | Problem |
| --- | --- | --- |
| `globals/packages/code-style/skills/code-style/SKILL.md` | ~150-line soft limit and ~200-line hard cap (line 19); split large functions into their own file (line 20); extract a helper once duplication appears twice (line 16); split orchestration and execution into separate files when a file has both (`## Orchestrators vs. Execution Functions`); the `## Review Checklist` repeats the size limit and the split. Comment guidance is one line: keep comments for non-obvious architecture, business logic, or justified lint exceptions | Size and file-count rules drive fragmentation; comment guidance is too brief to change behavior |
| `globals/packages/javascript-typescript/skills/javascript-typescript/SKILL.md` | `## Functions` prescribes `function` declarations for utilities and says to keep reusable pure functions in their own file when shared | Reads as mandatory architecture rather than a contextual preference |
| `globals/packages/react/skills/react/SKILL.md` | Avoid procedural comments; derive state rather than syncing it with effects | Sound and React-scoped; no conflict found |
| `globals/packages/tighten/skills/tighten/SKILL.md` | Loads `code-style` for general conventions and requires project-specific, located findings | Restates no size or comment rule; inherits whatever `code-style` says |

No test pins the text of these four skills. The only other place that restates any of these rules is `react`'s one-line comment rule.

### Review rubric

The rubric that grades implementation work exists as **two texts**:

- `globals/packages/plan-execute/skills/plan-execute/references/validation-loop.md` → `## The rubric` is the authoritative copy. Its checklist covers acceptance criteria, observable-outcome tests, docs of record, `## Not tested` entries, gate failures, and loaded paired-skill constraints. It does not ask about cohesion, implicit dependencies, or redundant comments.
- `globals/packages/plan-review/skills/plan-review/SKILL.md` (step 3, the Validator-pass bullet) carries a short inline copy, because `plan-review` cannot load a reference from another package that may be disabled. Plan `[[gqzjlzgx]]` made that choice and already fixed one drift between the two copies.

The rubric classifies findings by who resolves them: `fix` (clear, in-scope fix made in the same session), `escalate` (a real choice for the user), and `base` (a gate failure the base branch also has). There is no non-blocking class. Issues outside the diff that the plan did not cause are not findings; the Validator mentions them once as possible follow-ups.

`scripts/test/plan-suite-skills-check.mjs` pins phrases of `validation-loop.md` and of `plan-review`'s check section, so both rubric texts are under test.

## Goals

- Prefer small, cohesive, declarative functions and thin, understandable orchestration when these improve comprehension.
- Favor pure functions, explicit inputs and outputs, and localized side effects where practical; keep tightly related logic together.
- Require a useful reason to extract a helper, introduce an abstraction, or cross a file boundary. Cohesive long modules remain acceptable.
- Make comments exceptional: preserve non-obvious rationale, constraints, invariants, warnings, and unresolved limitations; avoid step-by-step narration or repeating the code.
- Help agents apply these principles during any code-writing task where the coding skills are loaded, whether or not a plan workflow is involved.
- Have existing review workflows report concrete, consequential convention violations with locations and suggested remedies, without expanding review to unrelated existing code.
- Keep cross-language rules in `code-style` and language/framework-specific rules in the relevant specialized skill.

## Non-goals

- Broad refactoring or reformatting of existing application code as part of this plan.
- File-length, function-length, comment-count, or helper-count thresholds as pass/fail gates.
- A new architecture-lint engine, review phase, agent hook, or duplicate `implementation-review` skill.
- A new finding class or severity scale in the rubric.
- Guaranteed measurement of agent comprehension from static code metrics.
- Replacing valid explanatory comments, including public API contracts, with obscure naming or needless helper functions.
- Introducing mandatory review for ordinary coding work that does not already use one.

## Proposed design

### 1. Conventions centered on responsibilities

Rewrite `code-style` around a small number of principles. A module owns a coherent responsibility; a helper exists because it isolates meaningful logic, supports reuse, or makes its caller noticeably clearer. Orchestrators should communicate the overall flow, while calculations and transformations should be pure where feasible. Dependencies and mutations should be visible at the point of use. Agents should apply these principles while writing code, not rely on review to reorganize the result later. Follow local conventions when they aid consistency, but do not repeat a demonstrably harmful pattern just because it already exists.

Remove the size caps, the rule that moves large functions into their own file, and the rule that two occurrences of similar code justify a helper. Keep the orchestrator/execution distinction as a way to read and write a flow, but drop the instruction to put the two roles in separate files. Prefer placing a local helper next to its consumer when it is not genuinely shared. Avoid turning a straightforward operation into a deep call chain. Rewrite `## Review Checklist` to match, so it no longer checks size limits or mandatory splits.

### 2. Comments communicate information beyond the code

| Case | Desired convention | Reviewer interpretation |
| --- | --- | --- |
| `// Update the state before rendering` next to a clear state assignment | Omit | Redundant procedural narration |
| A heading comment before an already well-named function | Usually omit | Repeats visible structure |
| Section heading that helps navigate an unusually complex algorithm | Allow | Useful navigation that names alone do not provide |
| Public API contract that callers must understand | Keep | Contractual information, not procedural narration |
| Explanation of an unexpected retry rule imposed by an external API | Keep | Reason cannot be inferred from the operation |
| Warning that a fallback deliberately sacrifices accuracy | Keep | Important constraint and uncertainty |
| Comment claiming a fallback returns `other` while the code returns another value | Correct or remove | Misleading behavior description; potentially consequential |

Section 4 says how a reviewer classifies each case. Place short contrasting examples in `code-style`: redundant narration vs self-describing code; justified rationale vs undocumented surprising behavior. Preserve comments explaining invariants, external constraints, public contracts, limitations, and decisions that cannot be expressed clearly in code. Avoid using comments as substitutes for clear names, contracts, types, or tests. When changing code, check nearby affected comments for accuracy as well as necessity. Do not perform a repository-wide comment cleanup.

### 3. Align specialization without multiplying rules

- Keep `javascript-typescript` responsible for JS/TS syntax, types, ESM, and framework-less markup. Reframe declaration-vs-arrow and helper-placement rules in `## Functions` as contextual preferences rather than mandatory architecture. A pure helper does not require its own file merely because it is pure.
- Keep `react` responsible for components, effects, state, markup, and React tests. Current review found no conflict; recheck it against the rewritten `code-style`, leave sound guidance unchanged, and do not copy the `code-style` rubric into it.
- `tighten` needs no change unless the rewritten `code-style` introduces a conflict with its finding format.
- Limit the alignment audit to `code-style`, `javascript-typescript`, `react`, `tighten`, and the two rubric texts. Make the smallest changes needed to resolve identified conflicts.

### 4. Reinforce through the existing review path

`code-style` is the source for principles agents follow when *writing* code, including ordinary tasks outside plan workflows. The shared rubric checks results where an existing workflow invokes review. Do not add mandatory review hooks or duplicate rules across workflow skills beyond the inline copy `plan-review` already carries.

Add three checks to the rubric checklist:

1. **Flow and cohesion:** Can the main execution path be followed, and are responsibilities divided at meaningful boundaries rather than by line count?
2. **Data and state:** Are dependencies, side effects, and state transitions sufficiently explicit to trace and test?
3. **Comments and abstractions:** Do comments add information, and do helpers and shared abstractions reduce rather than increase comprehension cost?

Classify what these checks find with the existing classes:

| What the check finds | Class |
| --- | --- |
| Hidden dependency, tangled responsibilities, or unjustified abstraction in changed or directly affected code, with a concrete comprehension or reliability cost and a clear remedy | `fix` |
| The same, but the remedy chooses between real designs or reshapes an interface the plan did not specify | `escalate` |
| A comment that misstates behavior, in changed or directly affected code | `fix` |
| A comment the diff adds that only restates the code | `fix` (remove it) |
| Harmless redundant narration that was already there, or any other cosmetic preference | Not a finding; at most one follow-up mention |
| A file judged only by its length, or a request for more functions or files without an identified benefit | Never reported |

Every `fix` or `escalate` from these checks names its location, the concrete cost, and a proportionate remedy. Reviewers avoid unrelated pre-existing code unless the change makes it relevant.

Make the edit in the authoritative rubric and mirror it in the inline copy in the same commit:

- If `[[ejsc769o]]` has not shipped: add the checks and classification rows to `validation-loop.md` → `## The rubric`, and add a one-sentence summary of the three checks and the comment rule to `plan-review`'s inline rubric bullet.
- If `[[ejsc769o]]` has shipped: edit the resulting `implementation-review` skill only, since that plan deletes both existing texts. Use its finding format and severity model; do not reintroduce `fix`/`escalate` wording it replaced.

### 5. Test initial writing and review with contrasting cases

Use a small, repeatable set of controlled code-change prompts. For each case, supply the same starting snippet, ask an agent to make a bounded change using the revised skills, then review the resulting diff with the rubric. Record each case in this plan under `## Convention sample`: the prompt, the starting snippet or its location, a trimmed diff, and a one-line result. Do not commit fixture files; the sample is a one-time sanity check, not a permanent benchmark.

| Case | Expected writing behavior | Expected review behavior |
| --- | --- | --- |
| Extend a cohesive module above 200 lines | Keep logic together when responsibilities still align | No size-only finding |
| Modify a simple operation spread across needless wrappers | Prefer direct, traceable flow where change warrants it | Identify material indirection, not file count |
| Change a function accompanied by procedural narration | Avoid adding restatement comments | `fix` for any narration the diff adds; existing narration at most a follow-up mention |
| Modify code with a domain invariant, API contract, or external constraint | Preserve explanatory context | Do not flag useful documentation |
| Change fallback logic with an inaccurate nearby comment | Update the comment or make the rule explicit in code/tests | `fix` when the comment misstates behavior |
| Extend a function mixing unrelated I/O, mutation, and transformation | Make responsibilities and side effects easier to follow | Point to a specific consequential separation opportunity |

Include at least one genuine agent-authored diff, produced by a fresh agent session given only the prompt and the revised skills. Record whether the authoring agent followed guidance and whether review caught material problems without cosmetic false positives. Adjust confusing wording rather than adding numeric scores.

## Related plans

| Plan | Relationship | Effect on this plan |
| --- | --- | --- |
| `[[ejsc769o]]` package required/recommended skills (backlog, depends on unlanded `o9zwxuav`) | Unlanded; overlapping scope | It will move the rubric into a new `implementation-review` skill with a `blocking`/`actionable`/`note` severity model and delete both current texts. This plan edits whichever rubric exists at execution time and owns none of the dependency, activation, or severity work |
| `[[gqzjlzgx]]` plan lifecycle review and ship workflow (review, approved) | Landed dependency; lifecycle pending `/plan-close` | Its reviewed commit is an ancestor of `main`. It created the current rubric, the `fix`/`escalate`/`base` classes, and `plan-review`'s inline copy. This plan extends that rubric and supersedes none of its contract |

## Implementation plan

- [ ] Rewrite `globals/packages/code-style/skills/code-style/SKILL.md`: remove the size caps (line 19), the own-file split (line 20), and the twice-duplicated extraction rule (line 16); reframe `## Orchestrators vs. Execution Functions` without the separate-file mandate; add cohesion, explicit data flow, appropriate purity, and justified-abstraction guidance; rewrite `## Review Checklist` to match. Keep the frontmatter `name` and keep the `description` covering naming, file organization, helper placement, comments, and readability.
- [ ] Add a short comments section to `code-style` with contrasting examples from Section 2: preserve public contracts, invariants, justified navigation headings, and non-obvious rationale; discourage procedural and name-restating comments.
- [ ] Reframe `## Functions` in `globals/packages/javascript-typescript/skills/javascript-typescript/SKILL.md` as contextual preferences. Recheck `react/SKILL.md` and `tighten/SKILL.md` against the rewritten `code-style` and edit only on a real conflict.
- [ ] Determine whether `[[ejsc769o]]` has shipped (does `globals/packages/implementation-review/` exist?). Add the three checks and the classification rows from Section 4 to the authoritative rubric, and mirror a one-sentence summary into `plan-review`'s inline rubric bullet when both texts still exist.
- [ ] Extend `scripts/test/plan-suite-skills-check.mjs` so each rubric text it covers asserts the three checks are present (for example "Flow and cohesion", "Data and state", "Comments and abstractions") and that length alone is never a finding.
- [ ] Run the six sample cases from Section 5, record them under `## Convention sample`, and refine wording where authors ignored guidance or reviewers produced material false positives.
- [ ] Update `docs/internal/skills-and-commands.md`: the plan-suite bullet's rubric description gains the three checks, and the `code-style` entry stays accurate.
- [ ] Run the verification commands under Validation.

## Validation

### Acceptance criteria

- No size threshold or mandatory split remains in the coding skills or the rubric texts. The check below prints nothing (or only lines that permit, rather than require, a separate file):

  ```sh
  grep -n -i -E "lines|hard cap|soft limit|own file|separate files" globals/packages/code-style/skills/code-style/SKILL.md globals/packages/javascript-typescript/skills/javascript-typescript/SKILL.md
  ```
- `code-style` tells agents how to make choices *during implementation*, without requiring a new review stage for non-plan coding.
- `code-style` gives an agent a way to tell a useful long module from an over-fragmented one without line counts.
- `code-style` discourages comments narrating obvious steps, and explicitly keeps non-obvious rationale, invariants, public API contracts, useful navigation headings, constraints, and limitations.
- The rubric includes the three checks and the classification rows; a comment added by the diff that only restates code is a `fix`, and pre-existing harmless narration is not a finding. `plan-review`'s inline copy summarizes the same checks (or, if `[[ejsc769o]]` shipped, only `implementation-review` changed).
- Language-specific skills stay scoped to their languages/frameworks and contain no placement guidance that contradicts `code-style`.
- No dependency metadata, activation logic, or severity model from `[[ejsc769o]]` is created or altered.
- `## Convention sample` records all six cases with prompts and trimmed diffs, including at least one agent-authored diff, and notes any reviewer false positive and the wording change it prompted.

### Verification commands

```sh
node scripts/test/run-checks.mjs --filter plan-suite-skills
npm run test:unit
npm test
bash scripts/doctor.sh --quiet
git diff --check
```

`doctor.sh` and `git diff --check` are the repository's required cleanup gate for package and test changes (`docs/internal/testing.md`). Record any command that cannot run and why.

## Documentation impact

- `docs/internal/skills-and-commands.md`: the plan-suite bullet describes the validation-loop rubric; add the three checks. Revisit the `code-style` entry if its role description changes.
- The package-owned `SKILL.md` files are the authoritative reference for the coding rules themselves. `docs/internal/docs-map.md` needs no change unless a separate doc of record is introduced.
- No user-facing portal or CLI behavior changes are intended, so existing end-user guides should not need an update.

## Risks

- **Over-enforcement:** subjective preferences can create endless style findings. Require demonstrable comprehension/reliability impact for `fix` findings, allow coherent alternatives, and avoid unrelated cleanup.
- **Comment-deletion churn:** making diff-added narration a `fix` could add validation passes. Removal is a one-line change with an obvious answer, and the five-pass cap bounds the loop; if the sample shows reviewers flagging useful comments as narration, tighten the Section 2 examples.
- **Fragmentation in the opposite direction:** removing size rules must not become permission for unrelated responsibilities to accumulate in one module. Judge responsibilities and change boundaries.
- **Rubric drift:** two rubric texts exist until `[[ejsc769o]]` ships. Edit both in one commit, and let the new test assertions catch a later edit that drops the checks from either.
- **Agent-behavior uncertainty:** good review examples do not prove an improvement across every agent. Treat the sample as a sanity check, not a universal AI-performance claim.

## Decision Log

- **2026-10-17** — A comment the diff adds that only restates the code is a `fix` finding; harmless narration that was already there is not a finding. Chosen over treating all redundant comments as non-blocking, because review would otherwise never correct the most common complaint, and the rubric already says size never decides the class.
- **2026-10-17** — Cosmetic preferences map to the rubric's existing follow-up mention, not a new non-blocking class, so this plan adds no severity scale ahead of `[[ejsc769o]]`.
- **2026-10-17** — The authoring/review sample is recorded in this plan rather than as committed fixtures, keeping it a one-time sanity check.
- **2026-10-17** — While both rubric texts exist, the checks go into `validation-loop.md` with a one-sentence mirror in `plan-review`'s inline copy, covered by `plan-suite-skills-check.mjs`.
