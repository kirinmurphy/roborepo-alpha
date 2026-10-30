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

On a CLI-only installation, Codex prompts for pending hook approval when you start it. Review
there, or reopen `/hooks` later. RoboRepo does not repeat that prompt with a portal approval
banner, one-time offer, or post-change terminal instructions. Readiness still reports pending
hooks in package status, the API, and explicit `roborepo doctor --installed` diagnostics.

When the desktop app is detected, RoboRepo provides approval guidance after package changes,
core hook installation, or updates:

- Home, Settings, and Tokens update their normal notice. Agents shows one inline card per pending
  hook set; **Later** closes it. A page with a normal notice shows that notice alone.
- Follow the ordered desktop steps. **Set up via CLI** provides the terminal alternative in a
  tooltip. RoboRepo commands also print the review next step when hooks await approval.

RoboRepo detects available interfaces, not which interface you are actively using. When both are
available, desktop guidance remains visible. The desktop app's bundled CLI supplies its terminal
fallback. Where a launch action is offered, it opens only after a click and only on macOS;
elsewhere, copy the command and run it in a terminal.

In Codex's review:

1. Trust only the RoboRepo hooks you recognize. Leave unrelated hooks alone instead of choosing
   **Trust all**.
2. For desktop guidance, return to the portal to see only what remains pending, or the resolved
   message. CLI-only approval does not add a portal completion banner.
3. Start a new Codex session. Running sessions do not pick up newly trusted hooks.

Desktop review is available under **Settings → Hooks**. Trust is stored in `~/.codex/config.toml`,
which the desktop app and CLI share; trusting in either applies to both.

Codex keys trust by a hook's position in `~/.codex/hooks.json`. RoboRepo adds a package's Codex
hooks, and its own core hooks, after the existing ones, so a change leaves the hooks you already
trusted where they were. Removing hooks (disabling a package, or removing the `hooks` bundle) moves
the hooks after them at the same event, and Codex asks you to review those again.

## Checking Hook Readiness

Settings, Tokens, and Home show a notice for RoboRepo hooks that need attention, one per kind of
problem, each with its own remedy. CLI-only pending approval is handled by Codex startup; missing,
disabled, and unknown hooks still produce portal notices. `roborepo doctor --installed` prints findings as
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

If core hooks are missing, click **Install hooks** in the notice. The local server runs the same
bundle installer as `roborepo bundle apply hooks`, for all available harnesses, then refreshes
status. Installation does not launch Codex or grant trust.

With desktop detected, the four setup steps remain visible while approval is pending. The completed
installation step has a green check and strikethrough. **Why?** explains the pending hooks;
**View Hook Details** names their events and purposes. **Set up via CLI** provides the terminal
alternative. Package hooks use the same checklist independently of the core Hooks bundle, and
mixed core/package sets share one checklist with pending counts and owners.

On CLI-only installs, the missing-hook notice includes installation and native CLI review steps
without a duplicate **Set up via CLI** tooltip. Once installation leaves only pending approval,
the notice disappears: Codex handles that approval at startup. Other readiness problems remain
visible. **Check again** is available when there is no install or launch action, including when
Codex cannot report its status. Returning to the page refreshes status after external changes.

The native ChatGPT desktop review uses each command hook’s `statusMessage` as its label.
Every shipped RoboRepo Codex hook has a native name, including package hooks. **Why?** uses
the name and contextual explanation recorded beside that hook’s definition. The core definitions
provide these four labels:

| Event | Native review label |
| --- | --- |
| `SessionStart` | RoboRepo: unmanaged skills check |
| `PreToolUse` | RoboRepo: protected branch push |
| `PreToolUse` | RoboRepo: command permissions |
| `PreToolUse` | RoboRepo: concise command output |

If an existing desktop review dialog still shows numbered titles after an update, open
**Settings → Hooks**, select **Reload hooks**, and reopen the review dialog.

These are four core hooks under two event types. Packages such as Telemetry install separate
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
| PreToolUse (shell) | Protected-branch push | Allows a `git push` it verified lands on a feature branch; denies protected branches and any force push, backed by a git `pre-push` hook. Denies every push it cannot verify (`--no-verify`, `--all`, a `$VARIABLE`, an unrecorded remote default branch), where Claude would ask. See [Protected Branches](claude-hooks.md#protected-branches) | core (`hooks` bundle) |
| PreToolUse (shell) | Command permissions | Applies your permission settings' `allow`, `ask`, and `deny` buckets to shell commands by their leading words. An `allow` covers a single command only: a command with `;`, `&&`, `\|`, a redirection, or `$(...)` keeps Codex's own approval (see below) | core (`hooks` bundle) |
| PreToolUse (shell) | Output minimizer | Appends `2>&1 \| tail -n 120` to noisy build, lint, and typecheck commands, forces `tsc --pretty false`, and denies `--watch`, `--verbose`, and `--debug`. Leaves chained, piped, or redirected commands unchanged, since a rewrite also approves the command | core (`hooks` bundle) |
| PostToolUse | Skill reference observer | Tells Codex which skill reference files it just read, for the skills-loaded line. Codex does not yet deliver this event after shell reads, so Codex reads are under-counted | `skill-visibility` |
| SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop | Telemetry capture | Records token and tool usage locally | `telemetry`, once token tracking is enabled in the portal or CLI |

Codex has no `Grep`/`Glob` block or write guard; jcodemunch preference on Codex comes from the
generated rules in `~/.codex/AGENTS.md` and the command rules in `~/.codex/rules/`.

## Permissions On Codex

Your permission settings (see [Config Control Panel](config-control-panel.md#permissions)) reach
Codex through command rules and hooks:

| Bucket | How Codex enforces it |
| --- | --- |
| `allow` / `deny` | A command rule in `~/.codex/rules/default.rules`. These hold even if a hook fails to load |
| `ask` | The command permissions hook above, since command rules can only allow or forbid |

A command no rule or hook classifies falls through to Codex's `approval_policy`.

Codex has been seen running a command whose hook result was `ask` without prompting, so treat `ask`
on Codex as advisory. The protected-branch push hook does not rely on it: under Codex it denies
instead.

`~/.codex/rules/` and `~/.codex/config.toml` are live files that Codex itself can change — for
example, approving "always allow this command" in a session appends a rule. Once they differ from
RoboRepo's version, `roborepo update` leaves them alone unless you choose `--on-conflict overwrite`.
`roborepo config root inspect` reports when `config.toml` has drifted; nothing checks `rules/` for
drift.

See [Hooks Internals](../../internal/hooks-internals.md) for script locations and protocol detail.

### Native credential boundary

Credential protection uses the selected native filesystem profile in `config.toml`. When
`read-secrets` resolves to `deny`, it denies reads and writes to known credential paths in
both writable and read-only profiles. `.env.example` and `.env.sample` remain readable.
This enforcement does not depend on hook trust or command classification. The command hook still
classifies commands; it does not scan shell text for secrets.

A separately escalated process needs its own boundary assessment. Existing sessions and higher
configuration layers may select different permissions. Start a fresh session and verify its
selected profile before relying on the boundary. The measured coverage is macOS Codex CLI
`0.163.0-alpha.11.2` sandboxed commands and descendants; product file tools, desktop sessions,
browser, MCP, Linux, Windows, and unrestricted execution remain unverified. See
[credential verification](../../internal/testing.md#codex-credential-verification) for controls.
