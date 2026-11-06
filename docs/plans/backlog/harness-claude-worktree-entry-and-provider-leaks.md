---
id: 46qth5z8
next_action: Check recent transcripts for agents still entering worktrees with change_directory, then refine the provider leak fixes with /plan-promote.
blocked_by: []
depends_on: []
related: ["4zyo2woj", "wjlt1zvf", "7k3m9qd", "harness-capability-derived-resource-targeting", "uvzskd7z", "vzgsx5vz"]
reviewed_commit: d155e9ae78ac09dbe910aff211838f18d0e0b626
worktree:
---

# Keep local agent work within useful boundaries: Claude

## Summary

Claude desktop files each session in its sidebar under the session's project folder. When an agent
enters a linked worktree with the app's `change_directory` tool, the app moves the whole session
under the worktree folder, including the turns that ran in the main checkout. A new thread started
from that sidebar folder then begins inside the worktree. Entering the same worktree with Claude's
`EnterWorktree` tool keeps the session filed under the repository.

Clear agent friction (`vzgsx5vz`) corrects the rule that told agents to use `change_directory`, which
is expected to stop the misfiling. This plan checks that it did, and keeps a core `PreToolUse` hook
as a fallback design if agents still use `change_directory`.

Its main work moves three harness-specific details out of platform code and behind provider data, as
`docs/internal/harness-provider-interface.md` requires: Claude's hook sources in the system tree,
the hardcoded `.claude/worktrees` folder, and Runtime's hardcoded agent process names.

The companion plan, Keep local agent work within useful boundaries: Codex (`4zyo2woj`), owns the
Codex sandbox, approval, and credential-read work and the Codex-side leaks.

## Context

### Terms

| Term | Meaning |
| --- | --- |
| Main checkout | The first entry of `git worktree list`; its `.git` is a directory |
| Linked worktree | Any other checkout of the same repository; its `.git` is a file pointing at `<main>/.git/worktrees/<name>` |
| Common git dir | The `.git` directory of the main checkout. A main checkout and all its linked worktrees share one |
| Project folder | The folder Claude desktop files a session under in its sidebar |
| Platform / provider | The layers defined in `docs/internal/harness-provider-interface.md`: platform code owns behavior; provider code (`scripts/harnesses/<id>/`, `globals/harnesses/<id>/`) is the only place a harness's native names may appear |

### How a session ends up filed under a worktree

```mermaid
flowchart LR
  A["Session starts in main checkout"] -->|"agent calls change_directory(worktree)"| B["App re-files whole session under worktree folder"]
  B -->|"user starts new thread from that sidebar folder"| C["New session starts inside worktree"]
  A -->|"agent calls EnterWorktree({ path })"| D["Session stays filed under main checkout"]
```

`globals/packages/plan-suite/skills/plan-execute/SKILL.md` ("Enter the Worktree") tells the agent to
make the worktree the session's working directory by "the environment's standard mechanism". In the
desktop app an agent may pick either tool. The rule in
`globals/system/rules/claude/90-claude-specific.md` now names `EnterWorktree`; before `vzgsx5vz` it
named `change_directory`, starting on October 30, after the evidence below.

### Evidence

Observed between October 7 and October 15, 2026, in Claude transcripts and the telemetry spool:

| Session | Started in | Entered worktree with | Filed under |
| --- | --- | --- | --- |
| Portal UI tweaks and styling | main checkout | `change_directory` | worktree `portal-repository-scope` |
| Harness hook readiness provider adapters | worktree `portal-repository-scope`, started from its sidebar folder | `EnterWorktree` | worktree `portal-repository-scope` |
| Harness hook readiness provider adapters (fork) | main checkout | `EnterWorktree` with `path` | main checkout |
| Localhost runtime layout | main checkout | `change_directory` | transcript stored under worktree `.claude/worktrees/localhost-runtime-layout-*`; sidebar placement not checked |

- The telemetry capture hook (`globals/packages/telemetry/hooks-claude.json`, matcher `""`) recorded
  `PreToolUse` and `PostToolUse` events for `mcp__ccd_directory__change_directory`. So `PreToolUse`
  hooks run for the desktop app's own MCP tools. Whether the app honors a `deny` decision for them
  is not yet observed.
- `EnterWorktree` with a `path` into a `~/.worktrees/<repo>/...` worktree succeeded, including from
  a session that had started inside another linked worktree of the same repository.
- Hook configuration loads at session start. A hook added to settings mid-session does not run in
  that session, so the live check needs a fresh session.

### Provider leaks in platform code

Each row is a place where platform code names a harness directly instead of reading it from the
provider's manifest (`globals/harnesses/<id>/provider.json`):

| Leak | Location | What is hardcoded | Provider data that already exists |
| --- | --- | --- | --- |
| Claude hook sources | `globals/system/hooks/claude/` (`write-guard.mjs`, `minimize-bash-output.mjs`) | Claude-only hook scripts live in the system tree, while Claude's `repo-write-scope.mjs` lives in `globals/harnesses/claude/hooks/`, so core Claude hooks have two source homes | `manifests/platform/manifest.tsv` rows map each source folder to its install destination (`hooks` and `hooks/provider`) |
| Agent worktree folders | `scripts/cli/worktree-policy.mjs` `isToolOwned` | The path segment `/.claude/worktrees/`, where Claude's `EnterWorktree` creates worktrees. Cleanup uses it to keep app-owned worktrees from widening the proposed cleanup folder | None yet |
| Agent process names | `modules/developer-runtime/provenance.mjs` `AGENT_PATTERNS` | The `claude` and `codex` process names. Runtime walks a dev server's parent processes to label which agent launched it; Gemini is absent, so a server Gemini launched gets no label | Every manifest declares `detection.executables` and `displayName` |

`docs/internal/harness-provider-interface.md` shows the manifest extension key as `roborepo`. The
manifests and their readers use `app`.

### Related plans

| Plan | Relationship |
| --- | --- |
| `4zyo2woj` (`backlog/harness-codex-sandbox-boundaries-and-provider-leaks.md`) | The Codex series owns its companion work. Part 1 (`hr78g4sj`) moves Codex sources to `globals/harnesses/codex/hooks/`; Part 2 owns credential protection. Part 1 may declare a Codex worktree folder once this plan adds `agentWorktreeDirs` |
| `wjlt1zvf` (`review/harness-hook-readiness-provider-adapters.md`) | Changes Codex hook merge order and `hook-composition-check.mjs`. No shared files with this plan; its own leak table is not repeated here |
| `7k3m9qd` (`backlog/packages-resource-provider-delivery.md`) | Owns the per-harness branches in `scripts/cli/packages.mjs` |
| `harness-capability-derived-resource-targeting` | Changes how `hooks` resources name their harnesses; no shared files |
| `backlog/telemetry-repository-attribution-and-reset.md` | Owns telemetry repository aliases and canonical labels, the telemetry half of the sidebar report |
| `uvzskd7z` (`backlog/agent-config-temp-folder-work-without-prompts.md`) | Adds a Bash hook beside the Claude hook sources this plan moves. No shared design, but whichever lands second has a small rebase |

## Goals

- Evidence shows whether agents in Claude desktop sessions still enter linked worktrees with
  `change_directory` now that the rule names `EnterWorktree({ path })`.
- The three leaks above are resolved by reading provider data, so a new provider gets correct
  behavior by declaring it.

## Non-goals

- Building the worktree-entry hook, unless the transcript check finds agents still using
  `change_directory`. That needs the user's decision first.
- Changing the worktree rule or plan-execute's wording. `vzgsx5vz` owns the rule, and plan-execute's
  tool-neutral text stays.
- Re-filing existing sidebar sessions. No tool changes a session's project folder after it starts.
- Codex or Gemini equivalents of the hook. Neither has a tool that re-files a session.
- A user-configurable worktree-entry behavior. Re-filing a session under a worktree is never wanted,
  so this is core wiring rather than a package or an `agent-permissions.json` bucket.
- Moving `globals/system/rules/<id>/`. The provider interface doc names it as the per-provider rules
  location, and changing that is a separate decision.
- Codex hook sources, the Codex hooks-file branch, and the headless deep-read CLI list. The Codex
  plan owns them.

## Proposed design

### Worktree-entry hook (fallback, not built by default)

Build this only if the transcript check shows agents still using `change_directory` and the user
agrees. First confirm the app honors a deny: in a fresh Claude desktop session, add a temporary hook
to a gitignored `.claude/settings.local.json` that denies `mcp__ccd_directory__change_directory`, and
call it with the session's own folder as the target, so a missed deny moves nothing. Then add
`scripts/test/worktree-entry-hook-check.mjs`, and wire the hook into both
`globals/harnesses/claude/hooks-claude.json` and `generated/claude/settings.json`.

`globals/harnesses/claude/hooks/worktree-entry.mjs`, wired in
`globals/harnesses/claude/hooks-claude.json` with matcher `mcp__ccd_directory__change_directory`.
It installs to `~/.claude/hooks/provider/` through the existing `manifest.tsv` row.

| Condition | Result |
| --- | --- |
| `tool_input.path` is a linked worktree, and its common git dir equals the common git dir of the checkout containing `cwd` | `deny`, with a reason naming `EnterWorktree({ path: "<target>" })` and saying why |
| Target is a main checkout, a non-git folder, or another repository's worktree | No output; the call proceeds |
| Input fails to parse, a path does not resolve, or a `.git` file is unreadable | No output; the call proceeds |

Rules it follows, matching `globals/harnesses/claude/hooks/repo-write-scope.mjs`:

- Resolve the common git dir by reading `.git` (directory, or a file whose `gitdir:` leads to a
  `commondir` entry) in-process. Do not spawn `git`.
- Defer on any uncertainty. A hook that cannot decide must not refuse a legitimate move.
- Keep the refusal reason self-contained. Claude returns it to the agent as the tool result, and it
  is the only instruction the agent receives.

### Leak fixes

| Leak | Change |
| --- | --- |
| Claude hook sources | Move `globals/system/hooks/claude/*` under `globals/harnesses/claude/hooks/` and repoint its `manifest.tsv` row. Keep every install destination and command string unchanged (see Open questions). The moved files still install to `~/.claude/hooks/`, so they need a source folder that the `hooks/provider` row does not also copy |
| Agent worktree folders | Add `extensions.app.agentWorktreeDirs` to the manifest schema: path segments under which a provider's app creates worktrees, matched anywhere in a worktree path as `isToolOwned` does today. Claude declares `.claude/worktrees`. `isToolOwned` matches any registered provider's entries. Matching anywhere, rather than relative to the repository, also covers a worktree observed at `~/.codex/worktrees/<name>/roborepo`, likely created by the Codex app (the Codex plan confirms it) |
| Agent process names | Build agent patterns from each provider's `detection.executables` and `displayName`. Keep Cursor as a separate non-provider entry, since it is not a registered harness |

## Implementation plan

### Phase 1: check the rule change worked

- [ ] Search Claude transcripts from sessions started after `vzgsx5vz` landed for
      `mcp__ccd_directory__change_directory` calls into linked worktrees and for `EnterWorktree`
      calls. Record the counts in the Decision Log.
- [ ] If agents still use `change_directory`, ask the user whether to build the fallback hook. Phase 2
      does not depend on this result.

### Phase 2: provider leaks

- [ ] Claude hook sources: move the files and repoint `manifest.tsv`, plus the source paths in
      `scripts/test/core-hook-wiring-check.mjs` and `scripts/test/test-install-collisions.sh`. Run
      `bash scripts/doctor.sh --quiet` and the clean-machine sandbox to prove install destinations
      and command strings are unchanged.
- [ ] Agent worktree folders: add `agentWorktreeDirs` to the manifest schema and the Claude
      manifest. Extend `scripts/test/worktree-lifecycle-check.mjs` with a synthetic provider's
      folder.
- [ ] Agent process names: no provenance test exists today. Add one that fails while a process named
      `gemini` resolves to no label and passes once it resolves to Gemini's `displayName`, then
      derive the patterns from manifests.
- [ ] Extend `scripts/test/delivery-synthetic-provider-check.mjs` or
      `scripts/test/telemetry-synthetic-provider-check.mjs` where the worktree-folder and
      process-name changes touch their paths, so the `acme` provider proves the new fields
      generalize.

## Validation

- The Decision Log records the transcript counts from Phase 1.
- `node scripts/test/core-hook-wiring-check.mjs` and `node scripts/test/worktree-lifecycle-check.mjs`
  pass, and the new provenance test passes.
- `scripts/cli/worktree-policy.mjs` no longer contains `/.claude/worktrees/`, and
  `modules/developer-runtime/provenance.mjs` no longer lists `claude` or `codex` patterns. Claude
  hook sources are covered by `doctor.sh` and the sandbox.
- `bash scripts/doctor.sh --quiet` and `git diff --check` pass. `npm run check` passes before push,
  because this work changes install mapping and core hook wiring.

## Documentation impact

| Doc | Update |
| --- | --- |
| `docs/internal/hooks-internals.md` | Point the Claude system hook location at `globals/harnesses/claude/hooks/` |
| `docs/internal/harness-anatomy.md`, `docs/internal/skill-reference-observation.md` | Update the Claude system hook source paths |
| `docs/internal/harness-provider-interface.md` | Correct the extension key to `app`; document `agentWorktreeDirs` and the use of `detection.executables` for process labels |
| `globals/packages/plan-suite/skills/plan-execute/SKILL.md` | None. Its tool-neutral "Enter the Worktree" wording stays; the Claude rule steers the choice |

## Risks

| Risk | Mitigation |
| --- | --- |
| The rule alone does not change which tool agents pick | Phase 1 measures it, and the fallback hook design stays in this plan |
| Moving Claude hook sources orphans old install copies | Keep destinations unchanged, so no installed path moves |

## Decision Log

- October 21: expanded the plan to own both Claude worktree-entry behavior and Codex
  localhost/approval friction.
- October 22: split by provider at the user's request. This plan keeps its ID and the Claude work:
  the worktree-entry hook, Claude hook sources, agent worktree folders, and agent process names. The
  Codex work, including the hooks-file branch, Codex hook sources, and the headless deep-read CLI
  list, moved to `4zyo2woj`, which also absorbed the Codex credential-read guard. The process-name
  leak is provider-neutral and stays here because this plan has no research gate.
- November 6: `vzgsx5vz` takes the rule correction, and the hook became a fallback. The plan's earlier
  objection to a rule was its context cost, which no longer applies: the rule already exists and only
  its text changes.

## Open questions

- **Claude hook source layout.** Recommended: move sources only, keeping `~/.claude/hooks/` and
  `~/.claude/hooks/provider/` as they are. The alternative installs every Claude hook under one
  folder, which changes command strings in `generated/claude/settings.json` and leaves stale files in
  existing homes.
