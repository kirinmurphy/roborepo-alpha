---
id: skill-reference-docs-and-conventions
priority: low
next_action: Do one more reference-doc extraction to test the code-style-umbrella pattern before deciding whether stack skills become references
blocked_by: []
depends_on: []
related: []
reviewed_commit: b8684ef
---

# Skill Reference Docs & Portal Conventions

> **Status: PARTIAL.** One concrete change shipped (`javascript-typescript`'s
> framework-less-markup reference doc). Everything else below is a decision
> record plus a follow-up list — deliberately not built yet, pending the
> reference-doc pattern proving out.

## Purpose

Two things surfaced while doing the `portal/config/` web-components refactor
(now shipped — see `docs/plans/completed/portal-config-web-components-plan.md`;
the earlier `plans/` refactor doc it references has since been removed):

1. The `javascript-typescript` skill's "Building Markup" guidance was wrong
   for a framework-less project in a way that would have flagged the correct
   pattern (light-DOM custom elements) as a violation.
2. Doing two portal-page refactors back to back exposed real, non-obvious
   conventions (file-split shape, when to promote something to a custom
   element, dialog-vs-panel-factory, CSS hoist discipline) that aren't
   visible from reading any single file, and aren't captured anywhere an
   agent would find them mid-task.

This doc records the decisions made about where that knowledge should live,
what shipped, and what's intentionally deferred.

## What shipped

**`globals/packages/javascript-typescript/skills/javascript-typescript/references/framework-less-markup.md`**

Extracted the "Building Markup" section out of the main `SKILL.md` body into
a reference doc, following the same pattern `plan-write` already uses
(`plan-write/skills/plan-write/references/*.md`, conditionally read per
subcommand). `SKILL.md` now has a two-line pointer instead of the full
section:

```
- If the project has no component framework (no React/Vue/Svelte/Astro or
  similar) and the task involves building DOM structure directly, read
  `references/framework-less-markup.md` before hand-assembling elements.
- Otherwise, use the project's existing framework/templating mechanism.
```

The reference doc itself covers:

- The original rule (no hand-assembled multi-element DOM via chained
  `createElement`/`appendChild`; use `<template>` + slot-fill instead).
- **New**: a concrete test for when to promote a template-fill into a
  light-DOM custom element — owns a listener/async state/error handling
  itself, or eliminates real duplicated logic across 2+ call sites (not just
  similar-looking markup) — with explicit signals for and against.
- **New**: the web-component conventions established across both portal
  refactors — light DOM (no shadow DOM), data/callbacks in via properties
  not attributes, bubbling `CustomEvent`s instead of importing app-level
  modules directly (avoids a layering inversion), whole-subtree re-render on
  property set rather than `attributeChangedCallback` fine-graining, one
  ES module per element + a barrel for registration.

Synced via `roborepo skill sync-global`; confirmed materialized at
`~/.roborepo/skills/javascript-typescript/references/framework-less-markup.md`.

## Why a reference doc, and why this one first

Skills in this repo are trigger-matched independently by `description`
frontmatter — see `docs/internal/skills-and-commands.md`. There is
no cross-skill loading mechanism; a reference doc is not a special
construct either harness understands, it's just a file the skill's body
tells the agent to `Read` conditionally. `plan-write` already proves this
works: the top-level `SKILL.md` stays the trigger-matched entry point, and
its body fans out to `references/*.md` based on which subcommand applies.

Framework-less markup was picked as the first test case because it's a
clean, low-risk instance of the pattern: a genuinely rare branch (most
JS/TS work has a framework) that was previously bloating the main skill
body for the common case. If this proves out, the same fan-out shape is a
candidate for broader use (see Deferred, below) — but that's explicitly not
decided yet. One data point isn't a pattern.

## Deferred (not built this round)

Recorded here so the reasoning isn't lost, not because it's approved work.

### `code-style` as the umbrella trigger, stack skills as references

Current shape: `code-style`, `javascript-typescript`, `react`, etc. are
independent skills, each with its own narrow trigger description. Proposed
shape: `code-style`'s trigger ("any time you write or audit code") is
already a coherent, accurate universal condition — so `code-style` could be
the thing that always loads first, then conditionally reads
`references/javascript-typescript.md`, `references/react.md`,
`references/astro.md`, `references/go.md`, etc. based on what the touched
files actually are, the same way `plan-write` fans out by subcommand.

This is different from (and better than) an earlier version of this idea
that got rejected during discussion: collapsing all stack-specific skills
into *one* skill's trigger description. That fails because the trigger
description would need to accurately describe the union of every
language/framework case to know when to fire — either over-broad (fires
when it shouldn't) or unreadably long. Keeping `code-style` as the single
umbrella trigger and letting per-stack *references* do the narrowing avoids
that: the trigger stays simple and accurate, the stack-specific detail
moves to conditionally-read files instead of conditionally-matched
descriptions.

Open question before building this: whether per-stack skills should still
also exist as independently-triggerable skills (for a task that's
unambiguously "fix this React hook" with no other code-style framing), or
whether they should become references only. Test with one more reference
extraction before deciding.

### End-of-turn inference-based validation persona

Distinct from `/tighten` (user-invoked, comprehensive, scans code that may
predate the session). This is: **self-invoked, always-on, scoped to what
changed this turn**, gating the response before returning to the user.
Sequence discussed:

1. Agent does work.
2. Agent does more work (possibly several times).
3. Code ready to hand back — at this point, not after every edit:
   - Run an inference-based conventions check against what changed this
     turn (does it match code-style / stack-skill conventions).
   - Only after that passes, run mechanical checks (lint/test/build).
   - Mechanical-check failures do not feed back into another skill-driven
     rewrite pass within the same gate — this is a pass/fail gate, not a
     second editing loop, to avoid a rewrite→lint→rewrite oscillation.

This is structurally triggered (before ending a turn that produced code
changes), not natural-language-matched, so per
`docs/internal/skills-and-commands.md`'s decision rules it
belongs as an **always-on rule** addition (like the existing Verification
section in global `CLAUDE.md`), not a skill. Not drafted yet.

### Reference-file visibility in chat-time output

The existing `> 🧩 Skills loaded:` line (`globals/packages/skill-visibility/rules.md`)
is explicitly self-reported by the model, not harness-verified. Since a
reference file read is just a normal `Read` call made during a skill's
execution, the same self-report mechanism can name it — e.g.
`Skills loaded: javascript-typescript (references: framework-less-markup.md)`.
No new mechanism needed, just a wording change to `skill-visibility/rules.md`.
Not built yet — do it alongside or after the `code-style`-umbrella work
above, since that's when reference-file loading becomes common enough to be
worth surfacing.

### Portal-specific conventions as a repo-local skill

Decided: a new repo-local skill (alongside the existing
`roborepo-development` skill), not a `roborepo-development` section and not
a `CLAUDE.md` addition — scoped to `portal/` so it only loads when touching
portal files, and separate from `roborepo-development`'s much broader
CLI/install/rules-generation scope. Not written yet.

Content should **not** hardcode the 5-file split (state/api/templates/
panels/app) as *the* required shape — that's one example, not the rule.
The generalizable principle is splitting by responsibility axis:

- **Pure logic** — deterministic, no DOM/network side effects. This
  includes response-shaping/mapping code around a fetch call, not just
  filter/sort predicates — the fetch call itself is what's impure, not the
  shaping logic wrapped around it. (Earlier draft of this doc had "pure"
  and "I/O" as two separate axes; collapsed into one, since the
  distinguishing property is determinism, not proximity to an I/O call.)
- **View construction** — markup/DOM building, no business logic.
- **Self-contained reusable units** — components/custom elements that own
  their own behavior; this is where the promote-to-custom-element test from
  `framework-less-markup.md` applies.
- **Orchestration** — wiring, event listeners, side-effect triggering; the
  only place state and impurity are expected to live.

Terseness (line-count caps) should be treated as a smell *detector*, not
the target — "can I hold this file's one responsibility in my head" is the
actual goal. Note this explicitly, because `code-style`'s global cap
(150 soft / 200 hard) is already exceeded by the portal's own reference
implementation (`portal/plans/app.js` at 262 lines) — flagged as existing
debt, not sanctioned precedent, so the portal skill should point at the cap
as something to fix opportunistically rather than override it.

Also belongs in this skill once written: the custom-element promotion test
(shared with `framework-less-markup.md`, but with portal-specific examples
— `<bucket-control>` vs. `<config-toggle>`'s borderline call), the
dialog-vs-panel-factory decision (native `<dialog>` for N-instance/
declaratively-authored units, panel-factory functions for page-singleton
chrome), and the CSS hoist discipline (shared rules move to
`portal/shared/base.css` only once two pages provably need the identical
rule; page-specific extras stay local; defer hoisting anything that would
require guessing a shared shape from only one migrated page).

## References

- `docs/plans/completed/portal-config-web-components-plan.md` — the config
  refactor (shipped); contains the concrete file-split map and custom-element
  verdicts that motivated this doc.
- `docs/internal/skills-and-commands.md` — skill vs. rule vs. hook
  decision model; source for the always-on-rule call on the validation
  persona and the reference-doc mechanism explanation.
- `globals/packages/plan-write/skills/plan-write/` — the existing
  skill+references precedent this doc's shipped change followed.
