# Daily Use

Common tasks once RoboRepo is installed ([First-Time Setup](first-time-setup.md)). Everything runs
through `roborepo`: run it with no arguments for an interactive menu, or call a command directly.
Full reference: [RoboRepo CLI Commands](../reference/roborepo-cli.md).

## Browse and manage plan docs

Open the local portal and go to `/plans`:

```sh
roborepo web
```

The Plans page discovers Markdown files under `docs/plans/**/*.md` from configured discovery roots.
It works without enabling any workflow package: you can filter plans, open rendered Markdown, inspect
warnings/tasks, and copy repository-aware context.

Enable the plan suite when you want agent workflow prompts and one slash command per lifecycle
step. The Plans page banner enables all five at once; from the CLI, enable each package:

```sh
roborepo package enable plan-write
roborepo package enable plan-promote
roborepo package enable plan-start
roborepo package enable plan-close
roborepo package enable session-close
```

Then use `/plan-write` to create or update a plan, `/plan-promote` to prepare it, `/plan-start` to
implement it, `/plan-close` to close it once the work lands, and `/session-close` to end a chat.

See [Plan Suite Walkthrough](plan/lifecycle/plan-suite.md) for the full user flow.

## Index and watch a repo

Keep the package-owned code index current so Claude can navigate your codebase. Start this when opening a project you'll be actively coding in. The watcher runs continuously — edits are picked up automatically within the session.

```sh
roborepo package enable jcodemunch       # once per machine, if not already enabled
roborepo index code --watch       # watch the current dir (runs continuously)
roborepo index code path/to/dir --watch
roborepo index code path/to/dir   # one-shot index instead of watching
```

## Index docs

Index a project's documentation so Claude can search sections and headings rather than reading full files. Run once per project to initialize. After that, edits to existing files are picked up automatically via mtime detection — no manual reindex needed. Re-run only when doc files are added or deleted.

```sh
roborepo package enable jdocmunch        # once per machine, if not already enabled
roborepo index docs               # index docs in the current dir
roborepo index docs path/to/dir
```

## Work with skills

```sh
roborepo skill inspect <name>   # inspect ownership, native metadata, collisions, and install state
roborepo skill adopt <name>     # bring in a skill created outside roborepo (by hand or natively)
roborepo skill native           # summarize native Claude/Codex plugin entrypoints
roborepo skill native --full    # print native help output inline
```

## Run noisy commands with trimmed output

Some commands flood the terminal. Wrap them to get only the useful tail.

```sh
roborepo run <command> [args]
```

## Fix problems

Something feels off — commands missing, config not loading, hooks not firing. Run this to verify key files, JSON/TOML config, helpers, and dependencies.

```sh
roborepo doctor                        # concise health summary
roborepo doctor --verbose              # include every passing check
roborepo doctor --installed            # also check harness links and managed skills
roborepo doctor --installed --verbose  # include every passing check
```

- **Recovering settings.** If a past update left recoverable local settings in a backup,
  `roborepo update` or `roborepo doctor --installed` points you at
  `roborepo maintenance repair local-config --dry-run`; `--apply` restores them.
- **Moved checkout.** If you move or rename a Git checkout install, `roborepo maintenance repair`
  relinks stale symlinks to the new path and leaves copied config alone.

## Customize from a checkout

These change the defaults RoboRepo ships, so they apply when you installed from a Git checkout.

### Add a shared skill

Use `roborepo skill new` — it scaffolds a package-owned skill resource and refreshes the shared
skill cache plus both `~/.claude/skills/<name>` and `~/.codex/skills/<name>` in one step. The
canonical source lives once in `globals/packages/<package>/skills/<name>/`.

```sh
roborepo skill new              # scaffold + refresh shared skill cache + every harness view
roborepo skill sync-global      # refresh after adding or removing skills by hand
roborepo doctor --installed     # verify the live skill cache and harness links are current
```

### Edit global rules

Global instruction files are generated tracked outputs:

- `generated/claude/CLAUDE.md`
- `generated/codex/AGENTS.md`
- `generated/gemini/GEMINI.md`

Edit source fragments instead:

- `globals/system/rules/shared/` for behavior shared by every harness
- `globals/system/rules/<harness-id>/` for behavior specific to one harness
  (`claude/`, `codex/`; add `gemini/` if Gemini ever needs its own fragments)

Shared fragments render into every managed harness. A per-harness directory is created only when
that harness needs rules the others should not get.

Then render and check:

```sh
roborepo config rules
roborepo config rules --check
```

### Change permission defaults

Day to day, change permissions in the `/config` page or `roborepo library`. To change the defaults
every machine starts from, edit `manifests/inventory/agent-permissions.json`, then render and check:

```sh
roborepo permissions
roborepo permissions --check
```

The rendered defaults reach an existing machine on the next `roborepo update`.
