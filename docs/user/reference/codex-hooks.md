# Codex Hooks

Hooks are commands Codex runs at points in a session — when it starts, before a tool call, after a
tool call. RoboRepo installs a few that always run, and packages add more when you enable them.
Turn a package's hooks off by disabling the package in `/agents` or with
`roborepo package disable <id>`.

Codex runs non-managed hooks only after you review and trust their exact definitions. Enabling a
package installs its hooks but does not grant that trust. Codex CLI provides `/hooks` for review;
the macOS desktop app did not show a review prompt during RoboRepo's October 2026 QA. Sessions
that were already running do not pick up newly trusted hooks.

When Token Telemetry is enabled, Agents checks whether its five Codex capture hooks are active and
shows a warning if they are awaiting review, disabled, or missing. The warning does not change
Codex's trust decisions. Review is currently available through Codex's `/hooks` screen.

## What Runs

| Event | Hook | What it does | Installed by |
| --- | --- | --- | --- |
| SessionStart | Unmanaged skills notice | Counts skills in `~/.claude/skills` and `~/.codex/skills` that RoboRepo does not manage and suggests `roborepo skill adopt <name>` | always |
| SessionStart | Caveman mode | Turns on terse output; say "stop caveman" or "normal mode" to turn it off | `caveman` |
| SessionStart | jcodemunch nudge | Reminds Codex to explore code with jcodemunch tools | `jcodemunch` |
| SessionStart | jdocmunch index check | If `docs/` exists but is not indexed, reminds Codex to run `roborepo index docs docs/` | `jdocmunch` |
| PreToolUse (shell) | Per-command ask | Prompts before shell commands your permission settings put in the `ask` bucket (see below) | always |
| PreToolUse (shell) | Output minimizer | Appends `2>&1 \| tail -n 120` to noisy build, lint, and typecheck commands, forces `tsc --pretty false`, and denies `--watch`, `--verbose`, and `--debug` | always |
| PostToolUse | Skill reference observer | Tells Codex which skill reference files it just read, for the skills-loaded line. Codex does not yet deliver this event after shell reads, so Codex reads are under-counted | `skill-visibility` |
| SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop | Telemetry capture | Records token and tool usage locally | `telemetry`, once token tracking is enabled in the portal or CLI |

Codex has no `Grep`/`Glob` block or write guard; jcodemunch preference on Codex comes from the
generated rules in `~/.codex/AGENTS.md` and the command rules in `~/.codex/rules/`.

## Permissions On Codex

Your permission settings (see [Config Control Panel](config-control-panel.md#permissions)) reach
Codex in two layers:

| Bucket | How Codex enforces it |
| --- | --- |
| `allow` / `deny` | A command rule in `~/.codex/rules/default.rules`. These hold even if a hook fails to load |
| `ask` | The per-command ask hook above, since command rules can only allow or forbid |

A command no rule or hook classifies falls through to Codex's `approval_policy`.

`~/.codex/rules/` and `~/.codex/config.toml` are live files that Codex itself can change — for
example, approving "always allow this command" in a session appends a rule. Once they differ from
RoboRepo's version, `roborepo update` leaves them alone unless you choose `--on-conflict overwrite`.
`roborepo config root inspect` reports when `config.toml` has drifted; nothing checks `rules/` for
drift.

See [Hooks Internals](../../internal/hooks-internals.md) for script locations and protocol detail.
