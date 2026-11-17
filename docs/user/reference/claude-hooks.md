# Claude Hooks

Hooks are commands Claude Code runs at points in a session — when it starts, before a tool call,
after a tool call. RoboRepo installs a few that always run, and packages add more when you enable
them. Turn a package's hooks off by disabling the package in `/agents` or with
`roborepo package disable <id>`.

## What Runs

| Event | Hook | What it does | Installed by |
| --- | --- | --- | --- |
| SessionStart | Unmanaged skills notice | Counts skills in `~/.claude/skills` and `~/.codex/skills` that RoboRepo does not manage and suggests `roborepo skill adopt <name>` | always |
| PreToolUse `Bash` | Protected-branch push | Allows a `git push` it verified lands on a feature branch; denies protected branches and force pushes; denies merges into a checkout on a protected branch and asks before a delete there (see below) | always |
| PreToolUse `Bash` | Output minimizer | Trims noisy build, lint, and typecheck output; denies `--watch`, `--verbose`, and `--debug`; auto-allows a short list of safe read-only commands, alone or piped into read-only filters such as `head` or `wc`, never with anything chained or redirected | always |
| PreToolUse `Bash` | Dense command log | Records commands of three or more lines to `<stateRoot>/capture/claude/dense-bash.jsonl` so you can find ones worth scripting. Never blocks | `capture-dense-bash` |
| PreToolUse `Read`, `Write`, `Edit` | Repository scope | Reads across the repository and its worktrees are quiet; writes outside the checkout in use prompt. See [Config Control Panel](config-control-panel.md#changing-path-scopes) | always |
| PreToolUse `Write`, `Edit` | Write guard | When Claude edits under `~/.claude` or `~/.codex`, adds a reminder about which files RoboRepo manages. `settings.local.json` is exempt | always |
| PostToolUse `Read` | Skill reference observer | Tells Claude which skill reference files it just read, for the skills-loaded line | `skill-visibility` |
| SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop | Telemetry capture | Records token and tool usage locally | `telemetry`, once token tracking is enabled in the portal or CLI |

Caveman mode on Claude comes from the `caveman` plugin, not a hook.

## Protected Branches

Agents can push to feature branches without a prompt. They cannot push to a protected branch:
`main`, `master`, the remote's default branch, any names in the `ROBOREPO_PROTECTED_BRANCHES`
environment variable (comma-separated), and `repo-plans`, the plans store branch. They cannot
force-push to any branch.

`repo-plans` changes only through `roborepo plans` commands, which run their own Git with hooks off.
So the same hooks also refuse a hand-made commit or merge commit in a checkout of `repo-plans`: the
`pre-commit` and `pre-merge-commit` hooks in the same folder stop it before it is recorded.

The permission settings leave `git push` (`push-code`) at **ask**. The protected-branch hook is
what approves a push, and only one it has checked. So a harness without the hook (Gemini) and
`roborepo agent-run` keep the prompt.

For Claude, that ask renders no permission rule. Claude applies an ask rule even when a hook
approves the call, so with the rule in place every push prompted, verified or not. Without it, the
hook decides: it allows a verified feature-branch push, asks about one it cannot check, and denies
`main` and force pushes, which the `rewrite-history` deny rules also block. If the hook is missing,
an unlisted `git push` still prompts in Claude's default permission mode. Setting `push-code` to
`allow` or `deny` renders those rules as usual.

Two checks enforce this, for Claude and Codex alike:

| Check | When it runs | What it does |
| --- | --- | --- |
| Protected-branch push hook | Before the shell command runs | Allows a push it verified lands on non-protected branches, when the whole command is pushes and the `pre-push` hook is installed. Denies protected destinations and every force spelling (`--force` anywhere, `--force-with-lease=<ref>`, `-uf`, a `+` refspec). Asks when it cannot tell: `--all`, `:`, a `$VARIABLE`, `--no-verify`, an unrecorded remote default branch, or a source-only refspec under `remote.<name>.push`. Asks before deleting any remote branch (`--delete`, `:branch`). A redirect into a file keeps the push from being approved silently; `2>/dev/null` does not |
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

### Merges into a protected branch

Agents never merge into a protected branch, locally or on GitHub. In a checkout that has one checked
out, the hook denies `git merge`, `git pull`, `git rebase`, `git cherry-pick`, and `git am` (Claude
and Codex alike), following `cd`, `git -C`, subshells, and `sh -c` the same way as for deletes. Two
forms stay allowed because they bring in no new commits:

- a fast-forward-only update from the branch's own upstream, meaning its configured remote (`origin`
  when none is set) and its own name: `git pull --ff-only`, `git pull --ff-only origin main`,
  `git merge --ff-only origin/main`, `git merge --ff-only @{u}`;
- stopping one in progress: `--abort` or `--quit`.

A fast-forward from anything else is denied: `git merge --ff-only feature` would land the feature
branch, and `git pull --ff-only <path or URL>` another repository's history. So is one with
`--upload-pack` or `git -c`/`--config-env`, which can point the fetch at another repository under
the remote's name. To bring `main` into a
feature branch, run `roborepo plans sync-base` from that branch's worktree.

The agents' git hooks back this up, however the command reached git, such as through an alias:
`pre-merge-commit` refuses a merge commit on a protected branch, `pre-commit` refuses finishing one
(after a conflict or `--no-commit`), and `pre-rebase` refuses rebasing one. A fast-forward,
`cherry-pick`, `am`, and `merge --squash` make ordinary commits, so only the shell hook sees those.
Your own terminal is unaffected.

### Deletes on a protected branch

Deleting files is allowed by default (`delete-files`), because Claude's shell sandbox keeps shell
commands inside the session's checkout and the temp folders. That still leaves the checkout itself,
which on `main` is the one you most want intact. The same hook adds that check:

| Delete target | Result |
| --- | --- |
| A temp folder (`/tmp`, `/private/tmp`, `/var/folders`, `$TMPDIR`) | Runs, no prompt |
| A checkout or worktree on a feature branch | Runs, no prompt |
| A checkout with a protected branch checked out, including its `.git` folder | Asks (Codex: denied) |
| A folder holding such a checkout up to two levels down | Asks (Codex: denied) |
| A path the shell expands | Judged by its literal part: `$TMPDIR/x` is temp, `/repo/src/*` is `/repo/src`; a word that starts with an expansion (`"$f"`, `*.log`) is judged by the folder the command runs in |

It recognizes `rm`, `rmdir`, `unlink`, `find … -delete` or `-exec rm`, `xargs rm`, `git rm`,
`git clean -f`, `git reset --hard`, `git restore` of the working tree, and `git stash drop` or
`clear`. It finds them chained, in loops and `if` blocks, in subshells and `$(…)`, behind wrappers
such as `env`, `command`, `nohup`, `time`, and `sudo`, and inside `sh -c`. It follows `cd`, `cd -`,
`pushd`, `popd`, `~`, `$TMPDIR`, and `git -C`, and a `cd` inside `( … )` or `$(…)` ends with it. A
`cd` to any other variable or to a `$(…)` is not followed, so later deletes are judged by the folder before it,
though a `cd -` or `popd` after it still returns where the shell does. It cannot see a delete
hidden in a script, `mv` over a file, or a redirect that truncates one.

A few more rules keep a temp-looking path from reaching a protected checkout:

- Paths are followed through symlinks the way the shell walks them, so `/tmp/link/x`, `/tmp/link/`,
  and `/tmp/link/../x` are judged where they land, and so is `$TMPDIR/../x`. Deleting the link
  itself (`rm /tmp/link`) removes only the link, so it is judged as the temp folder.
- After a `cd` or `pushd` to a folder that does not exist yet, later commands are judged both there
  and in the folder before it, since the move may fail or follow a `mkdir`. Every such folder stays
  in play through further moves, `cd -`, and `popd`.
- Operands written after `find … -exec rm` or `xargs rm` count, not only where the command runs.
- A `git switch` or `git checkout` earlier in the command counts alongside the branch already
  checked out, since the switch may fail. `-b main` (or `-bmain`, `--create=main`), `--track origin/main`, and a name the hook
  cannot read (`-`, `@{-1}`, a variable) count as protected.
- When Claude runs a command outside its sandbox (`dangerouslyDisableSandbox`), nothing limits a
  delete to the checkout, so any delete outside the temp folders asks.

Protected branches are the same list as for pushes. `ROBOREPO_TEMP_ROOTS` (comma-separated)
replaces the temp folder list.

The hook runs on every shell call, sandboxed or not. That matters because the desktop app was seen
running a sandboxed `rm` without the prompt its ask rule called for, while a hook's ask on a
sandboxed command did prompt. Gemini runs neither the sandbox nor this hook, so set `delete-files`
to `ask` if you run agents there.

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
(`gh -R owner/repo api …`), a form the prefix rules miss. Agents never merge a pull request
(`merge-pull-requests`): you merge it on GitHub.

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

See [Hooks Internals](../../internal/hooks-internals.md) for script locations and protocol detail.
