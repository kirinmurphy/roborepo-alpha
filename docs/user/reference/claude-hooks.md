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
| PreToolUse `Bash` | Protected-branch push | Allows a `git push` it verified lands on a feature branch; denies protected branches and force pushes (see below) | always |
| PreToolUse `Bash` | Output minimizer | Trims noisy build, lint, and typecheck output; denies `--watch`, `--verbose`, and `--debug`; auto-allows a short list of safe read-only commands | always |
| PreToolUse `Bash` | Dense command log | Records commands of three or more lines to `<stateRoot>/capture/claude/dense-bash.jsonl` so you can find ones worth scripting. Never blocks | `capture-dense-bash` |
| PreToolUse `Read`, `Write`, `Edit` | Repository scope | Reads across the repository and its worktrees are quiet; writes outside the checkout in use prompt. See [Config Control Panel](config-control-panel.md#changing-path-scopes) | always |
| PreToolUse `Write`, `Edit` | Write guard | When Claude edits under `~/.claude` or `~/.codex`, adds a reminder about which files RoboRepo manages. `settings.local.json` is exempt | always |
| PostToolUse `Read` | Skill reference observer | Tells Claude which skill reference files it just read, for the skills-loaded line | `skill-visibility` |
| SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop | Telemetry capture | Records token and tool usage locally | `telemetry`, once token tracking is enabled in the portal or CLI |

Caveman mode on Claude comes from the `caveman` plugin, not a hook.

## Protected Branches

Agents can push to feature branches without a prompt. They cannot push to a protected branch:
`main`, `master`, the remote's default branch, and any names in the `ROBOREPO_PROTECTED_BRANCHES`
environment variable (comma-separated). They cannot force-push to any branch.

The permission settings leave `git push` at **ask**. The protected-branch hook is what approves a
push, and only one it has checked. So an install without the hooks, a harness without them (Gemini),
and `roborepo agent-run` all keep the prompt.

Two checks enforce this, for Claude and Codex alike:

| Check | When it runs | What it does |
| --- | --- | --- |
| Protected-branch push hook | Before the shell command runs | Allows a push it verified lands on non-protected branches, when the whole command is pushes and the `pre-push` hook is installed. Denies protected destinations and every force spelling (`--force` anywhere, `--force-with-lease=<ref>`, `-uf`, a `+` refspec). Asks when it cannot tell: `--all`, `:`, a `$VARIABLE`, `--no-verify`, an unrecorded remote default branch, or a source-only refspec under `remote.<name>.push` |
| Git `pre-push` hook | When git pushes | Checks the exact refs git sends, including through aliases and scripts. Refuses protected destinations and any update that is not a fast-forward. Looks up the remote's default branch from the remote when it is not recorded locally, and refuses when it cannot |

Anything else in the same command (`git push origin feat && npm publish`) leaves the whole command to
the permission prompt, so the hook's approval never covers it.

On Codex, every push the hook would ask about is denied instead, with a message to run it yourself.
Codex has been seen running commands whose hook result was ask without prompting, and a push with
`--no-verify` skips the `pre-push` hook, so an unchecked ask could reach `main`. Claude still asks.

The `pre-push` hook reaches only agent shells. RoboRepo sets `core.hooksPath` for agents through
`GIT_CONFIG_*` variables in `~/.claude/settings.json` (`env`) and `~/.codex/config.toml`
(`shell_environment_policy.set`). They point at `~/.claude/git-hooks` or `~/.codex/git-hooks`, which
install with the base configuration. Your own terminal is unaffected. Those hooks then run the
repo's own hooks (from `.git/hooks` or the repo's `core.hooksPath`), so tools like Husky keep
working in agent sessions. Only the common client-side hooks are passed through: commit, merge,
rebase, checkout, applypatch, push, gc and rewrite hooks. Others, such as `reference-transaction`,
do not run in agent shells.

A push from your own terminal is never blocked. Pair this with branch protection on the remote for
a guard that does not depend on the local machine.

## Opening Pull Requests With gh

Agents can open pull requests and read them with the GitHub CLI. The protected-branch guards only
see `git`, and `gh` talks to the GitHub API, so the permission settings sort `gh` commands by what
they can reach:

| Bucket | Commands |
| --- | --- |
| allow | `gh pr create`; read-only `gh pr view`, `pr list`, `pr status`, `pr checks`, `pr diff`, `gh run list`, `run view`, `gh repo view` |
| ask | `gh pr comment`, `pr edit`, `pr ready`, `pr review`, `pr close`, `pr reopen`, `gh issue create`, `issue comment` |
| deny | `gh pr merge`, `gh api`, `gh auth token`, `gh repo edit`, `repo delete`, `repo rename`, `gh secret`, `gh variable`, `gh release`, `gh workflow run` |

The protected-branch hook also denies the deny-bucket commands when global flags come first
(`gh -R owner/repo pr merge 12`), a form the prefix rules miss.

The workflow an agent should follow:

1. Push the branch on its own: `git push -u origin <branch>`. The protected-branch hook approves it.
2. Open the pull request as a separate command:
   `gh pr create --base main --head <branch> --title "…" --body-file <file>`. `--head` stops `gh`
   from pushing or forking by itself.

A push chained to anything else (`git push … && gh pr create …`) goes to the permission prompt
as a whole. To read review comments, use `gh pr view --comments`; `gh api` is denied even for reads.

`gh` acts with your GitHub token, so to GitHub an agent is you. These rules are local. Add a branch
ruleset on GitHub for `main` that requires a pull request, blocks force pushes and deletion, and does
not let administrators bypass it. That is the guard that holds if a local rule is too broad.

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
