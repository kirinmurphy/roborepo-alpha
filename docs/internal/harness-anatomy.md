# Harness Anatomy and Parity

This is the map of what a "harness" is made of in this repo, and how the three harnesses — Claude,
Codex, and Gemini CLI — are kept in parity. It is the hub: each element below says what it does,
where its source lives, how parity is achieved across the harnesses, and the exact command you run
to maintain it. For the underlying filesystem/symlink mechanics, see
[How It Works](../user/reference/architecture.md). If you want the teaching version — what each harness
does natively and why each element's parity is solved the way it is — read
[How the Harnesses Work, and Why Parity Takes the Shape It Does](harnesses-explained.md) first.

Gemini CLI is the newest of the three, added to prove the registry/adapter contract against a real
third harness rather than a synthetic one. Its coverage is uneven by design: rootConfig,
permissions, and MCP add/remove are real and verified; rules, skills, commands, bulk hooks, and
bulk MCP stay stubbed (`notYetMigrated`), matching the current bar for Claude and Codex on those
same capabilities — see each element's section below for exactly which side of that line it's on.

Every element is authored once under `globals/` (or a `manifests/` data file) and fanned out to
every harness by the build/link step — you never hand-maintain it in more than one place. This doc
is the *what* and *how-to-change*; for *why* each element is solved its particular way, each
section links the matching step in [the teaching doc](harnesses-explained.md).

## Elements at a glance

| Element | What it is | Source | Maintain with |
| --- | --- | --- | --- |
| Global rules | The always-on instruction file each harness reads at startup. | Claude: `generated/claude/CLAUDE.md` (generated)<br>Codex: `generated/codex/AGENTS.md` (generated) | `roborepo rules [--check]` |
| Skills | On-demand capability/instruction bundles the agent loads when relevant. | Package-owned `globals/packages/<package>/skills/<name>/SKILL.md`, plus system `globals/system/skills/builtin-support/SKILL.md` — materialized into `~/.roborepo/skills/<name>` and linked from harness skill dirs | `roborepo skill new`, `roborepo skill adopt <name>`, `roborepo skill inspect <name>`, `roborepo skill sync-global` |
| Slash commands | Named workflows the user starts explicitly (`/case-study`, etc.). | Package-scoped, generated: `generated/packages/<package>/claude/commands/` and `generated/packages/<package>/codex/commands/`, composed live only for enabled packages | `roborepo skill render-commands [--check]` |
| Install bundles | Named groups of install-time file operations applied at install/update. Internal to the install pipeline — not a user-facing verb. | `manifests/platform/presets.json` | `roborepo update` (applies them); `roborepo bundle …` is an internal verb called by `scripts/install/main.sh` |
| Hooks | Scripts the harness runs on lifecycle/tool events. | System hooks: `globals/system/hooks/claude/*.mjs` + `settings.json` wiring, `globals/system/hooks/codex/*.mjs` + `hooks.json`. Package-owned hooks (e.g. Caveman/JDocMunch Codex `SessionStart`, telemetry capture, JCodeMunch's Bash blocker) live under `globals/packages/<package>/hooks*` and are composed in only when that package is enabled | edit source, then `roborepo update` |
| MCP servers | External tool servers (jcodemunch, jdocmunch, …) registered with every enabled harness. | Claude: native live store<br>Codex: active `~/.codex/config.toml`, fully owned by each package's `mcp`/`codex_tool_approvals` components<br>Gemini: `mcpServers` key in `~/.gemini/settings.json`, direct JSON read/write | `roborepo mcp add <name-or-url>` |
| Permissions | Allowed, denied, and ask-before-run behavior for commands, tools, and network defaults. | Claude: `settings.json` `permissions.*`<br>Codex: `config.toml` + `rules/default.rules` + runtime ask hook<br>Gemini: `~/.gemini/policies/generated-permissions.toml`, one fully-owned file in the Policy Engine's rule directory | `roborepo permissions [--check]` |
| Telemetry | Local capture + analysis of sessions, tools, MCP, and token usage; spike detection + cause attribution + dashboard; backup/reset. | Package-owned hooks (`globals/packages/telemetry/hooks-{claude,codex}.json`) feed `~/.roborepo/telemetry`. Gemini sessions can appear in capture/analysis (harness id is a free-form CLI flag), but the package declares no Gemini hook wiring yet, so capture isn't wired in for it | `roborepo telemetry enable\|disable\|status\|report\|serve\|backup\|purge` |
| Root config | Mutable, machine-local settings (model, trust, hook approvals). | Claude: `generated/claude/settings.json` (baseline)<br>Codex: `generated/codex/config.toml` (baseline)<br>Gemini: `~/.gemini/settings.json`, merged with the same recursive-object-merge rule as Claude's | `roborepo update` (export/merge) |

The rest of this doc takes each element in turn: what it does, how parity works, and what you do
to change it. For what survives an install/update per element — backups, drift, staged candidates —
see [Config Collision Handling → Per-Element Persistence](../user/reference/config-collision-handling.md#per-element-persistence).

## Global rules (`CLAUDE.md` / `AGENTS.md`)

**What they do:** the always-loaded behavior defaults — caveman mode, code/doc exploration policy,
verification discipline, temp-file hygiene. (The inline chat-note behaviors — convention capture,
impact awareness, skill visibility — moved out of base rules into default-on Chat-Time Output rules
packages; see [rules-parity-and-layering.md](rules-parity-and-layering.md).)

**Parity model:** generated from shared fragments under `globals/system/rules/shared/`, plus harness-only
fragments under `globals/system/rules/claude/` and `globals/system/rules/codex/`. You never edit `CLAUDE.md` or
`AGENTS.md` directly — they carry a generated-file header. (Why a generator: [explained.md Step 2](harnesses-explained.md#step-2--bridging-a-cosmetic-gap-global-rules).)

**To change behavior in every harness:** edit a fragment in `globals/system/rules/shared/`, then render:

```sh
roborepo rules          # render generated/claude/CLAUDE.md and generated/codex/AGENTS.md
roborepo rules --check  # verify no drift (also run by roborepo doctor)
```

For Claude-only or Codex-only behavior, edit `globals/system/rules/claude/` or `globals/system/rules/codex/`
instead. Keep fragments compact — expanded workflow guidance belongs in a skill. Full model and
override-layering rules: [Rules Parity and Layering](rules-parity-and-layering.md).

## Skills

**What they do:** on-demand bundles the agent loads when a task matches (`code-style`, `react`,
`builtin-support`, …). Shared skills are also exportable to other repos.

**Parity model:** package-owned skills are sourced from
`globals/packages/<package>/skills/<name>/SKILL.md`; the required base support skill is sourced from
`globals/system/skills/builtin-support/SKILL.md`. The installer materializes each enabled shared
skill into `~/.roborepo/skills/<name>` and links each harness's native dir to that machine-local
cache entry. Roborepo owns only the skill names it manages;
native-installed skills (via native harness tools or `skill-installer`) at unrecognized names are
left untouched and shown as adoptable drift by `roborepo doctor --installed`. There is no
intermediate `globals/claude/skills/` directory, and harness homes do not point directly at the
checkout. (Why a symlink, not a generator: [explained.md Step 4](harnesses-explained.md#step-4--when-the-files-are-identical-but-live-apart-skills).)

**To add or change a skill:**

```sh
roborepo skill new            # scaffold package-owned skill/command + update package config, links, README
                              # (wraps native init_skill.py when present; roborepo template otherwise)
roborepo skill adopt <name>   # move an out-of-band skill into version control
roborepo skill sync-global    # refresh ~/.roborepo/skills and harness skill views
roborepo skill inspect <name> # report ownership, native metadata, collisions, and harness state
roborepo skill native         # show native harness plugin/skill entrypoints
roborepo doctor --installed   # check that live harness links are current
```

Add the user-facing description to the README (`Automatic Skill Helpers` or `Commands`). Repo-only
internal skills live under `local/skills/` and never go global or get exported. Full skill-layer
model: [Skills And Slash Commands](skills-and-commands.md) and
[shared-skills fan-out](../user/reference/architecture.md#shared-skills-canonical-source--machine-local-cache).

**Memory — Defer:** both harnesses have native persistent memory (Codex `~/.codex/memories/`,
Claude `/memory` under `~/.claude/projects/*/memory/`). Memory is per-machine, per-session, and
written continuously at runtime. roborepo does not manage, sync, or carry memory across machines.
`roborepo update` does not restore memory. This is a deliberate stance, not a gap.

## Slash commands

**What they do:** named workflows the user starts on purpose (`/case-study`, `/frontend-design`,
`/plan-write`, `/tighten`).

**Parity model:** authored once as package `slash-command` resources, stamped into per-package
generated dirs (`generated/packages/<package>/claude/commands/` and
`generated/packages/<package>/codex/commands/`). Only enabled packages' commands are composed into
the live `~/.claude/commands` / `~/.codex/commands` directories. Files in the generated dirs are
generated. (Why just a stamped copy: [explained.md Step 1](harnesses-explained.md#step-1--when-they-already-agree-slash-commands).)

**To add or change a command:** edit the owning package's `package.config.json`, then:

```sh
roborepo skill render-commands         # render into every harness's command dir
roborepo skill render-commands --check
```

A skill-backed command is wired by `roborepo skill new` when you pick that kind, so you usually
do not hand-edit the manifest.

## Hooks

**What they do:** scripts the harness runs on lifecycle or tool events — caveman activation on
startup, broad-read nudges, noisy-Bash trimming, the write guard.

**Parity model:** no shared generator — a behavior wanted on both sides is authored twice. Mandatory
system hooks are `.mjs` scripts under `globals/system/hooks/claude/` wired through `settings.json`,
and `globals/system/hooks/codex/` wired through `hooks.json`. Package-owned hooks (Caveman's and
JDocMunch's Codex `SessionStart` hooks, telemetry's capture hooks, JCodeMunch's Bash blocker) are
authored under their owning package and composed into live hook config only when that package is
enabled. Telemetry capture uses the same hook-composition layer when it is
enabled, writing token-usage and context records into `~/.roborepo/telemetry`. (Why parity stops here:
[explained.md Step 6](harnesses-explained.md#step-6--when-automation-gives-up-hooks).)

**To change a hook:** edit the script and/or the wiring (`settings.json` for Claude, `hooks.json`
for Codex, or the owning package's hook resource), then re-apply:

```sh
roborepo update   # picks up hook and root-config changes on this machine
```

Hook details: [Hooks Internals](hooks-internals.md); user summaries in [Claude Hooks](../user/reference/claude-hooks.md) and [Codex Hooks](../user/reference/codex-hooks.md).

## MCP servers

**What they do:** external tool servers the agents call — `jcodemunch-mcp` for code,
`jdocmunch-mcp` for docs, plus anything you add.

**Parity model:** one command registers a server with **every enabled harness**: writes the intent to
`manifests/inventory/mcp-servers.json` (state — "what is installed"), applies live to each harness
in its native dialect (Claude → `claude mcp add`; Codex → block in active `~/.codex/config.toml`;
Gemini → direct read/write of the `mcpServers` key in `~/.gemini/settings.json`, no shell-out needed),
and adds matching Claude permissions in `settings.json`. `manifests/inventory/mcp-presets.json`
stays the *catalog* ("what you can add"). `roborepo update` re-applies `mcp-servers.json` on any
machine, making the MCP set portable. No package currently declares `"gemini"` in a server's
`harnesses` array, so `roborepo mcp apply`'s bulk sync is a real but currently-unexercised path for
it. (Why a command, not a generator:
[explained.md Step 5](harnesses-explained.md#step-5--when-rendering-doesnt-fit-mcp-servers).)

**To register a server:**

```sh
roborepo mcp add <name-or-url>            # every registered harness + Claude permissions + record in mcp-servers.json
roborepo mcp add <name-or-url> --harness claude   # repeatable; omit for every registered harness
roborepo mcp apply                        # re-apply mcp-servers.json to current machine (called by update)
```

## Permissions

**What they do:** the allow/deny/ask policy for commands, tools, and MCP calls, plus session defaults
such as sandboxing, approval policy, and Codex network access.

**Parity model:** authored once in `manifests/inventory/agent-permissions.json`, rendered into each harness's
native shape — Claude's `permissions.allow`/`permissions.deny`/`permissions.ask` in
`settings.json`, Codex's `config.toml` session defaults + `rules/default.rules` command policy, and
Gemini's `~/.gemini/policies/generated-permissions.toml` — one fully-owned file inside the Policy
Engine's rule directory, rather than a marked block inside a shared file. Codex's static rules cannot
express per-command `ask`, so `globals/system/hooks/codex/permission-check.mjs` supplies that runtime
decision from the same manifest; Gemini needs no such workaround — its Policy Engine has a native
3-state `allow`/`deny`/`ask_user` decision at the config layer. (Why one source, per-harness output
shapes: [explained.md Step 3](harnesses-explained.md#step-3--bridging-a-structural-gap-permissions).)

**To change permissions:** edit `manifests/inventory/agent-permissions.json`, then:

```sh
roborepo permissions          # render every harness's output
roborepo permissions --check
```

## Root config (`settings.json` / `config.toml`)

**What it is:** mutable, machine-local state — model choice, trust, hook approvals, local profiles.
Unlike most generated/copyable assets above, the active home files are **not** symlinks; the repo
keeps a portable baseline and the installer exports it only when doing so does not overwrite user
drift.

**Parity model:** no auto-parity by design — this is the layer where per-machine divergence is
allowed. The repo baselines (`generated/claude/settings.json`, `generated/codex/config.toml`) receive
generated permission and hook/package defaults; local edits are protected by root-config drift
detection and the `keep` / `overwrite` / `abort` collision policy. Gemini has no repo-side generated
baseline yet (no `generated/gemini/settings.json` candidate exists), so its `rootConfig.merge` runs
with nothing to merge in — `roborepo update` still reports "updated root config gemini" but the file
stays `{}` until a baseline is added. (Why parity isn't the goal here:
[explained.md Step 7](harnesses-explained.md#step-7--when-parity-isnt-the-goal-root-config).)

For exact update, backup, staged-candidate, and uninstall behavior, see
[Config Collision Handling](../user/reference/config-collision-handling.md).

## Preset bundles (`presets.json`)

**What they do:** define which behavior groups are turned on for a machine after the core install.

**Parity model:** one bundle manifest drives the onboarding chooser and the lower-level bundle
apply/remove commands. It is the source of truth for what `roborepo package manage` can show.

**To change bundle selection behavior:** edit `manifests/platform/presets.json`, then run
`roborepo package manage` on a machine that should pick up the new default selection.

**To apply baseline changes to a machine:**

```sh
roborepo update   # exports baseline when missing/identical, asks before merging local edits
```

Merge options and drift behavior are covered in
[How It Works → Root Config](../user/reference/architecture.md#root-config-export) and
[Config Collision Handling](../user/reference/config-collision-handling.md).

## Keeping a machine in sync

After changing any element above, the same two verbs cover most situations:

```sh
roborepo update   # re-apply core repo config to this machine (links + root-config export)
roborepo doctor   # health-check links, helper commands, deps, and generated-output drift
```

`roborepo doctor` runs the rules, permissions, internal skill-link, and installed skill-cache drift
checks for you, so it is the fastest way to confirm every generated element is current.
`roborepo telemetry status` shows whether local capture is enabled.
