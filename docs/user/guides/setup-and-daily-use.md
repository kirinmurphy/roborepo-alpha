# Daily Use

Common tasks once RoboRepo is installed ([First-Time Setup](first-time-setup.md)). Everything runs
through `roborepo`: run it with no arguments for an interactive menu, or call a command directly.
Full reference: [RoboRepo CLI Commands](../reference/roborepo-cli.md).

## Browse and manage plan docs

Open the local portal and go to `/plans`:

```sh
roborepo web
```

The Plans page reads Markdown files under `docs/plans/**/*.md` in every repository RoboRepo knows
about. Turn on auto-discovery or add a folder under **Manage repositories** to make repositories
known.
It works without enabling any workflow package: you can filter plans, open rendered Markdown, inspect
warnings/tasks, and copy repository-aware context.

Enable the plan suite when you want agent workflow prompts and one slash command per lifecycle
step. The six plan commands ship as one `plan-suite` package, and `/session-close` is its own
package. The Plans page banner enables both at once; from the CLI:

```sh
roborepo package enable plan-suite
roborepo package enable session-close
```

Then use `/plan-write` to create or update a plan, `/plan-promote` to prepare it, `/plan-execute` to
implement it, `/plan-review` to review it and record your approval, `/plan-close` to close it after
you merge it, `/plan-archive` to retire one you will not finish, and `/session-close` to end a chat.

See [Plan Suite Walkthrough](plan/lifecycle/plan-suite.md) for the full user flow.

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

- **Codex hooks not running.** Codex runs a hook only after you trust it. The portal's Home,
  Settings, and Tokens notice and `roborepo doctor --installed` name RoboRepo hooks awaiting review;
  see [Codex Hooks](../reference/codex-hooks.md#trusting-roborepos-hooks).
- **Recovering settings.** If a past update left recoverable local settings in a backup,
  `roborepo update` or `roborepo doctor --installed` points you at
  `roborepo maintenance repair local-config --dry-run`; `--apply` restores them.
- **Moved checkout.** If you move or rename a Git checkout install, `roborepo maintenance repair`
  relinks stale symlinks to the new path and leaves copied config alone.

## Customize from a checkout

These change the defaults RoboRepo ships, so they apply when you installed from a Git checkout.

### Add a shared skill

Use `roborepo package dev create` for a new package, or `roborepo package dev add-skill` to add a
skill to an existing one. The canonical source lives once in
`globals/packages/<package>/skills/<name>/`; `roborepo skill sync-global` then refreshes the shared
skill cache and every supporting harness's `skills/<name>` view.

```sh
roborepo package dev create <id> --kind=auto-skill    # scaffold a package with one skill
roborepo package dev add-skill <package-id> <skill-id> # add a skill to an existing package
roborepo skill sync-global      # refresh the shared skill cache + every harness view
roborepo doctor --installed     # verify the live skill cache and harness links are current
```

### Edit global rules

Global instruction files are generated tracked outputs:

- `generated/claude/CLAUDE.md`
- `generated/codex/AGENTS.md`

Gemini does not currently have a tracked generated rules file. When Gemini is installed,
RoboRepo renders live rules into `~/.gemini/GEMINI.md`; its generated permission policy lives under
`generated/gemini/policies/` before installation.

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

Day to day, change permissions in the `/agents` page or `roborepo library`. To change the defaults
every machine starts from, edit `manifests/inventory/agent-permissions.json`, then render and check:

```sh
roborepo config permissions --render
roborepo config permissions --check
```

The rendered defaults reach an existing machine on the next `roborepo update`.
