# Skills And Slash Commands

## Purpose

This document defines the maintainer distinction between skills, slash commands,
and always-on rules in this repo. The goal is one consistent model for deciding
where a workflow belongs and how Claude/Codex should expose it.

For users, the simpler distinction is interaction behavior:

- automatic helpers have no slash command and are loaded by the agent when
  relevant
- explicit commands are started by the user with `/name`
- some workflows also have plain-language triggers such as "capture this"

The skill-backed vs standalone distinction is implementation detail for
maintainers. Consumer docs should list command-backed workflows under explicit
commands, even when those workflows can also be triggered in ordinary chat.

## Short Model

| Mechanism                  | What it owns                       | How it starts                                                   | Best for                                                           |
| -------------------------- | ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| Always-on rule             | Small universal behavior           | Every turn                                                      | Tiny defaults and reminders                                        |
| Skill                      | Reusable agent workflow or context | Natural-language match, explicit skill call, or command wrapper | Workflows that should be available from more than one trigger path |
| Skill-backed slash command | Explicit user entry point          | `/name`                                                         | Discoverable/manual access to a skill workflow                     |
| Standalone slash command   | Command-specific workflow          | `/name`                                                         | Workflows that only make sense as a command                        |
| Hook                       | Mechanical enforcement             | Harness event                                                   | Deterministic behavior the model should not decide                 |

Standalone commands are not skills. They are command source files rendered into
one or more harness command directories. That distinction should not be the main
user-facing explanation.

## What Reusable Means

Reusable does not mean the workflow persists across the whole chat. Most skills
and commands are loaded only for the current turn or current task.

Reusable means the same workflow body is useful from multiple entry points:

- the user says a natural phrase such as "capture this"
- the user invokes a slash command such as `/plan-write`
- the user explicitly names a skill
- a future command or harness wrapper should reuse the same instructions

When that is true, the workflow body should usually be a skill, and slash
commands should be thin entry points into that skill.

## Skills

A skill owns reusable task guidance. It should answer:

- when the workflow applies
- when it does not apply
- what steps the agent follows
- what output or verification pattern the user should expect

Use a skill when the user might reasonably ask for the workflow in ordinary
language and the same instructions should apply.

Examples:

- `code-style`: implicit helper skill; no slash command needed.
- `javascript-typescript`: implicit helper skill; no slash command needed.
- `react`: implicit helper skill; no slash command needed.
- `plan-write`, `plan-promote`, `plan-start`, `plan-close`: the plan suite, one
  atomic lifecycle step each, behind the matching slash command. None takes a mode
  argument; deterministic plan rules live in `roborepo plans validate` and
  `roborepo plans start`, which every suite skill runs.
- `tighten`: explicit-only review/fix workflow behind `/tighten`.
- `session-close`: explicit-only session close-out workflow (review, docs, commit,
  handoff note) behind `/session-close`.

## Skill-Backed Slash Commands

A skill-backed slash command is a user-facing shortcut into a skill. It should
not duplicate the skill body. It should say which skill to load and then defer
to that skill.

From a user's perspective, this is just an explicit command. They do not need to
know that the implementation points at a skill.

Use a skill-backed command when:

- the workflow has a name users will remember
- explicit invocation improves control or discoverability
- the workflow body is useful outside slash command syntax
- Claude and Codex should share the same behavior where possible

Current generated examples:

- `/case-study` -> `case-study`
- `/frontend-design` -> `frontend-design`
- `/plan-write` -> `plan-write`
- `/plan-promote` -> `plan-promote`
- `/plan-start` -> `plan-start`
- `/plan-close` -> `plan-close`
- `/tighten` -> `tighten`
- `/session-close` -> `session-close`

## Standalone Slash Commands

A standalone slash command is not a skill. Its source file is the command body.

From a user's perspective, this is still just an explicit command. The
standalone detail matters only when maintaining command source and harness
availability.

Use a standalone command when:

- the workflow is only meaningful as an explicit command
- command frontmatter is the important interface, such as tool grants
- the command is harness-specific
- there is no useful natural-language or skill entry point to preserve

Standalone commands are valid, but they should be rarer than skill-backed
commands. If the same workflow should run from both chat phrasing and slash
syntax, prefer a skill-backed command.

## Capture Convention

Convention capture has three parts:

| Part                                        | Mechanism           | Why                                                                                |
| ------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| Flag possible captures during normal work   | Always-on rule      | The agent should notice confirmed decisions without writing files                  |
| Run the capture workflow when the user asks | Normal chat request | The user can say where to write the capture, such as `CLAUDE.md`, a skill, or docs |

Capture does not currently need a slash command. The useful product behavior is
the observer: the agent flags likely capture candidates. Once the user sees that
flag, they can make an ordinary chat request such as "update CLAUDE.md with
this" or "add this to the plan-write skill."

If capture later grows a stricter multi-step workflow that users should invoke
by name, make it a skill-backed command. Until then, keep it as a default-on
observer behavior (the toggleable convention-capture rules package) plus normal
chat.

## Plan And Tighten

These two ideas resolved into different mechanisms, not two parallel commands.

**Tighten** is a real explicit-only skill behind `/tighten`. Its body reviews a
scope against `code-style` (plus `javascript-typescript` / `react` as the files
require) and Project Context inventory facts, classifies issues, makes scoped
fixes, and verifies. It must not silently trigger from vague prompts such as
"make this better"; it runs only when explicitly invoked.

**Plan** did not become a command. The useful product behavior — surfacing how a
proposed change collides with or duplicates existing functionality — is the
**Impact Awareness** convention (a `> 🧭 Impact:` inline flag), a default-on
toggleable observer behavior with the same shape as convention capture. It needs
no slash command because the value is the proactive flag, not a named workflow. The deeper architecture-fit
analysis happens conversationally once the flag surfaces.

## Decision Rules

Use this order:

1. If behavior must happen every turn and is short, use an always-on rule.
2. If behavior must happen mechanically on a harness event, use a hook.
3. If the workflow body is reusable from chat phrasing, explicit skill calls, or
   slash commands, use a skill.
4. If users need a memorable explicit entry point to a skill, add a
   skill-backed slash command.
5. If the workflow only makes sense as a command, use a standalone slash
   command.

## Source Of Truth

Skill invocation policy lives on package `skill` resources:

- `globals/packages/<package>/package.config.json`
- workspace `packages/<package>/package.config.json`

Slash command exposure lives on package `slash-command` resources:

- `globals/packages/<package>/package.config.json`
- workspace `packages/<package>/package.config.json`

The renderer writes harness-specific command files, per package:

- `generated/packages/<packageId>/claude/commands/*.md`
- `generated/packages/<packageId>/codex/commands/*.md`

Generated files should not be edited directly. Edit the package config or the shared source file,
then run:

```sh
roborepo skill render-commands
roborepo skill render-commands --check
```

For new entries, prefer the scaffold:

```sh
roborepo skill new
```

The scaffold asks whether to create:

- `auto`: an automatic helper skill with no slash command
- `skill-command`: a skill plus a slash-command entry point
- `standalone`: a slash command with no skill

It updates package config, source files, README tables, generated outputs, and
generated command files together.

## Skill Storage and Fan-Out

Package-owned skills live at `globals/packages/<package>/skills/<name>/SKILL.md` in version control.
The required base support skill remains a system skill at
`globals/system/skills/builtin-support/SKILL.md`.
At install/update time, enabled shared skills are materialized into
`~/.roborepo/skills/<name>` and each harness's native skills dir symlinks to that cache entry:
`~/.claude/skills/<name>` and `~/.codex/skills/<name>`. Roborepo-owned cache entries carry a
`.builtin-managed` marker. There is no intermediate `globals/claude/skills/` directory.

Roborepo manages only the skill names it owns. Skills created out-of-band (via
native `init_skill.py` or `skill-installer`) at unrecognized names are left
untouched. They appear as adoptable drift in `roborepo doctor --installed` and
the SessionStart nudge. Inspect a skill before changing ownership:

```sh
roborepo skill inspect <name> # read-only source/ownership/native metadata/harness-state report
```

To bring an unmanaged native skill under version control:

```sh
roborepo skill adopt <name>   # move into a package-owned skill source, re-link, update package config
```

## Memory — Defer

Both harnesses have native persistent memory: Codex (`~/.codex/memories/`,
`memories_*.sqlite`) and Claude (`/memory` under `~/.claude/projects/*/memory/`).
Memory is per-machine, per-session, written continuously at runtime, and has no
stable export contract. roborepo does not manage, sync, or carry memory across
machines. `roborepo update` does not restore memory. This is a deliberate stance
(Defer), not a gap.

## Two Skill Layers: Shared vs. Internal

There are two distinct, firewalled skill layers:

- **Shared** — package-owned `globals/packages/<package>/skills/<name>/` plus the required system
  `globals/system/skills/builtin-support/`. Materialized into `~/.roborepo/skills/<name>` and
  symlinked from each installed harness's native skills dir at install/update time; global on both
  harnesses and exportable to other repos when package-owned. Advisory coding skills any repo may
  receive.
- **Internal** — `local/skills/<name>/`, linked **only** into this repo's own project-scope
  dotdirs (`.claude/skills`, `.codex/skills`) by `link-skills.sh`. These describe how to
  develop/maintain this repo and are **never** global and **never** exported. The separation is
  structural: the export/installer tools read package-owned and system shared skill sources, with
  no code path to `local/skills/`.
