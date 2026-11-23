# Daily Use

Common tasks once RoboRepo is installed ([First-Time Setup](first-time-setup.md)). Everything runs
through `roborepo`: run it with no arguments for an interactive menu, or call a command directly.
Full reference: [RoboRepo CLI Commands](../reference/roborepo-cli.md).

## Browse and manage plan docs

Open the local portal and go to `/plans`:

```sh
roborepo web
```

The Plans page reads the Markdown plans that each repository RoboRepo knows about keeps under `plans/`
on its `repo-plans` branch. Turn on auto-discovery or add a folder under **Manage repositories** to
make repositories known, and run `/plan-suite-init` once in a repository to set up its plans, or to
reconnect to them on a new machine.
It works without enabling any workflow package: you can filter plans, open rendered Markdown, inspect
warnings/tasks, and copy repository-aware context.

Enable the plan suite for agent workflow prompts and one slash command per lifecycle step. The
`plan-suite` package holds all seven plan commands, including `/plan-suite-init` for repository
setup. The Plans page banner enables it. From the CLI, enable it with this command.

```sh
roborepo package enable plan-suite
```

Then use `/plan-write` to create or update a plan, `/plan-promote` to prepare it, `/plan-execute` to
implement it, `/plan-review` to review it and record your approval, `/plan-close` to close it after
you merge it, and `/plan-archive` to retire one you will not finish.

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

## Let agents act as a GitHub bot

By default, Claude and Codex act on GitHub as you: pushes and pull requests carry your identity, and
Codex's sandbox blocks GitHub, so it hands pushes back to you. The optional **GitHub Agent
Identity** package gives agents their own bot account instead. The bot can push feature branches,
open pull requests, and read and reply to review threads, but GitHub itself rejects its push to
`main` and its merges without your approval. `/plan-suite-init` offers the setup when it is missing,
or run it any time in your own terminal (agents are denied it, so the token never enters a
transcript):

```sh
roborepo github setup
roborepo github status    # read-only report
```

The setup walks you through each step and skips the ones already done:

1. Create a GitHub account for the bot, in a private window (guided).
2. Invite the bot to the repo as a collaborator with write access, not admin (automatic, as you).
3. Create a classic token for the bot with only `repo` and `read:org`, an expiry (90 days is a
   good default), and no `workflow` (guided, with the exact scopes shown), then paste it at a
   hidden prompt.
4. Accept the invite (automatic, as the bot).
5. Run `roborepo protect` if the repo needs it (it asks first), so the bot is not on any bypass list.
6. Check everything, then enable the package. A failed check does not turn it on; if it was already
   on, it stays on.

The portal's Home page tracks where this stands for each GitHub repo: the repo card shows the bot
account's status and the next step, and **Open setup** opens this same setup in a terminal (macOS;
elsewhere it shows the command to copy). See
[Agent GitHub account](../reference/repositories.md#agent-github-account).

The token is stored in plaintext, mode 0600, under `~/.roborepo/github-agent/gh`, because neither
Claude's nor Codex's sandbox can read the macOS keychain. Any process you run, agents included, can
read it, so the bot's limited role and the token's expiry are what bound the damage.

### Renew the bot's token

`roborepo doctor` and `roborepo github status` show a note when the token has 14 days or fewer
left, and one for a token with no expiry date. Once GitHub stops accepting the token, because it
expired or was revoked, agent pushes and `gh` calls fail with "Authentication failed" or "Bad
credentials", and the agent tells you to renew it. Agents never fall back to your own credentials.

To renew, run the setup again in your own terminal:

```sh
roborepo github setup
```

It recognizes the bot from the saved login and asks only for a new token. It opens your token list;
sign in as the bot, open the "RoboRepo agents" token, and choose **Regenerate token**, which keeps
its scopes. Paste the new value at the hidden prompt. Every other step reports itself already done.

You can renew early: when the saved token still works but expires within 14 days, has no expiry
date, or has the wrong scopes, the setup asks whether to replace it. A new token is checked before
it replaces the saved one; if it belongs to another account or has the wrong scopes, it is not
stored and the saved token keeps working.

Setup, status, and agent shells use the bot's saved token even if your shell exports `GH_TOKEN` or
`GITHUB_TOKEN`: the package sets both to empty in Claude and Codex agent shells. One exception: in a
session the Claude desktop app starts, a variable the app's own launch environment sets takes
precedence over Claude's settings, so do not set either token in that environment.

Turning the package off stops agents using the bot but leaves its files behind: the plaintext token
in `~/.roborepo/github-agent/gh/hosts.yml`, plus `ca-bundle.crt` and `gitconfig.local` next to it.
To remove the token, run `GH_CONFIG_DIR="$HOME/.roborepo/github-agent/gh" gh auth logout --hostname github.com`
(gh needs an absolute path) and revoke the token on GitHub. Delete the `github-agent` folder to
remove the rest.

If you decline, nothing changes: agents act as you, `gh api` stays denied, posting commands ask,
and Codex hands pushes back to you. The identity does not cover Gemini: Gemini loads only the first
`.env` it finds walking up from the working directory before `~/.gemini/.env`, so a repo's own
`.env` would hide RoboRepo's settings. See
[Claude Hooks](../reference/claude-hooks.md#acting-as-a-github-bot) for what it changes.

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
