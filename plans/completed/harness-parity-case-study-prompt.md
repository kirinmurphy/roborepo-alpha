---
id: harness-parity-case-study-prompt
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Case study prompt — "Same agent, two dialects: a parity story"

A ready-to-run prompt for the `/case-study` skill. Paste the **Prompt** section into `/case-study`. The rest is
context for whoever runs it.

---

## Prompt

> Write a long-form architecture case study about how RoboRepo keeps two AI coding harnesses — Claude
> Code and Codex — in configuration parity. The source material is
> `docs/internal/harnesses-explained.md`; read it first and treat its seven-step
> "amount of machinery" progression as the backbone of the post.
>
> The thesis: parity is not "automate everything." It's spending exactly as much machinery as the
> divergence between the two harnesses actually demands — from "stamp a copy" up to "don't try to
> unify this at all, on purpose." The post should make a reader feel that escalation as a story, with
> each step adding tension because the two harnesses pull a little further apart.
>
> Audience is the full spectrum, non-technical to expert. A smart non-engineer should follow the
> whole argument; an engineer should still find the design judgment sharp. Lead with a concrete
> analogy for the core problem before any code: two countries with the same laws written in different
> legal languages — you draft the law once and translate, until you hit a law that means something
> genuinely different in each country and translation breaks down. Keep code blocks minimal and always
> in service of the idea, never as a tutorial. Define every piece of jargon on first use (harness,
> hook, skill, MCP, render vs symlink).
>
> The climax is hooks — the element where the harnesses disagree on *meaning*, not just shape (one
> obeys a hook's output as a command, the other displays it as text), so automation honestly gives up
> and the behavior is authored twice. The denouement is root config — the element we deliberately
> *don't* unify because per-machine difference is the correct behavior there. End on the inverted
> lesson: the goal was never maximum automation; it was matching the tool to the gap, and being honest
> where no clean abstraction exists.
>
> Do not turn this into a `roborepo` command reference — that lives in `harness-anatomy.md`. This is
> the "why," not the "how."

---

## Why this post works (context for the author)

- **The spine already exists.** `harnesses-explained.md` was rewritten specifically so its
  basic→niche ordering doubles as a narrative arc. Follow it; don't reinvent the structure.
- **Divergence is the engine, not the headline.** The reader should care about "how do you keep two
  things in sync," and feel the divergence as the rising difficulty — not be handed a taxonomy of
  differences up front.
- **The four axes of divergence** (name / format / location / semantics) are the hidden mechanism
  behind every step. Surface them naturally as they become relevant rather than as a list.
- **Two honest exceptions are the payoff** — hooks (authored twice) and root config (not unified).
  They're what make the post about judgment instead of cleverness. Land them hard.

## What to leave out

- Per-element `roborepo` commands and `--check` flows (belongs in anatomy).
- Filesystem/symlink internals beyond what the analogy needs (belongs in `architecture.md`).
- The five-step renderer recipe — too implementation-deep for this audience; mention that a generator
  exists, not how it loops.

## Source map

| Need | Read |
| --- | --- |
| The narrative spine + every takeaway line | `docs/internal/harnesses-explained.md` |
| Exact commands / source locations (for fact-checking only) | `docs/internal/harness-anatomy.md` |
| Symlink + install mechanics (for the analogy's grounding) | `docs/user/reference/architecture.md` |
| Hook specifics (Claude JSON-control vs Codex text) | `docs/user/reference/claude-hooks.md`, `codex-hooks.md` |
