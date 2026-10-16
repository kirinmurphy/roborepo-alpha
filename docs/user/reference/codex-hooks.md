# Codex Hooks

Hooks are commands Codex runs at points in a session — when it starts, before a tool call, after a
tool call. RoboRepo installs a few that always run, and packages add more when you enable them.
Turn a package's hooks off by disabling the package in `/agents` or with
`roborepo package disable <id>`.

## Trusting RoboRepo's Hooks

Codex runs a non-managed hook only after you review and trust its exact definition. Enabling a
package installs its hooks but does not grant that trust, and RoboRepo never grants it for you.
To review hooks in the Codex app:

1. Open **Settings → Hooks** in Codex.
2. Review the RoboRepo hooks named in the portal's Home, Settings, or Tokens notice. Trust only the
   definitions you want to run.
3. Start a new Codex session. Sessions already running do not pick up newly trusted hooks.

If you use Codex in a terminal, opening the CLI automatically shows **Hooks need review** when
hooks need trust. Choose **Review hooks** and trust only the definitions you want to run; avoid
**Trust all** if other hooks are listed. Use `/hooks` later to reopen the review. The RoboRepo
notice keeps the terminal command under **Terminal alternative** when a Codex executable is
available.

Trust is stored in `~/.codex/config.toml`, which the desktop app reads too.

Codex keys trust by a hook's position in `~/.codex/hooks.json`. RoboRepo adds a package's Codex
hooks after the existing ones, so enabling a package leaves the hooks you already trusted where they
were. Disabling a package moves the hooks after it at the same event, and Codex asks you to review
those again.

## Checking Hook Readiness

Settings, Tokens, and Home show a warning for package hooks that need attention, and for core hooks
that need review or are turned off.
`roborepo doctor --installed` prints hook findings as `hint:` lines, including missing core hooks.
Neither changes Codex's trust decisions.

| State | Meaning | What to do |
| --- | --- | --- |
| Active | Installed, trusted, and turned on | Nothing |
| Needs review | Installed, but Codex has not trusted this exact definition (`untrusted` or `modified`) | Follow the review steps above |
| Turned off | Trusted but disabled in Codex | Turn the hooks back on in Codex's **Settings → Hooks**, or `/hooks` in the CLI |
| Missing | Not in `~/.codex/hooks.json` | Turn the package off and back on in `/agents` |
| Unknown | Codex could not be asked | Check that Codex is installed and has been opened at least once |

RoboRepo asks Codex directly (through `codex app-server`), so the warning reflects what Codex will
actually run rather than what the file contains.

The core hooks marked "always" below are not installed yet on a machine where a package already
wrote `~/.codex/hooks.json`. `doctor --installed` reports them as missing; the portal warning leaves
them out because reapplying a package does not install them.

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
