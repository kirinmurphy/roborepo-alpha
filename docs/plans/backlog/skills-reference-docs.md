---
id: skill-reference-docs-and-conventions
priority: low
next_action: Compare remaining reference-organization and portal-guidance gaps against the completed compliance work and current review rubric before choosing a second extraction or a new local skill.
blocked_by: []
depends_on: []
related: ["7e21olcs", "ejsc769o"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Skill Reference Docs & Portal Conventions

## Summary

Resolve the remaining choices about skill/reference organization and repository-local portal
guidance. Reuse the shipped markup reference, reference-compliance work, and current review rubric.

## Context

`globals/packages/javascript-typescript/skills/javascript-typescript/references/framework-less-markup.md`
already supplies markup/custom-element guidance. [[k7p3m2q]] and the maintained
`docs/internal/skill-reference-observation.md` cover reference observation/compliance and provide the baseline for any extension. The completed coding-conventions work
[[7e21olcs]] replaced line-count limits with cohesion, ownership, and meaningful boundaries.

`docs/internal/portal-architecture.md` is the portal architecture record and
`local/skills/roborepo-development/` supplies repository development guidance. This plan must route
existing explanations to those owners rather than duplicate them in a new broad conventions doc.

## Goals

- Decide whether independent stack skills or an umbrella with conditional references better
      preserves selection quality and independent invocation.
- Make reference loading understandable without implying model self-report is runtime proof.
- Capture any missing portal-specific guidance at its narrowest useful local owner.
- Keep an automatic end-of-turn review proposal separate from existing explicit workflows.

## Proposed design

| Remaining workstream | Owner and boundary |
| --- | --- |
| Umbrella skill versus independent stack skills | This plan compares a second reference extraction with independent invocation; no conversion is assumed |
| Reference-file visibility | Extend the existing skill-visibility/observation contract only for gaps not delivered by reference compliance |
| Portal conventions | Reuse architecture and framework-less markup docs; add a narrowly triggered local skill only if current local guidance leaves a concrete gap |
| Automatic end-of-turn review | Evaluate as a distinct rule proposal, reusing the existing rubric and future shared `implementation-review` from [[ejsc769o]] |

Portal guidance should explain real responsibility boundaries, pure transformations versus effects,
template filling, behavior-owning custom elements, singleton dialog controllers, and shared CSS
promotion after actual reuse. It must not mandate a five-file layout or split by line count.

## Implementation plan

- [ ] Compare a second reference extraction with independent stack-skill invocation and record the
      tradeoff before choosing an umbrella model.
- [ ] Recheck completed reference-compliance and current visibility behavior; isolate any remaining
      reporting gap before changing package output rules.
- [ ] Audit portal architecture and the local development skill for concrete missing guidance;
      extend the current owner or add the narrowly scoped portal skill only where it adds value.
- [ ] Evaluate the automatic end-of-turn rule separately from user-invoked `/tighten` and plan
      review; reuse the shared rubric and define scope, ordering, and failure/retry behavior before
      enabling an always-on gate.

## Validation

Compare activation on representative language, framework, and near-miss prompts. Verify reference
reporting distinguishes self-report from observed reads. Review portal guidance against current
templates and components without introducing mechanical file splits. If an automatic gate is
approved, prove it reviews only the intended changed scope and cannot loop indefinitely after
mechanical-check failure. Run package/rule/skill checks for implemented shared content changes.

## Documentation impact

Update `docs/internal/skills-and-commands.md`, `docs/internal/skill-reference-observation.md`, and
`docs/internal/portal-architecture.md` only where their owned behavior changes.

## Open questions

- Should stack skills remain independently invokable under an umbrella model?
- Which reference-visibility gaps remain after the completed compliance work?
- Is an always-on review gate worth its task cost, and where should the user opt into it?
