---
id: 7e21olcs
priority: high
next_action: Capture a small baseline of agent-authored code, revise the coding skills and shared review rubric, then compare the same tasks once using the revised guidance.
blocked_by: []
depends_on: []
related:
  - ejsc769o
reviewed_commit:
worktree:
---

# Make Coding Conventions Clearer and More Consistently Applied

## Summary

Improve RoboRepo's shared coding skills and their use in implementation review so agents favor comprehensible, cohesive code instead of procedural commentary or mechanical decomposition. The standard is how easily a developer or agent can trace, test, and safely change a behavior—not file length or the number of helpers.

## Context

RoboRepo distributes cross-language and language-specific conventions through package-owned skills. Agents still produce redundant procedural comments, and current rules can encourage splitting cohesive code into too many files. Guidance must improve code as it is written; existing reviews should catch consequential problems without flagging harmless stylistic differences. Both matter beyond plan-specific workflows.

## Current state

- `globals/packages/code-style/skills/code-style/SKILL.md` sets a ~150-line soft limit and ~200-line hard cap; it also prescribes file separation for sufficiently complex orchestration and execution. Its comment guidance already discourages procedural narration, but is brief.
- `globals/packages/javascript-typescript/skills/javascript-typescript/SKILL.md` has useful type/module rules, but prescribes function declaration style and places shared pure functions in separate files. Neither choice should become a reason for unnecessary movement or fragmentation.
- `globals/packages/react/skills/react/SKILL.md` advises against procedural comments and unnecessary React effects. It should apply only to React work.
- `globals/packages/plan-execute/skills/plan-execute/references/validation-loop.md` currently holds the shared rubric used by `plan-execute` and `plan-review`. It checks loaded skill constraints but does not explicitly ask reviewers to examine cohesion, implicit dependencies, or redundant comments.
- The existing backlog plan `[[ejsc769o]]` (`package-add-required-and-recommended-skills-and-references.md`) already proposes a shared `implementation-review` skill and package relationships. This plan changes the *substance* of coding conventions and review criteria, not that dependency infrastructure.

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
- Guaranteed measurement of agent comprehension from static code metrics.
- Replacing valid explanatory comments, including public API contracts, with obscure naming or needless helper functions.
- Introducing mandatory review for ordinary coding work that does not already use one.

## Proposed design

### 1. Conventions centered on responsibilities

Rewrite `code-style` around a small number of principles. A module owns a coherent responsibility; a helper exists because it isolates meaningful logic, supports reuse, or makes its caller noticeably clearer. Orchestrators should communicate the overall flow, while calculations and transformations should be pure where feasible. Dependencies and mutations should be visible at the point of use. Agents should apply these principles while writing code, not rely on review to reorganize the result later. Follow local conventions when they aid consistency, but do not repeat a demonstrably harmful pattern just because it already exists.

Remove the size caps, mandatory file splits, and any guidance suggesting that two occurrences of similar code automatically justify abstraction. Prefer placing a local helper next to its consumer when it is not genuinely shared. Avoid turning a straightforward operation into a deep call chain.

### 2. Comments communicate information beyond the code

| Case | Desired convention | Reviewer interpretation |
| --- | --- | --- |
| `// Update the state before rendering` next to a clear state assignment | Omit | Redundant procedural narration; minor cleanup in changed code |
| A heading comment before an already well-named function | Usually omit | Repeats visible structure |
| Section heading that helps navigate an unusually complex algorithm | Allow | Useful navigation that names alone do not provide |
| Public API contract that callers must understand | Keep | Contractual information, not procedural narration |
| Explanation of an unexpected retry rule imposed by an external API | Keep | Reason cannot be inferred from the operation |
| Warning that a fallback deliberately sacrifices accuracy | Keep | Important constraint and uncertainty |
| Comment claiming a fallback returns `other` while the code returns another value | Correct or remove | Misleading behavior description; potentially consequential |

Place short contrasting examples in `code-style`: redundant narration vs self-describing code; justified rationale vs undocumented surprising behavior. Preserve comments explaining invariants, external constraints, public contracts, limitations, and decisions that cannot be expressed clearly in code. Avoid using comments as substitutes for clear names, contracts, types, or tests. When changing code, check nearby affected comments for accuracy as well as necessity. Do not perform a repository-wide comment cleanup.

### 3. Align specialization without multiplying rules

- Keep `javascript-typescript` responsible for JS/TS syntax, types, ESM, and framework-less markup. Reframe declaration-vs-arrow and helper-placement rules as contextual preferences rather than mandatory architecture. A pure helper does not require its own file merely because it is pure.
- Keep `react` responsible for components, effects, state, markup, and React tests. Inspect for genuine conflicts; leave sound guidance unchanged and do not copy the full `code-style` rubric into it.
- Limit the initial alignment audit to `code-style`, `javascript-typescript`, `react`, `tighten`, and direct consumers of the shared review rubric (including `plan-execute` and `plan-review`). Make the smallest changes needed to resolve identified conflicts.

### 4. Reinforce through the existing review path

`code-style` is the source for principles agents follow when *writing* code, including ordinary tasks outside plan workflows. The shared implementation-review rubric checks results where an existing workflow invokes review. Do not add mandatory review hooks or duplicate rules across workflow skills.

The review rubric's source of truth must include three explicit checks:

1. **Flow and cohesion:** Can the main execution path be followed, and are responsibilities divided at meaningful boundaries rather than by line count?
2. **Data and state:** Are dependencies, side effects, and state transitions sufficiently explicit to trace and test?
3. **Comments and abstractions:** Do comments add information, and do helpers and shared abstractions reduce rather than increase comprehension cost?

A finding that requires a fix must identify a changed or directly affected location, a concrete comprehension or reliability cost, and a proportionate remedy. Misleading comments, hidden dependencies, or tangled responsibilities can justify fixes when their impact is material. Cosmetic preferences (including harmless redundant comments) should be non-blocking suggestions or omitted; they must not trigger repeated rewrites. Reviewers should avoid unrelated pre-existing code unless a change makes it relevant. Never flag a file based on length alone or insist on more functions/files without an identified benefit. Use the current review system's existing classifications, without creating a new severity scale.

Apply these checks in the **single rubric already used by implementation and plan review**. Today that is `plan-execute/references/validation-loop.md`; if `[[ejsc769o]]` has shipped by execution time, update the resulting shared `implementation-review` skill instead. Keep callers pointing at one source. Do not recreate its proposed severity model or package dependency system.

### 5. Run a one-time before-and-after validation

Before editing the skills, capture baseline outputs for **2–3 bounded code-change prompts** using the current conventions. After updating the skills and review rubric, run those **same prompts against the same starting code** with the revised guidance. Compare the resulting agent-authored code and existing-review findings for readability, cohesion, useful comments, unnecessary fragmentation, and consequential versus cosmetic review findings.

Choose the 2–3 tasks from the contrasting cases below, covering both code generation and review. Preserve each prompt, starting snippet, before/after diff, applicable skill version, and a brief qualitative finding. Outputs can vary between agent runs, so treat comparisons as directional evidence, not a statistically controlled benchmark. If the changes have not improved the outcomes, adjust the wording and document the reason.

| Case | Expected writing behavior | Expected review behavior |
| --- | --- | --- |
| Extend a cohesive module above 200 lines | Keep logic together when responsibilities still align | No size-only finding |
| Modify a simple operation spread across needless wrappers | Prefer direct, traceable flow where change warrants it | Identify material indirection, not file count |
| Change a function accompanied by procedural narration | Avoid adding restatement comments | Optional non-blocking cleanup for harmless existing narration |
| Modify code with a domain invariant, API contract, or external constraint | Preserve explanatory context | Do not flag useful documentation |
| Change fallback logic with an inaccurate nearby comment | Update the comment or make the rule explicit in code/tests | Require correction when it misstates behavior |
| Extend a function mixing unrelated I/O, mutation, and transformation | Make responsibilities and side effects easier to follow | Point to a specific consequential separation opportunity |

This comparison is a **temporary acceptance check for this plan**, not a recurring requirement. Keep its findings in the plan completion record as historical evidence; do not introduce permanent fixtures, scripts, scoring, or evaluation infrastructure.

## Implementation plan

- [ ] Before changing the coding skills, select 2–3 representative prompts from the contrasting cases and retain baseline agent outputs under the current conventions. Use existing tools; do not build a benchmark harness.
- [ ] Update `code-style/SKILL.md`: eliminate hard/soft size caps, mandatory file splitting, and automatic extraction rules; add cohesion, explicit data flow, appropriate purity, and justified abstraction guidance.
- [ ] Add concise contrasting comment examples; preserve public contracts, invariants, justified navigation headings, and non-obvious rationale while discouraging procedural or name-restating comments.
- [ ] Align `javascript-typescript/SKILL.md`; inspect `react/SKILL.md` and `tighten` for actual conflicts and edit only where necessary. Limit additional review to direct rubric consumers.
- [ ] Ensure `code-style` applies during initial code writing, including outside plan workflows when loaded; locate the authoritative shared review rubric at execution time, add the three focused checks, and keep existing callers using that single rubric.
- [ ] Check compatibility with the pending `[[ejsc769o]]` review-skill rollout. Preserve its ownership of dependency metadata, skill activation, and severity classification.
- [ ] Rerun the same 2–3 prompts against unchanged starting code using the revised skills and review rubric. Compare the outputs and review findings qualitatively; refine wording if results expose a clear weakness. Record the comparison once as plan completion evidence.
- [ ] Update affected skill/review documentation and run repository-native validation.

## Validation

- No size thresholds or mechanically required function/file splits remain in the applicable coding skills or review rubric.
- The revised coding skill tells agents how to make choices *during implementation*, without requiring a new review stage for non-plan coding.
- An agent can distinguish a useful long module from an over-fragmented implementation without using line counts.
- Comments narrating obvious steps are discouraged; non-obvious rationale, invariants, public API contracts, useful navigation headings, constraints, and limitations remain acceptable.
- Existing review workflows surface actionable findings for unclear flow, hidden dependencies, unjustified abstraction, or misleading comments. Fix-required findings identify concrete impact within changed or directly affected code; harmless style differences do not block completion.
- Language-specific skills remain scoped to the relevant languages/frameworks, without contradictory placement guidance; unaffected React guidance need not change.
- Review guidance has a single owner and does not duplicate or block the package relationship work under `[[ejsc769o]]`.
- A one-time, before-and-after comparison of 2–3 identical agent coding tasks documents the baseline and revised outputs, including useful comment preservation, unnecessary fragmentation, and reviewer false positives. Record findings with plan completion; no permanent benchmarking process is required.
- Run `npm run test:unit` for affected skill, package, and plan-suite checks. Run `npm test` for any changed review workflow contracts; broaden verification only if other code or manifests change. Record any tests that cannot run and why.

## Documentation impact

- `docs/internal/skills-and-commands.md`: update the maintainer explanation of code-style helpers and shared implementation-review ownership if the contract or its source location changes.
- The package-owned `SKILL.md` files are the authoritative reference for the coding rules themselves. `docs/internal/docs-map.md` needs no change unless a separate doc of record is introduced.
- No user-facing portal or CLI behavior changes are intended, so existing end-user guides should not need an update.

## Risks

- **Over-enforcement:** subjective preferences can create endless style findings. Require demonstrable comprehension/reliability impact for fix-required findings, allow coherent alternatives, and avoid unrelated cleanup.
- **Fragmentation in the opposite direction:** removing size rules must not become permission for unrelated responsibilities to accumulate in one module. Judge responsibilities and change boundaries.
- **Skill coordination:** `[[ejsc769o]]` may move the review rubric while this plan is active. Resolve the owner at execution time and make only one authoritative edit.
- **Agent-behavior uncertainty:** results vary between runs and cannot prove improvement across every agent. Treat the one-time before-and-after comparison as directional evidence, not a universal AI-performance claim.
