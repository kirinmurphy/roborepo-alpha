---
id: telemetry-standalone-revert
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Reverting the Standalone Telemetry Shim

## Purpose

Telemetry was wired up **without installing roborepo**, to measure baseline token
traffic (read/grep activity) before the full CLI + default bundles are reinstalled.
This is a deliberate shoehorn: a symlinked `roborepo` command + hand-written hook
configs that fire only `telemetry capture`, with nothing else (no jcodemunch, no
skills, no rules, no MCP, no block-source-exploration guard, no caveman).

When per-package install lands and telemetry can be toggled directly, this shim
must be torn down so the real installer owns these files instead. This doc lists
exactly what was placed, and how to revert each piece cleanly.

## What the shim placed

Four artifacts, all created by hand (the installer never ran — there is no
`~/.roborepo/install-state.json` and no `~/.roborepo/presets/state.json`):

| # | Path | What it is | Owner after revert |
|---|------|-----------|--------------------|
| 1 | `~/.local/bin/roborepo` | Symlink → `<repo>/bin/roborepo`. Makes the `roborepo` command resolvable for the capture hooks and the shell. | The installer recreates this (or its portable equivalent). |
| 2 | `~/.roborepo/telemetry/` | Hand-written `state.json` (`{"enabled":true}`) + `spool/` + `collector/`. The captured data lives here. | Telemetry module owns this; data may be kept or purged. |
| 3 | `~/.claude/settings.json` | ONLY the 5 telemetry capture hooks (SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop). No plugins, no MCP, no other hooks. | The installer renders the full `globals/claude/settings.json` here. |
| 4 | `~/.codex/config.toml` (added `[features] hooks=true`) + `~/.codex/hooks.json` | `config.toml` got a `[features] hooks=true` block prepended; `hooks.json` holds ONLY the 5 capture hooks. Existing `config.toml` project/nux entries were preserved. | The installer renders the full codex config + hooks. |

> Note: `~/.claude/settings.local.json` was **not** touched by the shim. Leave it.

## Revert procedure

Do this **before** running the full install, so the installer writes onto clean
state instead of fighting hand-made files. The installer (`scripts/install/main.sh`)
will recreate the bin symlink, full `settings.json`, full codex `config.toml`, and
`hooks.json` itself.

### Step 1 — Decide the fate of captured data

The baseline measurement lives in `~/.roborepo/telemetry/spool/`. Two choices:

- **Keep it** (compare baseline vs. post-install): back it up out of the way first,
  because `roborepo telemetry purge --all` removes the whole telemetry dir.
  ```bash
  roborepo telemetry backup   # snapshots into ~/.roborepo/telemetry-backups/ (outside the purge target)
  ```
- **Discard it**:
  ```bash
  roborepo telemetry purge --all
  ```

The backup dir lives outside `~/.roborepo/telemetry/`, so a later `purge --all`
cannot delete a snapshot you already took.

### Step 2 — Remove the hand-written harness configs

The installer will recreate these. Remove the shim versions so there is no stale
content or merge ambiguity:

```bash
rm -f ~/.claude/settings.json          # shim-only; installer re-renders full version
rm -f ~/.codex/hooks.json              # shim-only; installer re-renders full version
```

For `~/.codex/config.toml`, the shim only **prepended** a `[features] hooks=true`
block — the rest is your real config. Either let the installer overwrite it (it
manages `config.toml` as a `root_config` row per `manifests/platform/manifest.tsv`),
or manually delete just these two lines if you want to preserve the file:

```toml
[features]
hooks = true
```

### Step 3 — Remove the bin symlink (optional)

The installer recreates `~/.local/bin/roborepo`. If you want a truly clean slate
first:

```bash
rm -f ~/.local/bin/roborepo
```

Skip this if you plan to run the installer immediately — it will overwrite the
symlink anyway (and the portable-install work may change its target).

### Step 4 — Run the full install

```bash
cd <repo>
./scripts/install/main.sh        # or the documented install entrypoint
```

After install, telemetry is managed through the real path:

```bash
roborepo telemetry enable    # writes state + applies the telemetry/hooks preset
roborepo telemetry serve     # dashboard
roborepo telemetry report    # terminal report
```

## Verification after revert

```bash
ls ~/.roborepo/install-state.json     # should now EXIST (proves real install ran)
roborepo telemetry status             # enabled + paths
diff <(cat ~/.claude/settings.json) <(cat <repo>/globals/claude/settings.json)  # should match the rendered install, not the 5-hook shim
```

If `install-state.json` exists and `~/.claude/settings.json` matches the full
rendered version (jcodemunch hooks, block-source-exploration, etc.), the shim is
fully superseded.

## Why this was a shim, not the real thing

`roborepo telemetry enable` calls `presetsApply(["telemetry"])`, which pulls in the
`hooks` preset (`scripts/cli/presets.mjs`) — that installs the *full* hook set
(jcodemunch nudges, source-exploration guard, write-guard). For a clean baseline we
needed capture firing with none of those, so the state file was written by hand to
bypass `enable`'s preset side-effect. Once per-package install exists, that toggle
is first-class and this bypass is unnecessary.
