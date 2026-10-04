# Using the `roborepo` CLI

`roborepo` is the single front door for setup, packages, indexing, skills, telemetry, and
maintenance. Run it with no arguments for an interactive menu, or call a command directly:

```sh
roborepo                # interactive menu
roborepo help           # primary commands and namespaces
roborepo help <name>    # help for one namespace, e.g. roborepo help package
```

> If `roborepo` is not found, run `roborepo doctor` (or `./bin/roborepo doctor` from a checkout
> before the first install) — it reports whether the command is installed and on `PATH`, with the
> exact fix.

## Install and PATH

An npm install puts `roborepo` on your `PATH` through npm. A checkout install
(`./scripts/install/main.sh`) wires it for you on macOS and Linux: it symlinks `bin/roborepo` into
`~/.local/bin/roborepo` and adds `~/.local/bin` to your shell profile if it is missing. Every
`roborepo update` re-checks both.

| Shell | Profile the installer edits |
| --- | --- |
| zsh | `~/.zshrc` |
| bash | `~/.bash_profile` on macOS, `~/.bashrc` on Linux; whichever already exists wins |
| other | `~/.profile` if it exists; otherwise the installer prints the line to add instead of guessing |

Set `ROBOREPO_SHELL_PROFILE=/path/to/profile` to choose the file yourself. Open a new shell after
the first install so the command resolves.

On Windows with PowerShell, add `~/.local/bin` to your `PATH` by hand (System Environment Variables
or `$PROFILE`), then restart the shell. Without Git Bash, call the Node entry directly:
`node <repo>/scripts/cli/main.mjs <args>`.

## First Run

| Command | What it does |
| --- | --- |
| `roborepo web` | On a fresh install, runs one-time setup, then opens the portal. See [First-Time Setup](../guides/first-time-setup.md). |
| `roborepo init [--dry-run] [--force]` | Runs the same setup, then asks whether to configure in the browser or the CLI. Safe to re-run: a completed install reports and exits. `--dry-run` previews; `--force` re-runs the full workflow. |
| `roborepo library` | Opens the Package Library to change which behaviors are enabled. Same as `roborepo package manage`. |

A bare, interactive `roborepo` on an uninitialized install goes into `init` automatically. Explicit
commands are never gated on initialization — `doctor`, `version`, and `--help` work before it, and
bare non-interactive invocations open the normal menu rather than a wizard, so scripts are safe.

Zero detected harnesses is a valid initialization: install or launch a supported harness later and
run `roborepo harness refresh`.

## Setup and Maintenance

| Command | What it does |
| --- | --- |
| `roborepo update [--dry-run] [--verbose] [--on-conflict keep\|overwrite\|abort]` | Re-applies harness config on this machine: copied files, rendered rules, root config, command install, and shell wiring. Use after pulling repo changes or upgrading the package; `--verbose` includes unchanged items in the report. `--on-conflict` sets the [collision policy](../guides/install-workflows.md#collision-policy). |
| `roborepo version` | Prints the package version and the directories RoboRepo runs from. |
| `roborepo config status` | Shows enabled behaviors and packages. |
| `roborepo config root inspect` | Read-only report of each harness root config (`~/.claude/settings.json`, `~/.codex/config.toml`): baseline vs. active file and its drift state — `in sync`, `drifted` (edited since RoboRepo's last write), `staged update pending`, or untracked. |
| `roborepo doctor [--verbose]` | Runs harness health checks for config files, links, helper commands, dependencies, and generated outputs. |
| `roborepo doctor --installed [--verbose]` | Verifies that installed harness paths resolve correctly; also fails when a local store is over its size cap. |
| `roborepo maintenance repair [--dry-run] [--on-conflict ...]` | Repairs a moved or renamed checkout by relinking stale symlinks against the current path; it leaves copied config content alone. |
| `roborepo maintenance repair local-config [--dry-run or --apply]` | Recovers safe local Claude/Codex settings from recent backups when `update` or `doctor --installed` reports local config repair candidates. |
| `roborepo maintenance stores [list]` | Lists the local stores RoboRepo keeps on disk — telemetry spools, runtime history, capture logs — with each one's size against its bound. |
| `roborepo maintenance stores reset <id> [--all]` | Reclaims space in one store. Applies that store's own retention policy, or with `--all` clears it outright. Store ids come from `stores list`. |
| `roborepo maintenance portal-pids [--reap]` | Lists `~/.roborepo/portal/server-<port>.pid` files and whether each one's process is still alive. `--reap` deletes only entries whose process is gone, never a running portal or one owned by another user. |

From a development checkout, two more commands render generated files after you edit their sources:

| Command | What it does |
| --- | --- |
| `roborepo rules [--check]` | Renders generated Claude/Codex global instruction files, or verifies them with `--check`. |
| `roborepo permissions [--check]` | Renders harness permission outputs from `manifests/inventory/agent-permissions.json`, or verifies them with `--check`. |

## Uninstall

| Command | What it does |
| --- | --- |
| `roborepo uninstall [--dry-run] [--yes] [--delete-workspace]` | Removes RoboRepo-managed harness configuration and machine-local state, then (in package mode) the npm package. `~/.roborepo/workspace` is preserved by default. `--dry-run` previews without changing anything; `--yes` is required to run destructively without a TTY; `--delete-workspace` also removes `~/.roborepo/workspace`. |

Run `roborepo uninstall` rather than `npm uninstall`: removing the npm package alone leaves your
RoboRepo configuration in place. See [Uninstall](../guides/install-workflows.md#uninstall).

## Packages

| Command | What it does |
| --- | --- |
| `roborepo package list` | Lists packages grouped by category with live enabled/disabled status. |
| `roborepo package inspect <id>` | Prints the full manifest for one package. |
| `roborepo package enable <id>` | Enables a package and applies it immediately — permissions, hooks, rules, MCP, and commands install without a separate `roborepo update`. |
| `roborepo package disable <id>` | Disables a package and removes its owned contributions immediately. |
| `roborepo package reconcile` | Re-applies every enabled package and drops enabled-but-unknown stale entries. |
| `roborepo package adopt-live [--dry-run]` | Detects externally installed package behavior and marks it enabled without reinstalling it. |
| `roborepo package validate [id]` | Validates one package or the whole catalog against the manifest schema. |
| `roborepo package dev create <id> [--kind=empty\|auto-skill\|skill-command\|standalone-command] [--description=...] [--default-enabled=true]` | Scaffolds a new package under `globals/packages/<id>/` (dev checkout) or `~/.roborepo/workspace/packages/<id>/` (package mode). Refuses to overwrite an existing package. |

Most users only need `list`, `inspect`, `enable`, and `disable`.

## Local Portal

| Command | What it does |
| --- | --- |
| `roborepo web [--no-open] [--port <n>]` | Starts the local portal on `127.0.0.1` (default port `4317`) and opens it. `/config` manages packages and permissions, `/plans` browses plan docs, `/runtime` lists local web apps, and `/tokens` shows token usage when telemetry has data. |
| `roborepo web --detach [--no-open] [--port <n>]` | Starts the same portal in the background. A cold start warms its views before binding and can take ~30s. |
| `roborepo web stop [--port <n>]` | Stops the detached portal. PID files are tracked per port, so pass the same `--port` used to start it. |
| `roborepo runtime [--json] [--open]` | Lists active localhost HTTP apps, prints the portal snapshot as JSON, or opens `/runtime`. |

If a portal is already running on the port, `roborepo web` reuses it when it runs current code and
restarts it when the code has changed since it started.

See [Plan Suite Walkthrough](../guides/plan/lifecycle/plan-suite.md),
[Telemetry Walkthrough](../guides/telemetry.md), and [Runtime](developer-runtime.md) for the pages.

## Telemetry

Telemetry is local and opt-in. See [Telemetry](telemetry.md) for what is captured.

| Command | What it does |
| --- | --- |
| `roborepo telemetry enable` / `disable` | Turns capture on or off. |
| `roborepo telemetry status` | Shows capture state. |
| `roborepo telemetry report [--deep]` | Prints findings, spikes, sessions, and cost breakdowns. `--deep` adds an LLM summary of the computed findings. |
| `roborepo telemetry mark --type <type> --title <title> [...]` | Records a marker, such as a change you want to measure. |
| `roborepo telemetry experiment start\|end\|status [<id>]` | Starts, ends, or inspects an experiment. |
| `roborepo telemetry export` | Prints the raw capture data as JSON. |
| `roborepo telemetry backup` | Snapshots telemetry data to `~/.roborepo/telemetry-backups/`. |
| `roborepo telemetry purge --all [--backup]` | Deletes all telemetry data; `--backup` snapshots it first. |
| `roborepo telemetry install` | Wires only the capture hooks, for measuring usage before adopting the rest of RoboRepo. |

## Indexing

Indexing commands are owned by packages, so enable the owning package first. If it is not enabled,
RoboRepo prints which package to enable.

| Command | Package | What it does |
| --- | --- | --- |
| `roborepo index code [path]` | `jcodemunch` | Indexes code in the current directory or `[path]`. |
| `roborepo index code [path] --watch` | `jcodemunch` | Keeps the code index current while files change. |
| `roborepo index docs [path]` | `jdocmunch` | Indexes documentation in the current directory or `[path]`. |

```sh
roborepo package enable jcodemunch
roborepo index code --watch
```

## Skills

| Command | What it does |
| --- | --- |
| `roborepo skill new` | Scaffolds a package-owned skill or slash command and updates package config, generated outputs, commands, and README. |
| `roborepo skill adopt <name>` | Moves an unmanaged native skill into shared RoboRepo source and refreshes the managed harness views. |
| `roborepo skill export-to-project` | Copies shared skills into the current project and leaves a shareable zip bundle. |
| `roborepo skill link-project` | Links a project's `.codex/skills` into existing `.claude/skills` folders. |
| `roborepo skill sync-global` | Refreshes the shared skill cache and global harness links after adding or removing shared skills. |
| `roborepo skill inspect <name>` | Reports skill source, managed/unmanaged ownership, native collision state, and per-harness install state. |
| `roborepo skill native [--full]` | Shows native Claude/Codex plugin entrypoints; `--full` prints native help output inline. |
| `roborepo skill audit [--check]` | Renders or checks the shared skill invocation audit. |
| `roborepo skill triggers [--check]` | Checks trigger and near-miss fixtures from `manifests/inventory/skill-trigger-tests.json`. |
| `roborepo skill render-commands [--check]` | Renders generated slash commands from package `slash-command` resources, or verifies them. |

See [RoboRepo Skills Interface](roborepo-skills.md) for the managed/native boundary and examples.

## MCP Setup

| Command | What it does |
| --- | --- |
| `roborepo mcp add <name-or-url> [--harness <id>] [--dry-run] [--skip-claude-permission]` | Registers an MCP server with every managed harness that supports MCP (Claude, Codex, Gemini). Repeat `--harness <id>` to target a subset. |
| `roborepo mcp apply [--dry-run]` | Applies registered MCP servers. |

| You pass | Registered as |
| --- | --- |
| `jcodemunch` or `jdocmunch` | A built-in preset |
| Any other name | A `uvx` package |
| An HTTP URL | An HTTP server |

- `mcp add` writes each harness's active config, not the repo baseline, so the server works
  immediately.
- For Claude it also allows the server's tools in `~/.claude/settings.json`, so you are not prompted
  on every call; `--skip-claude-permission` skips that.
- `--dry-run` prints the planned writes without changing anything.

## Command Output

| Command | What it does |
| --- | --- |
| `roborepo run <cmd> [args...]` | Runs a command and prints a trimmed output tail so noisy checks stay readable. |

> `roborepo dev …` exists only in a Git checkout of RoboRepo itself; the scripts it drives are not
> published to npm, so an installed copy reports that it requires a development checkout.
