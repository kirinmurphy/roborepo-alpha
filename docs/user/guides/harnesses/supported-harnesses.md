# Supported Harnesses

Read this to understand what a *harness* is in RoboRepo, which ones are supported today, and what
each one actually receives when RoboRepo manages it.

If you are adding support for a new harness, read
[Harness Provider Interface](../../../internal/harness-provider-interface.md) instead — this guide covers the product
behavior, not the extension mechanism.

## What a Harness Is

A harness is a coding-agent CLI that reads its configuration from a directory in your home folder —
Claude Code reading `~/.claude`, Codex reading `~/.codex`, Gemini CLI reading `~/.gemini`.

Each of these tools stores broadly the same kinds of things: rules the agent should follow, skills
it can load, slash commands you can invoke, permission policy for what it may do without asking,
and MCP server registrations. Each one stores them in a *different file, format, and shape*.

RoboRepo keeps one version-controlled source of truth for that configuration and renders it into
whatever native form each harness expects. You edit rules once; Claude gets `~/.claude/CLAUDE.md`,
Codex gets `~/.codex/AGENTS.md`, Gemini gets `~/.gemini/GEMINI.md`. The Agents page in the portal
shows each harness's native files side by side:

![The Agents page file grid: startup token cost, rules, config, and hooks files for Claude Code and Codex](../../../images/harness-files.png)

The word "harness" is RoboRepo's term for the tool. "Provider" is the code inside RoboRepo that
knows how to talk to one — see the interface guide for that distinction.

## Currently Supported Harnesses

| Harness | id | Config home | Root config format |
| --- | --- | --- | --- |
| Claude Code | `claude` | `~/.claude` | JSON (`settings.json`) |
| Codex | `codex` | `~/.codex` | TOML (`config.toml`) |
| Gemini CLI | `gemini` | `~/.gemini` | JSON (`settings.json`) |

You do not need all three. RoboRepo manages whichever ones it finds and ignores the rest.

## What Each Harness Receives

Support is not all-or-nothing. Each harness declares which capabilities it can accept, and RoboRepo
delivers exactly those. A blank cell means the harness has no native equivalent, not that support is
missing or broken.

| Capability | What it delivers | Claude | Codex | Gemini |
| --- | --- | :---: | :---: | :---: |
| `root-config` | The harness's main settings file | ✅ | ✅ | ✅ |
| `rules` | Generated global rules the agent reads every session | ✅ | ✅ | ✅ |
| `permissions` | Allow/ask/deny policy for tools and commands | ✅ | ✅ | ✅ |
| `skills` | Shared skill folders, linked into the harness | ✅ | ✅ | ✅ |
| `slash-commands` | `/command` wrappers | ✅ | ✅ | ✅ |
| `hooks` | Scripts that run on agent lifecycle events | ✅ | ✅ | ✅ |
| `mcp` | MCP server registrations | ✅ | ✅ | ✅ |
| `package-config` | Package-owned config fragments (e.g. the usage status line) | ✅ | ✅ | — |
| `telemetry-capture` | Session cost/tool-call capture | ✅ | ✅ | — |
| `telemetry-rate-limits` | Rate-limit windows parsed from session data | — | ✅ | — |
| `telemetry-transcripts` | Reading past session transcripts | ✅ | ✅ | — |
| `session-launch` | Starting a session from RoboRepo | ✅ | ✅ | — |

Gemini CLI receives every configuration capability but no telemetry, because it does not expose the
session data telemetry needs. Only Codex reports rate-limit windows.

This matters when reading `roborepo doctor` output: a harness that lacks a capability produces no
checks for it, and *no checks* looks the same as *all checks passing*. Compare a harness against the
capability table above, not against another harness's check count.

## How a Harness Gets Connected

RoboRepo discovers harnesses; you do not register them by hand.

Discovery is narrow. For each known provider, RoboRepo checks only the locations that
provider's own manifest declares — its executable name on `PATH`, its home directory, its config
file. It never scans your filesystem broadly. The evidence it finds becomes a confidence level:

| Evidence found | Confidence |
| --- | --- |
| Executable on `PATH` (validated) **and** a home dir or config file | `confirmed` |
| Executable on `PATH` (validated) only | `probable` |
| Home directory or config file only | `possible` |
| Nothing | `absent` |

Each provider declares the minimum confidence it will accept. Meeting that bar makes the harness
eligible; RoboRepo then manages it on the next `roborepo update`.

Every shipped provider requires `confirmed` — a validated executable on `PATH` **plus** a home dir
or config file. A config directory left behind by another tool (a `~/.claude` with no `claude`
binary, say) is not enough to make RoboRepo believe the harness is installed; it shows up as
`possible` instead. This matters because a leftover settings file would otherwise flip the Agents
page to "installed" with no CLI present.

As a result:

- **Installing a new agent CLI is enough.** Install Gemini CLI, run `roborepo update`, and it
  starts receiving rules, skills, and commands. No config edit.
- **Discovery cannot invent a harness.** Only providers RoboRepo ships can be discovered. A provider
  is executable code, so configuration cannot point RoboRepo at an arbitrary module and have it run.

## Commands

```bash
roborepo harness list              # every known harness and whether it is enabled
roborepo harness detected          # discovery results, machine-readable
roborepo harness inspect <id>      # one harness's manifest, capabilities, and state
roborepo harness enable <id>       # manage this harness
roborepo harness disable <id>      # stop managing it, without uninstalling roborepo
roborepo harness refresh           # re-run discovery
roborepo harness withdraw <id>     # strip builtin-managed artifacts from that harness
```

`disable` and `withdraw` differ: `disable` stops future delivery and leaves existing files alone;
`withdraw` actively removes what RoboRepo put there. Run `withdraw --dry-run` first — it prints
exactly what it would remove and touches nothing.

An explicit `disable` survives `refresh`. Re-running discovery will not silently re-enable a harness
you turned off.

When using the portal, open **Settings → Agent Harnesses** and select **Check for harnesses** after
installing a supported harness. This performs the same discovery without requiring a terminal
command; the CLI commands remain available for scripted workflows.

## Platform Support

macOS and Linux are the primary platforms and share the same install path. Windows has its own
PowerShell installer covering all three harnesses — see [Windows](../first-time-setup.md#windows).

## Where to Go Next

- [First-Time Setup](../first-time-setup.md) — install RoboRepo and put it on your `PATH`
- [Daily Use](../setup-and-daily-use.md) — day-to-day workflows
- [Harness Provider Interface](../../../internal/harness-provider-interface.md) — add support for a new harness
