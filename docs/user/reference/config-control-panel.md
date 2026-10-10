# Config Control Panel

## Purpose

`roborepo` exposes the harness configuration — what indexers, plugins, skills,
telemetry, and permission buckets are active — as an inspectable, editable surface.
A user can see the current state and change it from either the web dashboard
(`/config`) or the interactive terminal flow (`roborepo package manage`), without
hand-editing `~/.claude/settings.json`, `~/.codex/config.toml`, or symlinks.

## Concept Model

The panel is built from a few nouns. Source of truth differs per noun — some live in
the user's live harness config, some in repo manifests, some in RoboRepo state.

| Noun | What it is | Source of truth |
| --- | --- | --- |
| **Package** | A named feature made of typed resources | `globals/packages/<package>/package.config.json`; live config (enabled state) |
| **Resource** | One typed unit of a package's install or presentation | the package config |
| **Skill** | A shared or native skill, inspected without flattening harness-specific metadata | package-owned `skills/<name>` source or system skill source; `~/.roborepo/skills/<name>` (managed cache); `~/.claude/skills/<name>` and `~/.codex/skills/<name>` (harness install state) |
| **Permission behavior** | A named behavior or arbitrary command set to `allow`, `ask`, `deny`, or `default` | `manifests/inventory/agent-permissions.json` (defaults); `~/.roborepo/command-overrides.json` (personal overrides); live config (active render) |

### Resource Types

A package is `{ schemaVersion, id, label, resources: [...], requires?: [...] }`. Enabling a package
applies each installable resource; the enable/disable switch dispatches on `resource.type`.

| type | Wires | Notes |
| --- | --- | --- |
| `mcp` | An MCP server registration | via `roborepo mcp add` |
| `cli-command` | A package-owned `roborepo` subcommand | resolved by command name at runtime |
| `rules` | A rules block in the harness rules file(s) | `harness: claude` → `CLAUDE.md`, `codex` → `AGENTS.md`, `both` → each present harness; merged/removed by unique first line |
| `hooks` | Hook entries in `~/.claude/settings.json` | merged by command |
| `permissions` | `permissions.allow` entries | exact-match add/remove |
| `plugin` | `extraKnownMarketplaces` + `enabledPlugins[id]` | harness downloads the plugin on its next launch |
| `service` | A registered async handler's bespoke install | e.g. telemetry's spool + capture hooks |
| `skill` | A shared-skill link into harness skill dirs | reuses the skill linker |

### Package composition

A package may list `requires: [pkgId, ...]`:

- Enabling it enables each required package first (deduplicated and cycle-safe), then its own
  resources.
- A **composite** package lists only `requires`, so it bundles other packages under one toggle.
- A composite reports itself enabled only when every required package, and any resources of its
  own, are enabled.

> Composition (`requires`, runtime feature enablement) is distinct from an install
> **bundle** (`manifests/platform/presets.json`), which groups file-copy/link rows at
> install time. Both exist; they operate at different layers.

### The sections

The panel renders these sections:

- **Global Rules** — start with the selector only; after a file is chosen, show the live
  `CLAUDE.md` / `AGENTS.md` content, the file path, and the default-rule drill-downs.
- **Hooks** — quick links to the live `~/.claude/settings.json`, `~/.codex/config.toml`,
  and `~/.codex/hooks.json` files.
- **Token Optimization** — package-level controls such as the Caveman package. Manage Telemetry
  from **Settings** or **Tokens**.
- **Monitoring** — packages that observe agent activity and usage.
- **Plan Suite** — plan lifecycle commands and workflows.
- **Skills - Code Quality** — skills that check and improve code against project patterns.
- **Code Conventions** — auto-loaded skills (no command). Same skill-link toggle.
- **Writing Assistants** — long-form writing workflows and structured documentation.
- **Chat-Time Output** — response shape (the shared formatting/closing-structure rules) plus the
  inline chat-note behaviors (convention capture, impact awareness, skill visibility), each a
  `rules` package merged into every managed harness. The three note behaviors `requires` response
  shape, so enabling one auto-enables it. Each is off until you enable it; toggling adds or removes
  the behavior's rules block.
- **Additional Agent Rules** — Branch Safety and Capture Dense Bash.
- **Integrations** — optional connections between RoboRepo and supported tools.
- **Permissions** — flat behavior and command buckets. Named behaviors and arbitrary commands can
  be set to `allow`, `ask`, `deny`, or reset to the manifest default. They render as one merged
  list split by authorship rather than by kind: entries the user customized appear first, each
  with a delete control, above the shipped defaults collapsed behind a count. Delete reverts to
  the manifest default, or removes the entry outright when it was user-added and has no default.

## Happy Path

1. Run `roborepo web` to open the `/config` portal (or run `roborepo package manage`
   in a terminal).
2. The panel shows the current state of each section.
3. Toggle a package, skill, or telemetry switch. The change is written to your live harness config
   and the panel refreshes.
4. To change permissions, set a named behavior or arbitrary command to `deny`, `ask`, `allow`, or
   `default`.
5. Changes take effect the next time the agent harness starts a session.

## Where Changes Go

Every change writes your **live** harness config (`~/.claude`, `~/.codex`, `~/.gemini`), never the
repo template under `globals/`. Changes take effect the next time the harness starts a session.

Package rows can show `enabled`, `configured`, `disabled`, `partial`, `external`, or `blocked`.
`configured` means fully installed with a runtime service deliberately turned off (for example,
telemetry capture disabled); `partial` means the install is genuinely incomplete.

## Context Cost Estimates

The panel estimates how many tokens your configuration adds to each harness, so you can see what a
package costs before and after enabling it. Two kinds of cost are tracked and never mixed:

| Cost | What it counts | How it is shown |
| --- | --- | --- |
| Startup | Text loaded automatically at chat start: the rendered rules and each installed skill's name and description | A per-harness total in the agent files grid |
| On-demand | Text loaded only when used: a full skill body or slash command | Per item, rated low (< 1k), medium (1k–3k), or high (> 3k); only medium and high get a chip |

- On-demand costs are never summed, because skill bodies do not load together.
- Settings files, hook scripts, and MCP schemas are not prompt text, so they get no token number.
- Disabled packages show their potential cost but add nothing to the totals.
- Anything rated medium or high is listed, highest first, in a warning panel above the grid.
- All counts are estimates at about 4 characters per token.

## Permissions

Permissions are global machine state; there is no per-project permission layer.

Personal changes are stored in `~/.roborepo/command-overrides.json` and layered on top of
`manifests/inventory/agent-permissions.json` before rendering live Claude/Codex config. Resetting a
row to `default` removes the personal override and returns to the repo manifest default for that
behavior or command.

### Gates and scopes

File access is two behaviors, not one, and they answer different questions:

| Behavior | Question |
| --- | --- |
| `read-files` / `write-files` | **Whether** the tool may be used at all — a master switch across every path |
| `read-scope` / `write-scope` | **Where** it may be used without prompting — a path allowlist |

Both must pass. Setting `write-files` to `deny` shuts writing off everywhere regardless of scope;
leaving it `allow` lets `write-scope` decide which paths are silent and which prompt.

The gate exists separately because some harnesses cannot express path scoping at all (Gemini's
Policy Engine), and falls back to the whole-tool decision there. `write-files` deliberately emits no
unscoped rule of its own: a bare `Write`/`Edit` entry out-ranks every path-scoped rule and would
silently defeat the scoping.

### Credential denylist

`read-secrets` denies reads of credential material — `~/.ssh`, `~/.aws`, `~/.gnupg`, cloud config,
keychains, and `.env`/`*.pem`/private-key files anywhere on disk. It is the one layer the repository
boundary cannot provide: a `.env` inside your checkout is *in*-bounds for the boundary, so only a
deny rule stops it.

Two properties make this the security floor rather than one more preference:

- **Deny out-ranks everything.** Claude evaluates deny before ask before allow, so these beat both
  the scope allowlists and any `allow` a hook returns.
- **Deny is not a prompt.** There is no in-session override. If a denied path needs reading, carve
  it out of the behavior rather than working around it.

A denylist only catches what it names. It cannot cover unknown-sensitive files — a tax PDF, a
client repo under NDA — which is why it complements the scope perimeter instead of replacing it.

### Changing path scopes

Two different questions decide whether a file access prompts, and they are answered at different
times:

| Question | Resolved | Mechanism |
| --- | --- | --- |
| Which fixed directories are quiet? | Render time | Path allowlist in the manifest |
| Is this path in the current repository? | **Tool-call time** | `repo-scope` behavior, per provider |

For Claude, the repository zone is **wider for reads than for writes**, deliberately:

| | Reads | Writes |
| --- | --- | --- |
| The checkout in use | quiet | quiet |
| Its primary checkout and sibling worktrees | quiet | **prompt** |
| Anywhere else | prompt | prompt |

Reading `main` from a worktree to compare against it is routine and harmless, so reads span the
whole repository family. Writing across checkouts is rare and is how one session overwrites another's
in-flight work, so writes stay inside the checkout in use and prompt anywhere else.

Codex enforces only the write half of this table. If a repository's `docs/plans/plans-config.json`
sets `"worktreeRoot": "~/.worktrees"`, Codex also gets write access to that repository's worktree
folder, `~/.worktrees/<repo-folder-name>` — not to all of `~/.worktrees`. The folder is filled in
when `roborepo config apply` or `roborepo update` runs from inside the repository, or when you change
a permission.

Changes to the fixed path allowlist take effect after the next render (`roborepo update`, or a
permission change in the panel); the repository boundary is checked on every tool call, so it needs
no render.

## Required Rules

- Permission rows must use only `deny`, `ask`, `allow`, or `default`. There is no looser-profile
  confirmation because each behavior is independently reversible.
- Mutations write live config only; the repo template under `globals/` is never touched
  by the panel.
- Disabling a composite package leaves its shared required packages in place — disabling
  them could break other enabled packages.

## Edge Cases

- **Plugin enable cannot fetch.** Enabling a `plugin` package writes the marketplace
  entry and the `enabledPlugins` bool, but the harness performs the actual download on
  its next launch. A freshly enabled plugin shows as enabled before it is installed.
- **Native skill collision.** If a real (native-installed) skill directory already
  occupies a skill name, the skill toggle skips it rather than overwriting. The inspect popup
  reports the collision and preserves native-only metadata such as `agents/openai.yaml`.
- **Missing harness home.** Permission writes only target harness homes that already exist. If no
  harness config is present, the mutation reports that nothing was written.
