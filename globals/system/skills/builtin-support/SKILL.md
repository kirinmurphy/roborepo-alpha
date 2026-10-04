---
name: builtin-support
description: >
  Work with builtin-managed global agent config from any repo. Use when adding or editing
  shared/exportable skills, skill-backed slash commands, global rules, hooks, settings,
  package-enabled behaviors, MCP entries, or Claude/Codex parity. Triggers: "add a skill",
  "edit global rules", "roborepo support", "harness config", "skill authoring",
  "skill triggers", "roborepo update", "roborepo doctor". SKIP for changing roborepo's
  own installer, CLI internals, package/apply engine, portal, telemetry, or local/skills/;
  use the repo-local builtin-development skill for that.
---

# Roborepo Support & Skill Authoring

For work with builtin-managed Claude + Codex configuration: shared skills, generated
rules, hooks, settings, MCP registration, package-enabled behaviors, and cross-harness
parity. This skill is shared/exportable; it should help users operate roborepo from a
local machine without pulling in the repo-internal platform manual.

If the task changes roborepo implementation internals (`scripts/cli/`, installer
plumbing, package/apply/workspace state, portal, telemetry, local repo-only skills), load
the repo-local `builtin-development` skill instead.

**Read these first when relevant** (they are the source of truth):
- `README.md` — overview of what's shared and per-harness.
- `docs/user/reference/architecture.md` — relationship, materialization map, sync flow.
- `docs/user/reference/roborepo-cli.md`, `docs/user/reference/roborepo-skills.md` —
  current CLI and skill interface.
- `docs/user/reference/config-collision-handling.md` — conflict rules.
- `docs/user/reference/claude-hooks.md`, `docs/user/reference/codex-hooks.md` — hook behavior.

## The skill model (the #1 thing to get right)

The canonical shared source is a package-owned skill resource at
**`globals/packages/<package>/skills/<name>/`**. The required base support skill is the only current
system skill under **`globals/system/skills/builtin-support/`**. Roborepo materializes shared
skills into the machine-local cache at `~/.roborepo/skills/<name>`, then both harnesses read from
their native skill dir via symlink:

- `~/.claude/skills/<name>` -> `~/.roborepo/skills/<name>`
- `~/.codex/skills/<name>` -> `~/.roborepo/skills/<name>`

These managed cache entries are created by the installer's enumerate-step
(`install-lib.sh:link_global_skills`), called from `install-harness.sh` (once per detected harness),
and `scripts/build/link-global-skills.sh` (run by `skill new`). Each managed cache entry carries a
`.builtin-managed` marker. There is no intermediate `globals/claude/skills/` directory.

`roborepo doctor --installed` verifies the live cache entry and harness symlinks are current.
`roborepo doctor` (without `--installed`) checks that source dirs exist in the repo.

## Adding a shared skill

Use `roborepo skill new` — it scaffolds the package config, registers resources, and fans out to
both harnesses in one step:
```bash
roborepo skill new
```
It can create automatic helper skills, skill-backed slash commands, or standalone slash commands.
For medium-risk skill descriptions, add/update trigger fixtures and run:
```bash
roborepo skill triggers --check
```
If you created a skill out-of-band (via native `init_skill.py` or by hand in `~/.codex/skills/<name>`):
```bash
roborepo skill adopt <name>
```
Inspect before changing ownership:
```bash
roborepo skill inspect <name>
```

Manual add (for reference only — prefer the commands above):
1. Create `globals/packages/<package>/skills/<name>/SKILL.md`
2. Add a `skill` resource to `globals/packages/<package>/package.config.json`
3. For slash commands, add a `slash-command` entrypoint or resource and run
   `roborepo skill render-commands --check`
4. Run `roborepo skill sync-global` to refresh the shared skill cache and harness links
5. Update README/docs tables when the user-facing surface changes
6. Verify: `scripts/doctor.sh --installed --quiet`

A `Write|Edit` PreToolUse hook (`globals/claude/hooks/write-guard.mjs`,
registered in `globals/claude/settings.json`) fires from any repo when a path under
`~/.claude` or `~/.codex` is written. For roborepo-owned assets, it reminds that the
repo source is canonical and `roborepo update` refreshes HOME. For mutable root config (`~/.claude/settings.json`,
`~/.codex/config.toml`), it reminds that the active file is local and only portable
defaults should be merged back into the repo baseline. It is a reminder, not a block.

## SKILL.md frontmatter

- `name`: kebab-case, matches the folder name.
- `description`: a `>` block. State plainly WHAT the skill does and WHEN to trigger
  it (include trigger phrases and clear skip conditions). The description is the only
  thing the agent sees when deciding to load the skill — make it discriminating, not
  generic. Body holds the actual instructions, loaded only on invocation.

## References provide depth; SKILL.md provides gates

A skill with named modes routes an agent by prose: the agent reads the mode/reference list, loads
what it names, and does the work. Anything that decides whether the work is *valid* has to survive
that routing, because a rule the agent never loads is a rule that never runs — and the failure is
silent, since the artifact still gets delivered.

Three levels, and each rule belongs to exactly one:

| Level | Holds | Example |
| --- | --- | --- |
| Entry-point gate in `SKILL.md` | The conditions that make completion invalid | "Do not deliver a durable document until the Validator loop passes." |
| Reference | The full procedure, examples, and edge cases | `references/review-loop.md` |
| Deterministic validator in code | Machine-checkable invariants | `modules/plan-suite/naming.mjs` |

Rules for writing them:

- Repeat only enough of an invariant in `SKILL.md` to make skipping the reference visibly
  noncompliant. Do not copy a whole reference into the entry point; the duplicate goes stale.
- List every required reference for each named mode. Reference routing should never be inferred.
- **Load mandatory completion references from the artifact-producing mode.** A finishing step
  reachable only from a mode the user never selects is unreachable in practice. This is the failure
  `roborepo skill audit` reports as `reference unreachable from ...`.
- Do not require a second inferred mode to finish the first. Keep the invocation contract to what
  the user actually types.
- Move any invariant a script can prove into code. Filenames, frontmatter shape, and schema
  correctness do not belong in model memory.
- Keep qualitative review in a read-only pass. The role that writes must not be the role that grades.
- Add regression coverage for routing itself:
  `scripts/test/skill-reference-matrix-characterization-check.mjs` parses these matrices out of the
  prose, and `roborepo skill audit` reports a matrix that no longer parses.

### Pairing another skill

The same rule applies one level up. A reference loads from within a skill; a paired skill loads
from beside it. Both fail the same way — by being mentioned rather than required. Prose that names
a related skill without instructing the load reads as background, and the observed consequence is
that the user names the paired skill by hand on every request.

| Written as | What happens |
| --- | --- |
| "For plans, pair with `technical-writing`." | never loads — a fact about two skills, not a step |
| "Load `technical-writing`; do not wait to be asked for it by name." | loads |
| "Load `code-style` when relevant." | never loads — defers the judgment to the reader, who is the one who did not already know |
| "Load `code-style` when the document specifies module boundaries, orchestration vs. execution, or reuse." | loads when it applies |

Rules:

- **Declare paired skills in a table at the entry point**, with a `Load when` column. One row per
  skill; no prose-only mentions elsewhere that a reader has to reconstruct into a rule.
- **Write the unconditional ones as always.** If a skill is required for every invocation of a
  mode, say "Always" and put the requirement in the completion gates too, so skipping it is
  visibly noncompliant before any reference is opened.
- **Give every conditional skill a subject-matter trigger.** "When relevant", "if useful", and
  "for larger work" are not triggers. Size is never the trigger — a one-phase plan that specifies
  module placement needs `code-style` exactly as much as a ten-phase one.
- **Never make the trigger an explicit user request.** "When the user asks for them" restores the
  manual step the pairing exists to remove. A request is one way to reach relevance, not the
  condition itself.
- **Require the load to be reported**, including which conditional skills did not apply. A skipped
  skill and a forgotten one are indistinguishable otherwise.
- **A paired skill constrains content, not just wording.** If a document tells a reader to build
  something the paired skill forbids, the document is wrong on the merits — so whatever was paired
  in also joins the review scope (see `technical-writing`'s `references/review-loop.md`).

`plan-write` and `technical-writing` both carry a `## Paired Skills` table in this shape; copy it
rather than inventing a second format. Coverage lives in
`scripts/test/skill-reference-matrix-characterization-check.mjs`.

## Editing global rules / behavior

- Generated global rules: edit fragments under `globals/rules/shared/`,
  `globals/rules/claude/`, or `globals/rules/codex/`, then run
  `roborepo rules --check` or `roborepo rules`.
- Hooks: `globals/claude/hooks/` + `globals/claude/settings.json`; `globals/codex/hooks.json`. Automated
  "always do X" behaviors must be hooks — the harness runs them, not the model.
- Settings/permissions: portable baselines live in `globals/claude/settings.json`,
  `globals/codex/config.toml`, and `manifests/inventory/agent-permissions.json`; render/check
  permission outputs with `roborepo permissions --check`.
- After editing a copied/read-mostly asset in repo source, run `roborepo update` to refresh HOME.
  Mutable root config (`globals/claude/settings.json`, `globals/codex/config.toml`) is exported into HOME as
  active local files, not symlinked.
- On collisions between HOME and repo, follow
  `docs/user/reference/config-collision-handling.md` — flag conflicts, don't guess.

## Local Machine Commands

- `roborepo package manage` toggles enabled skills, commands, package behavior, and chat-time output.
- `roborepo update` reapplies copied/rendered config after pulling repo changes.
- `roborepo doctor --installed` checks live `~/.claude`, `~/.codex`, and `~/.roborepo` state.
- `roborepo config root inspect` reports drift between portable baselines and active root config.
- `roborepo web` opens the local portal for config and telemetry.
- `roborepo package enable <package-id>` / `package disable <package-id>` wires package-owned MCP, hooks, rules,
  permissions, and command behavior.

## Parity principle

This repo's whole point is Claude/Codex parity. When you add or change a capability
on one harness, ask whether the other needs the mirror, and say so explicitly if you
intentionally leave them different.
