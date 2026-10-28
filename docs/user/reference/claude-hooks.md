# Claude Hooks

Hooks are commands Claude Code runs at points in a session — when it starts, before a tool call,
after a tool call. RoboRepo installs a few that always run, and packages add more when you enable
them. Turn a package's hooks off by disabling the package in `/agents` or with
`roborepo package disable <id>`.

## What Runs

| Event | Hook | What it does | Installed by |
| --- | --- | --- | --- |
| SessionStart | Unmanaged skills notice | Counts skills in `~/.claude/skills` and `~/.codex/skills` that RoboRepo does not manage and suggests `roborepo skill adopt <name>` | always |
| SessionStart | jcodemunch status | Checks whether the jcodemunch server starts and this repository is indexed; reports stale indexes or a running watcher, and reminds Claude to use jcodemunch tools | `jcodemunch` |
| SessionStart | jdocmunch index check | If `docs/` exists but is not indexed, reminds Claude to run `roborepo index docs docs/` | `jdocmunch` |
| PreToolUse `Grep`, `Glob` | Search redirect | Blocks the call and tells Claude to use jcodemunch search tools instead | `jcodemunch` |
| PreToolUse `Bash` | Source-exploration block | Blocks shell commands that read source files directly (see below) | `jcodemunch` |
| PreToolUse `Bash` | Protected-branch push | Denies a `git push` that lands on a protected branch, so pushes to other branches need no prompt (see below) | always |
| PreToolUse `Bash` | Output minimizer | Trims noisy build, lint, and typecheck output; denies `--watch`, `--verbose`, and `--debug`; auto-allows a short list of safe read-only commands | always |
| PreToolUse `Bash` | Dense command log | Records commands of three or more lines to `<stateRoot>/capture/claude/dense-bash.jsonl` so you can find ones worth scripting. Never blocks | `capture-dense-bash` |
| PreToolUse `Read`, `Write`, `Edit` | Repository scope | Reads across the repository and its worktrees are quiet; writes outside the checkout in use prompt. See [Config Control Panel](config-control-panel.md#changing-path-scopes) | always |
| PreToolUse `Write`, `Edit` | Write guard | When Claude edits under `~/.claude` or `~/.codex`, adds a reminder about which files RoboRepo manages. `settings.local.json` is exempt | always |
| PostToolUse `Read` | Skill reference observer | Tells Claude which skill reference files it just read, for the skills-loaded line | `skill-visibility` |
| SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop | Telemetry capture | Records token and tool usage locally | `telemetry`, once token tracking is enabled in the portal or CLI |

Caveman mode on Claude comes from the `caveman` plugin, not a hook.

## Protected Branches

Agents can push without a prompt, but not to a protected branch: `main`, `master`, the remote's
default branch, and any names in the `ROBOREPO_PROTECTED_BRANCHES` environment variable
(comma-separated). Force pushes stay denied by the permission settings.

Two checks enforce this, for Claude and Codex alike:

| Check | When it runs | What it catches |
| --- | --- | --- |
| Protected-branch push hook | Before the shell command runs | Named pushes (`git push origin main`, `HEAD:main`, `:main`) and a bare `git push` whose destination is protected. Asks when it cannot tell, for example `--all` or a `$VARIABLE` |
| Git `pre-push` hook | When git pushes | Every push, from the exact refs git sends, including through aliases and scripts |

The `pre-push` hook reaches only agent shells. RoboRepo sets `core.hooksPath` for agents through
`GIT_CONFIG_*` variables in `~/.claude/settings.json` (`env`) and `~/.codex/config.toml`
(`shell_environment_policy.set`). They point at `~/.claude/hooks/git` or `~/.codex/hooks/git`.
Your own terminal is unaffected. Those hooks then run the repo's own hooks (from `.git/hooks` or
the repo's `core.hooksPath`), so tools like Husky keep working in agent sessions. Only the common
client-side hooks are passed through: commit, merge, rebase, checkout, applypatch, push, gc and
rewrite hooks. Others, such as `reference-transaction`, do not run in agent shells.

A push from your own terminal is never blocked. Pair this with branch protection on the remote for
a guard that does not depend on the local machine.

## When Installed Hooks Run

Claude Code has no per-hook approval like Codex's. Instead, an interactive session holds every hook
from settings files, including your user settings, until you accept workspace trust for that
folder. A `-p` or SDK session treats the folder as trusted. So RoboRepo can confirm a Claude hook is
installed and configured, but not that a session in an untrusted folder will run it; package status
says "configured" for that reason. See Claude Code's
[hooks reference](https://code.claude.com/docs/en/hooks#workspace-trust).

## Source-Exploration Block

Blocking `Grep` and `Glob` alone would let Claude shell out to read source instead, so a Bash hook
closes that route. It blocks a command only when **all** of these hold:

- the command is `grep`, `rg`, `ag`, `cat`, `head`, `tail`, or `find`
- it names a file path and has no pipe
- the path is inside the repository and has a source extension (`.ts`, `.py`, `.go`, …)
- the path is not under `node_modules`, `dist`, `build`, `.next`, `coverage`, or `vendor`

Everything else is allowed, because Bash legitimately does things jcodemunch cannot: grepping a
log, reading a JSON or lock file, piping `git log | grep`. The block message points Claude at the
jcodemunch tool to use instead. It runs before the output minimizer, so its decision is final.

See [Hooks Internals](../../internal/hooks-internals.md) for script locations and protocol detail.
