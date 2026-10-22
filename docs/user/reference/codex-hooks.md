# Codex Hooks

Hooks are commands Codex runs at points in a session — when it starts, before a tool call, after a
tool call. RoboRepo installs a few core hooks with the `hooks` bundle, and packages add more when you
enable them.
Turn a package's hooks off by disabling the package in `/agents` or with
`roborepo package disable <id>`.

## Trusting RoboRepo's Hooks

Codex runs a non-managed hook only after you review and trust its exact definition. Enabling a
package installs its hooks but does not grant that trust, and RoboRepo never grants it for you or
records a trust decision.

After you change something that rewrites Codex hooks (enabling or disabling a package, a bulk
change on `/agents`, turning on token tracking, applying the `hooks` bundle, or an update),
RoboRepo asks Codex whether any RoboRepo hook now awaits review. If one does:

- **In the portal**, Home, Settings, and Tokens update their normal notice. On Agents, an inline
  card appears once for each set of pending hooks and **Later** closes it. A page with a normal
  notice shows that notice alone. With a detected desktop app, follow the ordered steps and use
  **Set up via CLI** for the terminal instructions in a tooltip. With only a CLI detected, package
  review also offers **Open Codex hook review** and **Copy command** directly.
- **In the terminal**, the command prints the same list and the command that opens Codex's review.
  It never opens anything itself.

RoboRepo detects available interfaces, not which interface you are actively using. When both are
available, desktop instructions come first. The desktop app's bundled CLI supplies the fallback.

**Open Codex hook review** (or **Open Codex CLI instead**) opens a terminal window running Codex's own CLI, which shows **Hooks
need review** when it starts. It prefers the CLI bundled with the Codex desktop app, then a `codex`
on your `PATH`. The window opens only when you click, and only on macOS for now; elsewhere, use
**Copy command** and run it in a terminal.

In Codex's review:

1. Trust only the RoboRepo hooks the portal or terminal listed. If Codex also lists hooks you do
   not recognize, leave them alone rather than choosing **Trust all**.
2. Come back to the portal. It checks again when you return and shows
   only what is still pending, or that review is done.
3. Start a new Codex session. Sessions already running do not pick up newly trusted hooks.

The Codex app has the same review under **Settings → Hooks**; there is no link that opens that
screen directly. In the CLI, `/hooks` reopens it later. Trust is stored in `~/.codex/config.toml`,
which the desktop app and the CLI both read, so trusting in either applies to both.

Codex keys trust by a hook's position in `~/.codex/hooks.json`. RoboRepo adds a package's Codex
hooks, and its own core hooks, after the existing ones, so a change leaves the hooks you already
trusted where they were. Removing hooks (disabling a package, or removing the `hooks` bundle) moves
the hooks after them at the same event, and Codex asks you to review those again.

## Checking Hook Readiness

Settings, Tokens, and Home show a notice for RoboRepo hooks that need attention, one per kind of
problem, each with its own remedy. `roborepo doctor --installed` prints the same findings as
`hint:` lines. Neither changes Codex's trust decisions.

| State | Meaning | What to do |
| --- | --- | --- |
| Active | Installed, trusted, and turned on | Nothing |
| Needs review | Installed, but Codex has not trusted this exact definition (`untrusted` or `modified`) | Follow the review steps above |
| Turned off | Trusted but disabled in Codex | Turn the hooks back on in Codex's **Settings → Hooks**, or `/hooks` in the CLI |
| Missing | These hooks are absent from `~/.codex/hooks.json`; install them before reviewing them | A package's hooks: turn the package off and back on in `/agents`. Core hooks: **Install hooks**, or `roborepo bundle apply hooks` |
| Unknown | Codex could not be asked | Check that Codex is installed and has been opened at least once |

RoboRepo asks Codex directly (through `codex app-server`), so the notice reflects what Codex will
actually run rather than what the file contains. Hooks Codex lists that RoboRepo did not install
never appear in the notice or the offer.

Core hooks come with the optional `hooks` bundle, chosen during onboarding or with
`roborepo bundle apply hooks`. They install beside package hooks that are already there, and
readiness expects them only once you have chosen that bundle.

If core hooks are missing, click **Install hooks** in the notice. The local portal server
runs the same bundle installer as the terminal command, for all available harnesses, then refreshes
the status. If approval is needed, follow the four setup steps: desktop instructions come first
when the app is detected; CLI-only installations show CLI instructions. **Set up via CLI**
provides the CLI steps in either case.
Installation does not open Codex automatically or grant trust. If installation fails, the notice
keeps **Set up via CLI** available. This inline help link starts with the same Install button, then explains how to open Codex CLI and approve the hooks. **Why?** beside the notice heading explains each installed hook. Both links show tooltips on hover or keyboard focus. On Settings, the notice sits below the token
tracking heading and above the tracking toggle.

The notice shows **Install hooks** while core hooks are missing, then retains the setup checklist
for native approval.
While core hooks await approval, the four setup steps remain visible with a green check and
strikethrough on the completed installation step. **Set up via CLI** remains a tooltip with the
same completed first step, replacing the collapsible CLI alternative for this state.
A muted reminder beneath step 2 says to leave
unrecognized hooks alone. Installation refreshes status automatically,
and returning to the page picks up installation or approval done elsewhere. **Check again** appears
when there is no install or launch action, including when Codex could not report its status.

Package hooks use the same four-step checklist, with the installation of hooks awaiting review
already checked and crossed out. Other missing hooks retain their separate installation remedy. The approval step combines the package name, pending count, and event names in one concise
line. Already-active hooks are omitted. **Why?** names each pending hook and explains its purpose and package ownership. **Set up via
CLI** provides ordered terminal instructions in a tooltip. Package approval does not require the
core Hooks bundle. If core and package hooks await approval together, one checklist lists both.

The native ChatGPT desktop review uses each command hook’s `statusMessage` as its label.
Every shipped RoboRepo Codex hook has a native name, including package hooks. **Why?** uses
the name and contextual explanation recorded beside that hook’s definition. The core definitions
provide these three labels:

| Event | Native review label |
| --- | --- |
| `SessionStart` | RoboRepo: unmanaged skills check |
| `PreToolUse` | RoboRepo: command permissions |
| `PreToolUse` | RoboRepo: concise command output |

If an existing desktop review dialog still shows numbered titles after an update, open
**Settings → Hooks**, select **Reload hooks**, and reopen the review dialog.

These are three core hooks under two event types. Packages such as Telemetry install separate
hooks with their own names and contextual help. Adding or changing a label changes the definition
Codex approves, so it can require review again. Reapplying the Hooks bundle updates labels in
place while preserving commands, handler positions, and unrelated hooks.

## What Runs

| Event | Hook | What it does | Installed by |
| --- | --- | --- | --- |
| SessionStart | Unmanaged skills notice | Counts skills in `~/.claude/skills` and `~/.codex/skills` that RoboRepo does not manage and suggests `roborepo skill adopt <name>` | core (`hooks` bundle) |
| SessionStart | Caveman mode | Turns on terse output; say "stop caveman" or "normal mode" to turn it off | `caveman` |
| SessionStart | jcodemunch nudge | Reminds Codex to explore code with jcodemunch tools | `jcodemunch` |
| SessionStart | jdocmunch index check | If `docs/` exists but is not indexed, reminds Codex to run `roborepo index docs docs/` | `jdocmunch` |
| PreToolUse (shell) | Per-command ask | Prompts before shell commands your permission settings put in the `ask` bucket (see below) | core (`hooks` bundle) |
| PreToolUse (shell) | Output minimizer | Appends `2>&1 \| tail -n 120` to noisy build, lint, and typecheck commands, forces `tsc --pretty false`, and denies `--watch`, `--verbose`, and `--debug` | core (`hooks` bundle) |
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
