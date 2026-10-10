---
id: skills-vs-commands-invocation-policy
priority: low
next_action: Decide how skill-backed commands should present in Claude Code, where the skill and its generated command shim both list (see section 3a option table); applies to all seven packages that ship one.
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Skills vs. Commands: Invocation & Risk Policy

> **Status: ACTIVE.** Package-owned skill and slash-command resources, the baseline audit doc, and
> slash-command rendering shipped. Remaining work: trigger or risk reclassifications.

## Purpose

Users should be able to predict when a skill will shape the agent's behavior.
Auto-loaded skills are useful when they add harmless background knowledge. They
are frustrating when they silently change tone, task mode, output structure, tool
use, or security posture.

This policy answers three user-facing questions:

- Why did the agent act differently on this turn?
- How do I make a workflow start only when I ask for it?
- How do we keep Claude and Codex behavior aligned?

## Current Behavior

| Mechanism       | Source location                                                                                                                                     | Invocation                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Always-on rules | `globals/system/rules/shared/` + `globals/system/rules/<harness>/` rendered into `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`                                   | Every turn                                                        |
| Shared skills   | `globals/system/skills/<name>/` (mandatory) or `globals/packages/<pkg>/skills/<name>/` (package-owned), copied into installed harness skill dirs when enabled (`~/.claude/skills/<name>`, `~/.codex/skills/<name>`) | Auto-invokable and command-invokable when the harness supports it |
| Slash commands  | `generated/packages/<pkg>/<harness>/commands/<name>.md`, composed into the live harness commands dir only when that package is enabled                                                                                                                | Manual `/name` only                                               |
| Hooks           | System: `globals/system/hooks/<harness>/` + `generated/claude/settings.json` / `generated/codex/hooks.json`. Package-owned: `globals/packages/<pkg>/hooks-<harness>.json`, composed in only when that package is enabled.                               | Deterministic harness-executed behavior                           |
| Per-repo skills | client repo `.codex/skills/<name>/` linked into `.claude/skills/<name>` via `roborepo skill link-project`                                          | Same risk model as global skills, scoped to that repo             |

Current shared skills include `case-study`, `code-style`, `frontend-design`,
`javascript-typescript`, `react`, `roborepo-support`,
`supabase-integration-testing`, `plan-write`, and `test-harness`.
They are all currently treated as auto-invokable by description. The current
shared skill format should not assume `disable-model-invocation` support until
Claude and Codex support is verified.

## Core Rule

Choose the lightest mechanism that gives the user the right control:

| User experience need                                                | Mechanism             |
| ------------------------------------------------------------------- | --------------------- |
| Applies almost every turn and is short                              | Always-on rule        |
| Helps with a narrow task and is safe if loaded accidentally         | Auto-invokable skill  |
| Starts a mode, changes output style, or must happen only on request | Manual command        |
| Gives one-off steering for the current request                      | Snippet in the prompt |
| Must happen mechanically every time                                 | Hook                  |

## 1. Make Skill Behavior Predictable

### What is wrong

A broad user request can accidentally match a broad skill description. The user
then sees a shift in behavior without knowing why.

Examples:

- "Make this page better" might pull in a design-heavy workflow.
- "Write up the plan" might pull in a full planning-doc structure.
- "Review this code" might pull in style guidance when the user wanted only bug
  findings.

### What to do

Each skill description should carry the whole trigger policy because the body is
loaded only after the skill has already been selected.

Every auto-invokable skill description should include:

- what the skill does
- when to use it
- when not to use it
- path, framework, or domain gates when possible

Examples:

- `react`: use only when the repo or touched files show React, Next.js, Remix,
  Vite React, JSX, or TSX.
- `supabase-integration-testing`: use only when most conditions match: Supabase,
  real integration behavior, RLS, RPC, migrations, service role, anon access, or
  database/API behavior that is not mocked.
- `plan-write`: use for creating or revising managed plan docs; do not
  use for ordinary quick notes or brief implementation summaries unless the user
  asks for a structured doc.

### What improves

Skills load for clear matches instead of loose keyword overlap. Near misses stop
pulling the agent into a different workflow.

## 2. Keep Claude And Codex In Sync

### What is wrong

This repo is built for Claude/Codex parity, but each harness may support
different skill metadata and hook events. Adding a harness-specific field to the
shared `SKILL.md` source can make one harness behave differently or reject the
skill entirely.

`disable-model-invocation` is the immediate example. Claude supports it in
`SKILL.md`, but Codex expresses the equivalent intent in `agents/openai.yaml` as
`policy.allow_implicit_invocation: false`. That means the shared source of truth
should not be a Claude-specific frontmatter field.

### What to do

Use this compatibility result before changing skill frontmatter:

| Harness | Manual-only support                                                                                 | Location                            |
| ------- | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Claude  | `disable-model-invocation: true` prevents automatic loading and keeps `/name` invocation            | `SKILL.md` frontmatter              |
| Codex   | `allow_implicit_invocation: false` prevents implicit loading and keeps explicit `$skill` invocation | `agents/openai.yaml` under `policy` |

Because the fields differ, keep `SKILL.md` portable and render or check
harness-specific invocation settings from shared policy.

Proposed shared manifest:

```json
{
  "skills": [
    {
      "skill": "plan-write",
      "invocation": "manual",
      "risk": "medium",
      "claude_strategy": "shared-skill",
      "codex_strategy": "shared-skill",
      "notes": "Use explicit /plan-write modes for plan lifecycle work."
    }
  ]
}
```

The manifest should express intent once. Renderers or checks can then map that
intent to Claude and Codex without hand-maintained drift.

### What improves

Claude and Codex stay aligned by design. When they cannot behave identically, the
difference is explicit, reviewed, and generated rather than hidden inside shared
skill files.

## 3. Separate Helpers From Modes

### What is wrong

Some skills are reference helpers. Others change the whole session. Accidentally
loading a helper is usually minor. Accidentally entering a mode can affect many
turns.

There is also a useful middle shape: a slash command can be only a thin wrapper
around a skill. In that model, the skill stays the canonical workflow and the
command is just the explicit user-facing entry point.

Some slash commands should not be skills at all. A command can be a standalone
workflow when it needs command-specific metadata, tool grants, confirmation
rules, or harness-specific availability.

### What to do

Keep helper behavior auto-invokable. Move persistent behavior behind explicit
commands.

Examples:

```txt
/blog-mode       # persistent mode
/blog-outline    # one-time action
/blog-tighten    # one-time action
/blog-finalize   # one-time action
```

```txt
/plan-write mode           # persistent mode
/audit-plan               # one-time action
/generate-inventory       # one-time action
```

Use this distinction:

| Shape                | User expectation                                 | Policy                                                           |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Helper               | "Use relevant background while doing this task." | Can auto-load if low risk                                        |
| Mode                 | "For the rest of this session, behave this way." | Manual command                                                   |
| Action               | "Do this operation now."                         | Manual command, repeat when needed                               |
| Skill-backed command | "Run that known workflow now."                   | Manual command that tells the harness to load the matching skill |
| Standalone command   | "Run this explicit workflow now."                | Manual command with its own source file, not a skill             |

Do not create slash commands for every skill. Commands are opt-in. Intrinsic
helper skills such as `code-style`, `javascript-typescript`, `react`, and
`test-harness` should normally remain implicit-only because they behave like
context lenses rather than user workflows.

The command wrapper should be intentionally small. Example shape:

```md
---
description: Turn a product or UX idea into a practical implementation plan.
---

# /plan

Use the `plan` skill for this request.

Read the harness-appropriate skill file, then follow its workflow. Do not write
code unless the user explicitly asks to proceed.
```

Claude and Codex may need different skill paths in the wrapper because their
project-skill scan locations differ. That should be generated from shared
policy instead of hand-maintained in two places.

Standalone commands should also be generated from shared policy, but their
source is the command file itself. They are useful when a workflow belongs only
to the command surface and has no reusable skill body.

### What improves

The user controls session-level behavior. One-shot actions do not quietly affect
later turns.

Slash commands give users a discoverable command palette without forcing every
workflow into a skill. Skill-backed commands are most useful for medium-risk
skills that are safe as helpers but better when users have a memorable explicit
entry point, such as planning, blog, or frontend-design workflows. Standalone
commands are best for command-specific workflows such as capture.

## 3a. Skill-Backed Commands Double-List In Claude Code

### What is wrong

Claude Code enumerates skills and slash commands as two separate registries. A skill-backed command
therefore appears **twice** in the user-facing list — once from `~/.claude/skills/<name>/SKILL.md`
and once from `~/.claude/commands/<name>.md`. This is inherent to the wrapper pattern in §3, not a
rendering bug: the command file is a three-line shim whose body is "Read the skill, then follow its
workflow," so both entries run identical work.

It reads as two different commands because the two descriptions are written for different jobs and
have drifted apart. Observed for `/session-close`:

```text
/session-close    Use ONLY when the user explicitly asks to wrap up, close out, finish…   ← SKILL.md
/session-close    End a work session cleanly: self-review added code, sync docs, commit…  ← command shim
```

All seven packages with a skill-backed command are affected. Six of the seven have diverging text:

| Package | Skill vs. command description |
| --- | --- |
| `case-study-pack` | identical |
| `frontend-design` | diverges |
| `plan-write` | diverges |
| `technical-writing` | diverges |
| `telemetry` | diverges |
| `tighten` | diverges |
| `session-close` | diverges |

The divergence is structural, not sloppiness. `package.config.json` holds one description reused for
both the package label and the command shim, and it is written as *what the workflow does*. The
`SKILL.md` description is written as *when to trigger*, which §1 of this policy actively requires.
Both are correct for their own registry.

The shim cannot simply be dropped: `harnesses: ["claude", "codex"]` exists because Codex has no
skill autodiscovery, so the generated command is the only entry point there. Removing `"claude"`
would leave Claude Code relying purely on skill autodiscovery for `/name` invocation.

### What to do

Unresolved — see Open Decisions. The options, in increasing cost:

| Option | Effect | Cost |
| --- | --- | --- |
| Accept it | One duplicated list entry per skill-backed command | None; status quo |
| Align descriptions | Both lines read identically, so the pair is obviously one workflow listed twice rather than two commands | Edit 6 `package.config.json` files; loses the what-vs-when split |
| Prefix the command description | e.g. `(skill) End a work session cleanly…` — keeps both texts, marks the shim as an alias | Edit 6 files; adds noise to the Codex surface where there is no duplicate |
| Emit Codex-only shims | Drop `"claude"` from `harnesses`; removes the duplicate outright | Claude `/name` then depends solely on skill autodiscovery — a real behavioral dependency traded for a cosmetic fix |

Decide before adding more skill-backed commands, since each one adds another duplicate pair.

### What improves

The command palette stops showing what look like two competing entries for one workflow, and the
policy records why the duplication exists so it is not "fixed" by deleting the Codex entry point.

## 4. Classify Skill Risk

### What is wrong

"Accidental skill load" is too broad. Some accidental loads waste tokens. Others
change behavior or create security risk. Policy should focus effort where the
mistake matters.

### What to do

Classify each skill by the user impact of accidental loading.

| Risk   | Meaning                                                                                                | Examples                                                       | Default policy                                                    |
| ------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Low    | Adds narrow read-only context or style guidance                                                        | `react`, `javascript-typescript`, `code-style`, `test-harness` | Keep auto-invokable, tighten triggers                             |
| Medium | Shapes output, structure, design taste, or writing mode                                                | `frontend-design`, `plan-write`, `case-study`                         | Keep for now, tighten triggers, consider split into helper + mode |
| High   | Changes permissions, grants tools, runs shell, commits, deploys, hands off, or creates persistent mode | future `commit`, `deploy`, `handoff`, shell-backed skills      | Manual command or hook only                                       |

### What improves

The policy does not overreact to harmless helper skills. High-impact workflows
get explicit user control.

## 5. Test Skill Triggers

### What is wrong

Without tests, trigger quality is judged by feel. Description changes can make a
skill too eager or too hard to invoke.

### What to do

Add trigger tests for each skill:

- prompts that should invoke it
- near-miss prompts that should not invoke it
- ambiguous prompts where no skill should load

Use failures to tighten the frontmatter description. Keep the examples close to
real user language.

### What improves

Skill behavior becomes testable. The repo can change descriptions with
confidence instead of hoping the model interprets them correctly.

## 6. Improve Visibility

### What is wrong

If a skill loads silently, the user may not know why the agent changed behavior.
This makes accidental invocation hard to diagnose.

### What to do

Desired behavior:

```txt
Context: base, react(auto), test-harness(auto)
Command: none
Skill shell: none
Extra tool grants: none
```

However, this depends on harness support. A hook can only report loaded skills if
the harness exposes skill-load metadata to that hook. Claude and Codex both have
useful prompt, tool, and stop/display hook events, but the current documented
hook payloads do not provide a stable "these skills were loaded implicitly"
field.

Until the harness exposes reliable skill-load events, use fallback visibility:

- agent announces meaningful skill use in commentary
- static audit lists all auto-loadable skills and risk levels
- session-start note can warn about high-risk auto skills if any exist
- final response can include "Skills used" only for workflows where it helps

### What improves

The user has a path to understand surprising behavior today, and the plan leaves
room for a better automatic indicator if the harness exposes the needed data.

## 7. Audit Security-Sensitive Skills

### What is wrong

The dangerous case is not merely "a skill loaded by accident." The dangerous case
is a skill that can execute shell, grant broad tools, use dynamic context, or
come from an untrusted cloned repo.

Dynamic-context shell is especially sensitive because it can execute before the
model evaluates the final prompt.

### What to do

Audit both shared and per-repo skills for:

- shell or dynamic context
- broad tool grants
- external dependencies
- cloned or untrusted source
- side-effecting workflows

Policy:

- Avoid dynamic shell context in skills unless the skill is fully trusted and the
  shell call is genuinely needed.
- Treat per-repo `.codex/skills/` linked from cloned repos as less trusted.
- Prefer hooks over skills when behavior should be deterministic.
- Put commit, deploy, handoff, and other side-effecting workflows behind manual
  commands or deterministic hooks.

### What improves

The repo reduces supply-chain and hidden-execution risk while keeping ordinary
read-only skills lightweight.

## Proposed Implementation Order

1. Automate the skill inventory/audit so the baseline doc can be regenerated and checked.
2. Tighten descriptions for medium-risk skills before converting anything.
3. Add trigger tests for expected matches and near misses.
4. Add manifest-backed checks for generated command outputs and any manual-only policy.
5. Run the Claude/Codex visibility spike for loaded-skill metadata.
6. Split persistent modes from one-shot actions where a skill currently does both.
7. Convert only high-risk or truly persistent workflows to manual commands.

## Next Recommended Work

### Completed

- **Package `skill` resources** — shipped as the source of truth for skill risk tier and desired
  invocation behavior.
- **Package `slash-command` resources** — shipped with the command catalog (skill-backed and
  standalone entries, harness targets).
- **`scripts/build/render-slash-commands.mjs`** — shipped as the renderer/checker for generated
  Claude and Codex slash-command files.
- **`docs/internal/skill-invocation-audit.md`** — shipped as a hand-authored baseline
  audit for current shared skills.
- **`roborepo skill audit [--check]`** — shipped as the automated renderer/checker for the shared
  skill invocation audit.
- **`roborepo skill triggers [--check]`** — shipped as a deterministic fixture checker for
  medium-risk trigger language. It verifies expected prompt examples contain declared trigger
  phrases, near-miss examples avoid those phrases, and each skill description still carries both
  trigger and skip phrases.
- **Manual-only policy validation** — shipped in package catalog validation: `invocation=manual`
  now requires a slash-command entrypoint.

### Remaining

Do these before making more behavior changes:

1. Decide how skill-backed commands should present in Claude Code, where each one double-lists
   (§3a). Cheapest to settle first: it is a one-line decision per package, and every new
   skill-backed command adds another duplicate pair until it is resolved.
2. Expand trigger fixtures beyond the initial medium-risk set and tune descriptions when examples
   reveal over-broad or missing trigger language.
3. Add rendered harness-specific manual-only metadata only when a skill is intentionally converted
   away from implicit invocation.

This gives the repo a control plane before converting more skills to commands or
manual-only behavior.

## Current Recommendation

Do not convert most skills to slash commands yet.

First improve predictability and evidence:

- tighten triggers
- classify risk
- test invocation
- confirm Claude/Codex parity
- improve visibility where the harness allows it

Then convert only skills that act like persistent modes or high-risk workflows.

Do add slash commands where they improve user experience. A skill-backed command
is not the same as converting the workflow away from skills; it is a manual
entry point that can coexist with a tightly gated auto-invokable helper. A
standalone command is correct when the workflow belongs to the command surface
itself.

## Open Decisions

- How should skill-backed commands present themselves in Claude Code, where the skill and its
  command shim both list? See §3a for the option table. Affects all seven packages that ship one.
- Can either harness expose loaded-skill metadata to hooks or status output?
- Should command docs link directly to owning package configs, or describe only the generated
  outputs?
- Which medium-risk skills should be split into helper + mode?
- Which skills should get generated skill-backed commands while remaining
  available as auto-invokable helpers?

## Success Criteria

- No shared `SKILL.md` uses unsupported harness-specific fields.
- Every shared skill has an explicit risk and invocation classification.
- Medium-risk skill descriptions include clear skip conditions.
- High-risk workflows cannot auto-load silently.
- Generated slash commands match package `slash-command` resources. Skill-backed commands do not
  duplicate skill bodies; standalone commands have explicit
  source files. **Shipped for current commands; keep this as a regression criterion.**
- Trigger tests cover expected invocation and accidental near misses.
- Claude/Codex differences are explicit and generated or checked.

## Related

- `docs/internal/skill-invocation-audit.md` records the current shared
  skill inventory, risk tiers, and recommended next actions.
- `roborepo skill link-project` (`scripts/cli/skills.mjs`) installs client-repo
  `.codex/skills/` into Claude project skill views, which need the same audit policy.
- `scripts/build/skill-lib.sh` and `scripts/cli/skill-lib.mjs` already define
  reusable skill discovery and linking rules that a command-wrapper renderer
  should share.
- `docs/internal/rules-parity-and-layering.md` explains how always-on
  rules render.
- `docs/user/reference/claude-hooks.md` and
  `docs/user/reference/codex-hooks.md` document current hook behavior.
