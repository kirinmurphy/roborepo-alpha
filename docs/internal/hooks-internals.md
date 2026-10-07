# Hooks Internals

Implementation detail for the hooks roborepo installs: script locations, output protocols, ordering,
and harness-protocol findings. User-facing summaries are in
[Claude Hooks](../user/reference/claude-hooks.md) and [Codex Hooks](../user/reference/codex-hooks.md).

## Claude Hooks

System hooks are configured in `globals/system/hooks/claude/`, wired through the generated
`generated/claude/settings.json` under `"hooks"`. Package-owned hooks (JDocMunch's index check,
telemetry's capture hooks, JCodeMunch's Grep/Glob and Bash blockers) are authored under their
owning package (e.g. `globals/packages/<package>/hooks-claude.json`) and composed into the live
Claude hook config only when that package is enabled.

Hooks are organized below in two parts: **Part 1** covers behaviors Claude shares
in intent with Codex (the same goal, achieved with Claude's own mechanism), and
**Part 2** covers hooks that exist only on Claude because they act on tools or
protocols Codex does not have.

> Hooks are authored per-harness, not generated from a shared source. The format
> and output protocols differ enough (Claude emits JSON-control output; Codex emits
> plain text) that the handful of shared behaviors are duplicated by hand rather than
> rendered.

---

### Part 1 — Common (shared intent with Codex)

These cover the same goals as Codex, realized through Claude's own machinery.

#### Caveman activation

Codex turns on caveman mode with a SessionStart hook. **On Claude this is not a
hook** — it comes from the `caveman` plugin (`enabledPlugins` in `settings.json`),
which installs its own SessionStart behavior. Same outcome (terse default output),
different mechanism.

#### jdocmunch index check — SessionStart

**Trigger:** every new session or resume.

Checks for the `docs/.jdm-indexed` marker in the current repo. If `docs/` exists
but the marker is absent, injects a reminder to run `roborepo index docs docs/`.
If the marker is present, confirms docs are indexed. The marker is written by
`roborepo index docs` after a successful run and is excluded from git via the
global gitignore. Package-owned: authored at
`globals/packages-archived/jdocmunch/hooks-claude.json` and composed into the live Claude
hook config only when `jdocmunch` is enabled.

This is the one hook duplicated near-identically on both harnesses — only the
output protocol differs (JSON `systemMessage` here, plain text on Codex).

#### Telemetry capture — SessionStart / PreToolUse / PostToolUse / UserPromptSubmit / Stop

When telemetry is enabled, these hook events call `roborepo telemetry capture`
and append JSON records into `~/.roborepo/telemetry`. Records are tagged with
repo and harness context (hashed, not raw conversation text) and, from the
transcript, cumulative + per-capture token usage, tool/MCP attribution, tool-result
sizes (for spike attribution — sizes only, never content), and session counts —
enough to analyze token spikes and what caused them over time. See the
[Telemetry reference](../user/reference/telemetry.md) for the record schema and the dashboard.
Package-owned: authored at `globals/packages/telemetry/hooks-claude.json` and
composed into the live Claude hook config only when telemetry is enabled —
disabling telemetry removes these hooks.

---

### Part 2 — Claude-specific

These act on tools or output protocols that exist only on Claude.

#### jcodemunch status — SessionStart

**Trigger:** every new session or resume.

Checks whether the code watcher (`roborepo index code --watch`) is running for the current
directory by looking for a pidfile at `/tmp/jcmwatch-<md5-of-pwd>.pid` and verifying
the pid is alive. Injects a system message telling the model either:

- index is current (watch is running) — no manual reindex needed
- watch is not running — suggests `roborepo index code` if the index may be stale

Also reminds the model to use jcodemunch tools (`resolve_repo`, `search_symbols`,
etc.) for code exploration instead of `Grep`/`Read`. (Codex gets a jcodemunch SessionStart nudge from the same package.) The `index code` and `index code --watch`
commands are package-owned; enable `jcodemunch` first if the CLI reports that no
owning package is enabled. This hook is authored at
`globals/packages-archived/jcodemunch/hooks-claude.json` and composed into the live
Claude hook config only when `jcodemunch` is enabled.

#### Block Grep/Glob — PreToolUse: Grep|Glob

**Trigger:** model attempts to call `Grep` or `Glob`.

Hard-blocks the call with `"continue": false`. The stop reason instructs the model
to retry using jcodemunch (`search_symbols`, `get_file_outline`, `find_references`,
`get_context_bundle`). Treated as a redirect, not an error — the model should
immediately retry via jcodemunch. These tools do not exist on Codex. Package-owned:
authored at `globals/packages-archived/jcodemunch/hooks-claude.json`, composed into the
live Claude hook config only when `jcodemunch` is enabled.

#### Block Bash source-exploration — PreToolUse: Bash

**Trigger:** model attempts a `Bash` command. Runs **first** in the Bash chain.

`block-source-exploration.mjs` closes the route-around left by the Grep/Glob tool
block: the agent can otherwise shell out (`grep src/...`, `cat file.ts`,
`find . -name '*.ts'`) to read source without touching jcodemunch. Package-owned:
the script lives at `globals/packages-archived/jcodemunch/hooks/block-source-exploration.mjs`
and is wired only when `jcodemunch` is enabled.

It **denies** a command only when **all** hold, and **allows** everything else:

- verb is `grep`/`rg`/`ag`/`cat`/`head`/`tail`/`find`
- there is an explicit file-path argument (no pipe anywhere in the command)
- the path is inside the repo
- the path has a source extension (`.ts`, `.py`, `.go`, …)
- the path is not under `node_modules`/`dist`/`build`/`.next`/`coverage`/`vendor`

This is **deliberately conservative ("allow when unsure")** because Bash
legitimately does things jcodemunch cannot — grep a log, cat a json/lockfile,
pipe `git log | grep`, inspect `/tmp`. Those must never be blocked. The cost is
that a determined agent can still leak (e.g. `grep` with no path argument); that
is the accepted trade for never breaking legitimate Bash work. The deny message
redirects to `search_text`, `search_symbols`, `get_file_outline`,
`find_references`, `get_context_bundle`. Ordering matters: it runs before
`minimize-bash-output.mjs` (which auto-allows bare `grep`), so its deny is final.

#### Minimize Bash output — PreToolUse: Bash

**Trigger:** model attempts to call `Bash`.

Runs after the source-exploration blocker, two more commands in sequence on the
Bash chain:

- `minimize-bash-output.mjs` — normalizes the command (strips a redundant leading
  `cd <cwd> &&`, auto-allows a short list of known-safe read-only / repo-maintenance
  commands, denies `--watch`/`--verbose`/`--debug` flags, and tail-pipes noisy
  `lint`/`typecheck`/`build` output) so results stay small and don't flood context.
- `capture-dense-bash.mjs` (package `capture-dense-bash`) — silent observer that logs multi-line
  (3+ line) Bash commands to `<stateRoot>/capture/claude/dense-bash.jsonl` for later pattern analysis. It never
  blocks or rewrites. The log is a single persistent file that all sessions append
  to and that survives reboots; each record carries its own `session_id`. Mine it to
  find recurring dense commands worth turning into scripts, CLI subcommands, or
  allowlist entries.

#### Write guard — PreToolUse: Write|Edit

**Trigger:** model attempts to `Write` or `Edit` a file under `~/.claude` or
`~/.codex`.

Runs `write-guard.mjs`, which injects context reminding the model that
most managed assets are symlinks into this repo (edit there, commit there), that
new files should be created in the repo and linked rather than written directly into
the home dir, and that root config files (`settings.json`, `config.toml`) are
mutable machine-local copies needing the merge/export workflow. `settings.local.json`
is exempt.

---

### Reference notes

#### Skill visibility

Claude documents skill invocation controls in `SKILL.md` frontmatter, including
`disable-model-invocation: true` for manual-only skills. It also has hook events
that are useful around skill workflows:

- `UserPromptExpansion` fires when a user-typed slash command expands, including
  direct skill or command invocation.
- `PreToolUse` can observe tool calls, including model-driven skill/tool paths
  where exposed by the harness.
- `MessageDisplay` can alter displayed assistant text, but does not change the
  transcript or what Claude sees.

The documented hook payloads are useful for observability and command guardrails,
but should not be treated as a portable source of truth for "which skills
auto-loaded" unless a specific skill-load event or field is available.

## Codex Hooks

System hooks are configured in `globals/system/hooks/codex/` and wired through the generated
`generated/codex/hooks.json`. Package-owned hooks (Caveman and JDocMunch's `SessionStart` hooks,
telemetry's capture hooks) are authored under their owning package
(`globals/packages/<package>/hooks-codex.json`) and composed into the live Codex hook config only
when that package is enabled.

Hooks are organized below in two parts: **Part 1** covers behaviors Codex shares
in intent with Claude (the same goal, achieved with Codex's own mechanism), and
**Part 2** covers what is specific to Codex — including the things Codex handles
*outside* of hooks.

> Hooks are authored per-harness, not generated from a shared source. The format
> and output protocols differ enough (Codex emits plain text with a `statusMessage`;
> Claude emits JSON-control output) that the handful of shared behaviors are
> duplicated by hand rather than rendered.

---

### Part 1 — Common (shared intent with Claude)

These cover the same goals as Claude, realized through Codex's own machinery.

#### Caveman activation — SessionStart (startup|resume)

**Trigger:** session start or resume matching `startup|resume`.

Prints caveman mode activation instructions to stdout: drop
articles/filler/pleasantries/hedging, use fragments, keep responses terse. Code,
commits, and security output stays normal. The user can say "stop caveman" or
"normal mode" to deactivate. (On Claude the same outcome comes from the `caveman`
plugin instead of a hook.) Package-owned: authored at
`globals/packages/caveman/hooks-codex.json` and composed into the live Codex hook
config only when `caveman` is enabled — disabling the package removes this hook.

#### jdocmunch index check — SessionStart (startup|resume)

**Trigger:** session start or resume matching `startup|resume`.

Checks for the `docs/.jdm-indexed` marker in the current repo. If `docs/` exists
but the marker is absent, prints a reminder to run `roborepo index docs docs/`.
If the marker is present, confirms docs are indexed. This is duplicated
near-identically on Claude — only the output protocol differs (plain text here,
JSON `systemMessage` on Claude). Package-owned: authored at
`globals/packages-archived/jdocmunch/hooks-codex.json` and composed into the live Codex
hook config only when `jdocmunch` is enabled.

#### Telemetry capture — SessionStart / PreToolUse / PostToolUse / UserPromptSubmit / Stop

When telemetry is enabled, these hook events call `roborepo telemetry capture`
and append JSON records into `~/.roborepo/telemetry`. Records are tagged with
repo and harness context (hashed, not raw conversation text) and, from the
transcript, cumulative + per-capture token usage, tool/MCP attribution, tool-result
sizes (for spike attribution — sizes only, never content), and session counts —
enough to analyze token spikes and what caused them over time. See the
[Telemetry reference](../user/reference/telemetry.md) for the record schema and the dashboard.
Package-owned: authored at `globals/packages/telemetry/hooks-codex.json` and
composed into the live Codex hook config only when telemetry is enabled —
disabling telemetry removes these hooks.

---

### Part 2 — Codex-specific

#### Shell-output minimization — PreToolUse (shell tools)

Codex **does** minimize shell output via a PreToolUse hook, parallel to Claude's
`minimize-bash-output.mjs`. `globals/system/hooks/codex/minimize-bash-output.mjs` acts on
Codex's shell tool (`exec_command` / `shell` / `local_shell`): it appends
`2>&1 | tail -n 120` to noisy build/lint/typecheck commands, forces
`tsc --pretty false`, and denies `--watch`/`--verbose`/`--debug` flags. Codex
PreToolUse hooks support the same `hookSpecificOutput { permissionDecision,
updatedInput }` protocol as Claude (verified against the Codex wire schema) and
receive the same `tool_name` / `tool_input` fields, so the rewrite/deny logic is
shared in intent with the Claude hook.

This was added after telemetry showed uncapped Codex shell output was the dominant
token cost (~22.8M tok of shell results vs ~49K on Claude, where this minimization
already ran).

#### jcodemunch enforcement still lives in rules

Unlike Claude, Codex does not block `Grep`/`Glob` or guard writes via tool hooks —
jcodemunch enforcement in Codex relies on rules in
`generated/codex/rules/default.rules` and the generated `generated/codex/AGENTS.md`.
See [jcodemunch.md](../user/reference/jcodemunch.md) for full details. (Porting the
source-exploration nudge to a Codex hook is a possible future parity step; the
shell-output minimization above is the first PreToolUse enforcement hook on Codex.)

#### Real per-command ask — PreToolUse (shell tools)

`globals/system/hooks/codex/permission-check.mjs` re-implements the manifest's command
matching at runtime and emits a genuine `permissionDecision: "ask"` for any shell
command that resolves to the `ask` bucket — closing the gap `renderCodexRules`
otherwise leaves (a `prefix_rule` can only be `forbidden`/`allow`; an ask-bucket
command gets no rule at all there). This was previously assumed impossible on
Codex; it is not. Confirmed directly against the shipped Codex 0.140 binary
(`strings` on the compiled CLI): the wire enum `PreToolUsePermissionDecisionWire`
— the one `hookSpecificOutput.permissionDecision` actually serializes to — has
three values, `allow`, `deny`, `ask`, not two. (A separate, older
`PreToolUseDecisionWire` enum with only `approve`/`block` also exists in the
binary; it is not the one hooks use.) There is also a distinct `PermissionRequest`
hook event in the wire schema, suggesting Codex may route an `ask` decision
through its own approval-prompt UI rather than a bare stdin block — worth
watching for behavior changes across Codex versions, since this was reverse-
engineered from the binary, not from published documentation.

The hook loads `manifests/inventory/agent-permissions.json` plus the personal
override file (`~/.roborepo/command-overrides.json`) directly — the same two
sources `permissions-render.mjs` renders from — so a command's classification is
identical on both harnesses without a second config to maintain. Matching is
literal-prefix on whitespace-tokenized command text, mirroring Claude's
`Bash(a b:*)` semantics. An unmatched command emits nothing and falls through to
`approval_policy` and any other `PreToolUse` hook unchanged — this hook only
adds a decision for the subset it can confidently classify, never removes one.

`generated/codex/rules/default.rules`' deny/allow entries stay in place alongside
this hook, deliberately: the rules are a sandbox-level guarantee that survives
even if a hook fails to load or errors, while the hook adds the ask tier
`prefix_rule` cannot express. Neither replaces the other.

#### Available events

Codex documents support for `SessionStart`, `PreToolUse`, `PermissionRequest`,
`PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStart`,
`SubagentStop`, and `Stop` events. Matchers are not honored by every event;
`UserPromptSubmit` and `Stop` ignore matcher values. Current repo config uses
`SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `Stop` when
telemetry is enabled, plus the existing `SessionStart` caveman/jdocmunch nudges.

---

### Reference notes

#### Skill visibility

Codex hook payloads include useful session, prompt, tool, and stop data, but the
documented event payloads do not expose a stable list of skills implicitly loaded
for a turn. Use hooks for prompt/tool/stop guardrails, not as the source of truth
for "which skills auto-loaded" until Codex exposes explicit skill-load metadata.

**Skill-reference observation is a narrower claim, and it is built.** It reports
which reference *files* a session read — not which skills auto-loaded — by
watching `PostToolUse` for reads under a skill root. The Codex adapter lives at
`globals/packages/skill-visibility/hooks/codex/skill-reference-observer.mjs` and
is wired through that package's `hooks-codex.json`.

It recognizes two payload shapes, both found by live smoke testing:

| Shape | Recognized when | Example |
| --- | --- | --- |
| Direct file read | `tool_input.file_path` names a file under a skill root | `{"tool_input":{"file_path":"~/.codex/skills/<skill>/references/<ref>.md"}}` |
| Shell read | `tool_name` is `exec_command`/`shell`/`local_shell` and `tool_input.cmd`/`.command` is a **string** matching `sed -n <range> <file>` | `sed -n 1,40p ~/.codex/skills/<skill>/references/<ref>.md` |

Skill roots searched: `~/.codex/skills` and `<state root>/skills`.

Only `sed -n` is treated as a reference read. `cat`, `head`, and friends are
deliberately not matched — the narrow allowlist is what keeps an arbitrary shell
command containing a skill path from being counted as a read. A matched read
emits one `additionalContext` line:

```text
[skill-visibility] observed reference read: <skill>/<reference>
```

**Live emission waits on Codex.** As of Codex 0.140.0, neither the exec nor the
interactive TUI runtime dispatches configured `PostToolUse` hooks after shell
tool calls, even though the event and its output schema are documented. The
adapter emits correctly when a payload is fed to it directly, so nothing on the
RoboRepo side is outstanding; the gap is upstream dispatch. Claude's equivalent
adapter runs live today, so a session's reported reference tally reflects Claude
reads and will silently under-report Codex ones until Codex delivers the event.

#### Session permissions

Agent permission policy is authored in `manifests/inventory/agent-permissions.json` as a
flat list of **behaviors** — named (`write-files`, `delete-files`, `go-online`,
`commit-code`, `push-pull-prs`) or arbitrary (any other command) — each independently
`deny`/`ask`/`allow`. There is no profile-bundle concept anymore (a prior design with
`readonly`/`interactive`/`workspace`/`networked` presets was replaced with this flat
model). Personal overrides live in `~/.roborepo/command-overrides.json`, layered on top
of the manifest at render time so `roborepo update` never wipes a personal choice.
Rendered/checked with:

```sh
roborepo permissions
roborepo permissions --check
```

Edit behaviors and arbitrary commands via the web portal (`roborepo web`) — the only
place per-command overrides are editable; `roborepo package manage`'s Permissions step offers
the 5 named behaviors as a direct toggle, `roborepo config status` is read-only.

The renderer writes the generated permission block in `generated/codex/config.toml`
(`approval_policy`, `sandbox_mode`, `network_access` — derived from the `write-files`
and `go-online` behaviors, and from whether anything is `ask`), the generated shell
prefix rules in `generated/codex/rules/default.rules`, and Claude
`permissions.allow` / `permissions.deny` / `permissions.ask` in `generated/claude/settings.json`.

A `deny`/`allow` behavior or arbitrary command maps straight to Codex
`prefix_rule(... decision="forbidden"|"allow")` and Claude's deny/allow arrays. An
`ask`-bucket entry gets no `prefix_rule` (that mechanism is binary) — instead
`globals/system/hooks/codex/permission-check.mjs` (below) supplies a real per-command
`ask` decision at runtime, and `approval_policy` is set to `on-request` as a
fallback for anything the hook doesn't classify. On Claude the same entry lands
directly in `permissions.ask`.

`~/.codex/rules` is installed as a **managed copy** (`manifests/platform/manifest.tsv`,
`kind = managed_copy`), NOT a symlink — a live file that starts as a copy of
`generated/codex/rules/` but can diverge from it (e.g. the Codex CLI itself appends
"always allow this command" rules here when a user approves a prompt in a live session).
Once diverged, `roborepo update` does not silently overwrite it — reinstall only
overwrites on an explicit "overwrite" collision choice, so a diverged live file persists
indefinitely with no automated drift check today. Treat the live file as
possibly-stale relative to repo intent; `roborepo doctor` only checks repo-source
render drift (manifest vs. `generated/codex/rules/default.rules`), not live-machine drift.

`~/.codex/config.toml` is similar: it is an active local root config file, not a
symlink, and can diverge the same way. Existing machines need the root config merge/export
workflow before new baseline session defaults appear in active Codex sessions.
