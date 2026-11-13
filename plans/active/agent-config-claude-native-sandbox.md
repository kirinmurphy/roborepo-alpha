---
id: 9njvfh5z
next_action: Run the two sandbox checks (excluded commands honored in the desktop app and CLI; git commit from a linked worktree), record results in the Decision Log, then add the shared behaviors.
blocked_by: []
depends_on: []
related: ["46qth5z8", "4zyo2woj", "8bjltk2n", "permva27", "permissions-ui-revamp", "ia1q1z9", "harness-capability-derived-resource-targeting", "0jped168", "plan-session-launching-milestone-1"]
reviewed_commit: cedc1ebe403e2fd6cdb19beb2a0a97c8c17300d8
worktree: agent-config-claude-native-sandbox
---

# Cut Claude permission prompts by running shell commands in the native sandbox

## Summary

Long Claude sessions stall on permission prompts for shell commands that only touch the repository
and temp folders. Claude Code has a native sandbox that confines each shell command at the OS level
and lets confined commands run without a prompt. RoboRepo does not turn it on.

This plan makes the Claude provider render that sandbox from the shared permission source, the same
way the Codex provider already renders its sandbox profile. A hand-written trial in one checkout
showed the prompt-free behavior and exposed gaps the generated version must close.

## Context

### Terms

| Term | Meaning |
| --- | --- |
| Shared permission source | `manifests/inventory/agent-permissions.json`: harness-neutral behaviors such as `write-scope`, `read-secrets`, and `go-online` |
| Provider | The per-harness code under `scripts/harnesses/<id>/` and `globals/harnesses/<id>/` that turns shared behaviors into native config |
| Native sandbox | Claude Code's `sandbox` settings block. On macOS it wraps each shell command in Seatbelt; file writes and network access outside the configured bounds fail in the kernel |
| Excluded command | A command pattern in `sandbox.excludedCommands` that is meant to run outside the sandbox, under the ordinary allow, ask, and deny rules |
| Public CA bundle | A file of public certificate authorities that TLS clients read to verify servers, such as `/private/etc/ssl/cert.pem` |
| Plans store worktree | The reserved `repo-plans` worktree outside the checkout, which `roborepo plans` commands lock and commit to |

### Why prompts happen today

Claude allow rules match a command prefix. Agent commands rarely start with one.

| Evidence | Reading |
| --- | --- |
| The generated user settings already allow `Write` and `Edit` under `/tmp`, `/private/tmp`, and `/private/var/folders` | Temp writes through file tools do not prompt; temp writes through the shell do |
| In the 40 most recent session transcripts for this repository (November 12, 2026), about 500 shell command lines began with `cd <path> &&` | A leading `cd` defeats every prefix rule |
| The same transcripts hold hundreds of inline scripts, loops, and env-prefixed commands | No prefix rule can describe them |
| The untracked `.claude/settings.local.json` in the main checkout holds more than 30 one-off approvals, several naming scratch folders of ended sessions | Approving exact commands does not generalize |

### How the two harnesses differ today

```mermaid
flowchart TD
  M["Shared permission source"] -->|"read by"| CP["Claude provider"]
  M -->|"read by"| XP["Codex provider"]
  CP -->|"renders"| CR["Permission rules and hooks"]
  XP -->|"renders"| XS["Permission profile with built-in sandbox"]
  XS -->|"enforced by"| SB["macOS Seatbelt"]
```

Codex confines every command and treats approval as an escalation. Claude checks rules first, and
its sandbox is optional. Current code reflects that:

| Location | Current statement |
| --- | --- |
| `claudePermissions` in `scripts/harnesses/permissions-render.mjs` | Skips `network` behaviors: "Codex-only concept; no Claude equivalent to render" |
| Comment above the Codex network rendering in the same file | "Claude has no sandbox network gate at all" |
| `renderClaudeSettings` in the same file | Writes only the `permissions` key and preserves every other key except `model` |
| `renderClaudeRootConfig` in `scripts/harnesses/claude/index.mjs` | Calls `renderClaudeSettings`, then merges core hooks; this is the Claude provider's `permissions.render` |
| `go-online` in the shared permission source | `codexOnly: true`, default `deny`, described as "Claude does not sandbox network egress" |
| Permission rows in `scripts/cli/config.mjs` | Pass `codexOnly` through with the comment that `go-online` has no Claude equivalent |
| "Provider-owned sandbox additions" in `docs/internal/harness-provider-interface.md` | Names Codex as the only implementer of `permissions.workspaceRoots` and `permissions.writablePaths` |

### What the trial showed

The trial added a `sandbox` block to the untracked `.claude/settings.local.json` of the main
checkout, on Claude Code 2.1.309 and macOS. It took effect in the running session without a restart.
The block, with the credential `denyRead` entries omitted:

```json
{
  "enabled": true,
  "autoAllowBashIfSandboxed": true,
  "filesystem": {
    "allowWrite": ["<claude-temp-folder>", "~/.npm"],
    "allowRead": [
      "/private/etc/ssl/cert.pem",
      "/opt/homebrew/etc/ca-certificates/cert.pem",
      "/opt/homebrew/etc/openssl@4/cert.pem"
    ]
  },
  "network": {
    "allowedDomains": ["registry.npmjs.org", "github.com", "*.githubusercontent.com"],
    "allowLocalBinding": false
  },
  "excludedCommands": ["docker *", "gh *", "git push *", "git pull *", "git fetch *", "roborepo *", "./bin/roborepo *"]
}
```

| Check | Result |
| --- | --- |
| Compound temp-folder command (`mkdir && redirect && cat`) | Succeeded |
| Write inside the repository | Succeeded |
| Write to the home folder | Refused: "operation not permitted" |
| List `~/.ssh` from the shell | Refused |
| `curl` and `npm ping` to the npm registry | Failed on certificates until three public CA bundles were exempted, then succeeded |
| `curl` to a host missing from `allowedDomains` | Succeeded; in manual permission mode an unlisted host prompts and is not refused |
| `git ls-remote` over SSH | Failed; Claude's documentation says SSH cannot pass the sandbox proxy on macOS |
| Headless `claude -p` started from a sandboxed command | Reported "Not logged in"; cause not confirmed |
| `roborepo plans show` from a desktop-app session, with `roborepo *` excluded | Ran inside the sandbox anyway: it reported "The plans worktree could not be locked" and returned unsynchronized output. The same command with the sandbox bypassed synchronized normally |

Whether the session prompted less was not measured: the agent cannot observe prompts.

Four findings shape the design:

- **Claude merges permission rules into the sandbox.** `Edit` allow rules became writable paths, and
  `Read` deny rules became unreadable paths. The `write-scope` and `read-secrets` behaviors
  therefore reach the sandbox with no new rendering.
- **The `//**/*.pem` credential pattern hides public CA bundles.** It blocked
  `/private/etc/ssl/cert.pem`, `/opt/homebrew/etc/ca-certificates/cert.pem`, and the
  `/opt/homebrew/etc/openssl@4/cert.pem` link to it. The generated Codex profile carries the same
  pattern. Its network is off, so the effect there is untested.
- **Excluded commands were not honored in the desktop app.** Why is unconfirmed: the desktop app may
  apply its own sandbox configuration, or the exclusion may need a different pattern. Until this is
  settled, any command on the excluded list must be assumed to run sandboxed, and `roborepo plans`
  commands then fail to write the plans store worktree.
- **Local settings do not reach worktrees.** The trial file is untracked, so a session in a linked
  worktree runs without the sandbox.

### Related plans

| Plan | Status | Relationship |
| --- | --- | --- |
| Keep local agent work within useful boundaries: Codex — Part 2 (`4zyo2woj`) | Completed; commit `60d2ba76` is in `main` | Landed dependency. Built `scripts/harnesses/codex/credential-permissions.mjs`, the pattern this plan's projection module follows |
| Repo-Scoped Write Permissions (`ia1q1z9`) | Completed; `globals/harnesses/claude/hooks/repo-write-scope.mjs` is present | Landed dependency. Its hook bounds `Write` and `Edit` to the checkout; the sandbox bounds shell commands. The two do not overlap |
| Keep local agent work within useful boundaries: Claude (`46qth5z8`) | Backlog | Neighbor. Owns worktree entry and moving Claude hook sources; no shared files with this plan |
| Keep local agent work within useful boundaries: Codex — Part 3 (`8bjltk2n`) | Backlog | Neighbor. Owns isolated app and browser test runs |
| Audit Global Agent Permissions Management (`permva27`) | Backlog | Related, not a prerequisite. This plan renders a native control, which fits either audit outcome |
| Permissions UI Revamp (`permissions-ui-revamp`) | Backlog, depends on `permva27` | Neighbor. Will redesign the rows this plan adds to `scripts/cli/config.mjs`; this plan adds rows in the current shape only |
| Capability-Derived Resource Targeting (`harness-capability-derived-resource-targeting`) | Backlog | No overlap found |
| Agent behavior evals (`0jped168`) | Backlog | Affected. Its runner starts headless `claude -p`, which the trial saw fail with "Not logged in" when started from a sandboxed command |
| Session launching, Milestone 1 (`plan-session-launching-milestone-1`) | Backlog | Affected. Its background start runs one headless Claude turn, the same path as the evals runner |

## Goals

- Sessions started after `roborepo update` run shell commands in Claude's native sandbox, in the
  main checkout and in linked worktrees.
- A command that stays inside the repository and temp folders runs without a permission prompt.
- Credential paths in `read-secrets` stay unreadable from shell commands, while public CA bundles
  stay readable so allowed network tools work.
- Commands that cannot work in the sandbox, including `roborepo plans` writes to the plans store,
  keep working.
- The shared permission source states the intent; the Claude provider owns every Claude-native key.

## Non-goals

- Changing Claude's default permission mode, including auto mode.
- Changing the Codex profile, including what `go-online` does for Codex.
- Isolating app and browser test runs (`8bjltk2n`).
- Relaxing ask rules such as `push-code`, or redesigning the permissions editor
  (`permissions-ui-revamp`).

## Proposed design

```mermaid
flowchart TD
  M["Shared permission source"] -->|"states sandbox intent to"| CP["Claude provider"]
  CP -->|"renders"| CR["permissions key (unchanged)"]
  CP -->|"renders"| CS["sandbox key (new)"]
  CR -->|"merged by Claude into"| SB["Per-command Seatbelt sandbox"]
  CS -->|"configures"| SB
```

### Shared intent

| Intent | Shared source | Claude projection |
| --- | --- | --- |
| Run shell commands confined, without prompting | New behavior, default on | `sandbox.enabled`, `sandbox.autoAllowBashIfSandboxed` |
| Writable temp folders | Existing `write-scope` | None; Claude merges the `Edit` allow rules |
| Unreadable credentials | Existing `read-secrets` | None; Claude merges the `Read` deny rules |
| Readable public CA bundles | New exception list beside `read-secrets` | `sandbox.filesystem.allowRead` |
| Hosts reachable without a prompt | New allowed-host list, default `registry.npmjs.org`, `github.com`, `*.githubusercontent.com` | `sandbox.network.allowedDomains` |

`go-online` keeps its meaning: Codex's network on/off switch, still `codexOnly`, default `deny`. The
allowed-host list is independent of it, and Codex ignores the list until a separate plan adopts it.
Only `go-online`'s description changes, because "Claude does not sandbox network egress" becomes
false.

### Provider-owned details

These carry Claude-native names or Claude-specific limits, so they live with the Claude provider and
never in platform code, as `docs/internal/harness-provider-interface.md` requires:

- **Projection module.** One pure function in a new module under `scripts/harnesses/claude/`,
  following `scripts/harnesses/codex/credential-permissions.mjs`. It takes resolved behaviors and
  provider options and returns the `sandbox` object. `renderClaudeRootConfig` in
  `scripts/harnesses/claude/index.mjs` sets `rendered.sandbox` from it, beside the hooks merge, so
  the platform's `renderClaudeSettings` stays free of Claude sandbox keys.
- **Fixed settings.** `allowLocalBinding: false`; `strictAllowlist` unset, so unlisted hosts prompt.
- **Excluded commands.** `docker`, `gh`, the `git` network commands, and `roborepo`, as in the trial,
  if the first checklist item shows exclusions work. Otherwise the commands that need writes outside
  the sandbox get those paths through writable paths instead.
- **Extra writable paths.** `~/.npm` for the npm cache, which the trial added. The plans store paths
  that `scripts/harnesses/codex/plans-store-grants.mjs` already lists for Codex, if `roborepo plans`
  must run sandboxed. A second consumer moves that module out of the Codex folder to a shared
  location. Wire them through the optional adapter methods `permissions.workspaceRoots` and
  `permissions.writablePaths`, which `permissionOptionsForProvider` in
  `scripts/cli/permissions-render.mjs` already calls with the current directory.

### Ownership of the generated key

RoboRepo owns `sandbox` in the generated `~/.claude/settings.json` the way it owns `permissions`:
each render replaces it, and hand edits there are lost. Claude merges array settings across scopes,
so a repository's `.claude/settings.local.json` can still add entries.

## Implementation plan

- [ ] With the trial block active, check whether `sandbox.excludedCommands` is honored, in a
      desktop-app session and in a CLI session, using `roborepo plans show <id> --json` and its
      `synchronized` field. Record the result and the pattern that works in the Decision Log.
- [ ] In a linked worktree with the trial block copied in, run `git commit` and record whether
      writes to the main checkout's `.git` succeed.
- [ ] Add the confined-shell behavior, the readable CA exception list, and the allowed-host list to
      `manifests/inventory/agent-permissions.json`. Correct the `go-online` description.
- [ ] Add the Claude sandbox projection module and its excluded command list under
      `scripts/harnesses/claude/`.
- [ ] Set `rendered.sandbox` in `renderClaudeRootConfig`, preserving unrelated keys.
- [ ] Implement `permissions.writablePaths`, and `permissions.workspaceRoots` if needed, for Claude
      according to the two checks above. Move `plans-store-grants.mjs` to a shared location if
      Claude reuses it.
- [ ] Correct the two "Codex-only" comments in `scripts/harnesses/permissions-render.mjs` and the
      `go-online` comment in `scripts/cli/config.mjs`.
- [ ] Show the new behaviors in the permission rows built by `scripts/cli/config.mjs`.
- [ ] Add the projection check to `scripts/test/check-groups.json` and the enforcement runner to the
      explicit-runner list in `scripts/test/orphan-test-check.mjs`, as described under Validation.
- [ ] Update the documents under Documentation impact.
- [ ] Remove the trial `sandbox` block from the main checkout's `.claude/settings.local.json` once
      the generated settings carry it.

## Validation

Projection and enforcement need separate evidence, following "Codex credential verification" in
`docs/internal/testing.md`.

| Check | Establishes | Where it runs |
| --- | --- | --- |
| New `scripts/test/claude-sandbox-projection-check.mjs` | The rendered `sandbox` key for default and overridden behaviors; unrelated settings keys and hooks preserved; a second render changes nothing | Deterministic CI group |
| New `scripts/test/claude-sandbox-enforcement-check.mjs` | On a real Claude binary: temp and repository writes succeed, a home-folder write fails, a credential read fails, a public CA bundle reads, an allowed host connects, an excluded command runs unsandboxed | Explicit macOS probe; exits 2 when no sandbox is available, like the Codex runner |
| `scripts/test/permissions-render-live-characterization-check.mjs` | Existing live render output changes only by the new key | Deterministic CI group |

Acceptance criteria:

- [ ] After `roborepo update`, the generated Claude settings contain the `sandbox` key and
      `roborepo doctor` passes.
- [ ] The enforcement runner passes and records the Claude version, platform, and each positive and
      negative control.
- [ ] `git commit` succeeds from a linked worktree session with the sandbox on.
- [ ] `git push`, `gh pr view`, and `roborepo plans show <id> --json` behave as they do today;
      `roborepo plans show` reports `"synchronized": true`.
- [ ] `npm run check` passes.

## Risks

- **Projection is not enforcement.** A rendered key proves nothing about runtime behavior, so the
  enforcement runner is required before the docs claim coverage.
- **Excluded commands are a gap by design.** They run with full access, and the git network
  commands can reach any host. Keep the list short and reviewed.
- **Writable paths are rendered per checkout.** `~/.claude/settings.json` is user-level, so paths
  derived from the current directory at `roborepo update` apply to every session. Prefer paths that
  hold for any checkout.
- **Headless Claude may not start from a sandboxed command.** The trial's `claude -p` reported "Not
  logged in", cause unconfirmed. With the sandbox on by default, an agent that runs the evals runner
  (`0jped168`) or the session launcher's background start from its shell would hit the same failure.
  Those plans need the cause confirmed, or their commands run outside the sandbox, before they rely
  on that path.
- **Claude version drift.** Sandbox keys and merge rules may change between releases. The
  enforcement runner names the version it verified.
- **macOS-only evidence.** Linux uses a different mechanism and needs extra packages; Windows runs
  unsandboxed. State coverage per platform and do not imply more.
- **A CA exception list can go stale.** A new OpenSSL or Homebrew layout brings back certificate
  failures. The enforcement runner's allowed-host control catches it.

## Documentation impact

- `docs/user/reference/config-control-panel.md`: describe the confined-shell behavior, the allowed
  hosts, and what runs outside the sandbox.
- `docs/internal/harness-provider-interface.md`: "Provider-owned sandbox additions" names Codex as
  the only implementer; add Claude.
- `docs/internal/testing.md`: add the Claude projection and enforcement checks beside "Codex
  credential verification".
- `docs/internal/config-panel-internals.md`: record the new behaviors and their Claude projection.

## Decision Log

- **2026-11-12 — `go-online` stays Codex-only; Claude reads a separate allowed-host list.** Making
  `go-online` gate Claude would, with its `deny` default, make every network command prompt; flipping
  the default would turn on Codex network access. Chosen by the user during promotion.
- **2026-11-12 — Local port binding stays off.** The Codex series rejected wildcard listeners, and
  whether `allowLocalBinding` is narrower is unverified. Dev servers started through the app's
  preview tools do not run in the shell sandbox.
- **2026-11-12 — Unlisted hosts prompt rather than fail.** `strictAllowlist` stays unset at first;
  revisit once the host list has proven complete.
- **2026-11-12 — Codex parity for the CA exceptions and host list is a separate plan.** Codex's
  network is off by default, so the `*.pem` denial has no observed effect there yet.

## Open questions

None. The two checks at the top of the implementation plan decide provider details, not scope.
