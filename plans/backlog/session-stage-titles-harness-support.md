---
id: 96r9wbj0
next_action: Waiting on Codex or Gemini to offer a way to set a session title; when one ships, check it against the options table in this plan and run /plan-promote
blocked_by: []
depends_on:
  - gcfw77cq
related: ["gcfw77cq", "plan-session-launching-milestone-1"]
reviewed_commit: 7cffabe79b2ff859b78b5f702e1a3e4e73802e74
worktree:
---
# Stage Titles on Harnesses That Cannot Set Them Yet

## Summary

Make Codex and Gemini sessions show the plan-workflow stage in their titles automatically, as
Claude sessions do after "Session Titles Show the Workflow Stage" (`gcfw77cq`). This plan is
deliberately parked: it cannot start until one of those harnesses offers a way to set a session
title that a hook, a launch flag, or the agent can use.

## Context

"Session Titles Show the Workflow Stage" gives sessions titles such as
`/plan-execute: <plan title>`. In Claude a hook sets the title. Codex and Gemini have no such
mechanism, so that plan leaves their part of the harness provider as placeholders and falls back to
a title line in copied prompts plus a rename line the person pastes. This plan replaces the
placeholders when support exists.

## Goals

- Codex and Gemini sessions get the same stage titles without the person typing anything.
- The manual rename line disappears for a harness once its title is set automatically.

## Non-goals

- Changing the title format, which the earlier plan owns.
- Building on Codex's app-server protocol only to rename sessions; see Risks.

## Current state

Read in the official Codex documentation and issue tracker on 2026-11-23; not exercised.

| Possible mechanism | Codex today | What would unblock this plan |
| --- | --- | --- |
| Name a session at launch | Not available; requested in openai/codex issue 44422 | The flag ships for `codex` and `codex exec` |
| Hook returns a title | None documented | A hook output field for the title |
| Agent renames its own session | None documented | A tool or command the agent can call |
| App-server call `thread/name/set` | Exists | Only useful if RoboRepo already drives Codex through the app server |
| Person types `/rename <name>` | Available | Already used as the fallback |

Gemini's options have not been investigated; doing so is the first task.

## Proposed design

Implement the `session-title` adapter the earlier plan stubbed, for whichever harness gains a
mechanism, and wire the matching package resource:

| Mechanism that ships | Change |
| --- | --- |
| Hook output | Implement `sessionTitle.hookOutput` in the provider and add a `hooks` resource for that harness to the plan-suite package |
| Launch flag only | Add the title to the launch arguments the session launcher builds, and keep the rename line for sessions started by hand |
| Agent-callable rename | Extend the plan-suite rule's "if the agent can rename its own session" case; no adapter change |

The rule's rename-line instruction is narrowed so it no longer applies to a harness whose title is
set automatically.

## Implementation plan

- [ ] Investigate Gemini's session title options and add them to the Current state table.
- [ ] Recheck Codex: issue 44422, the hooks reference, and the changelog.
- [ ] Implement the adapter and package resource for each harness that gained a mechanism.
- [ ] Narrow the rename-line rule and update the harness documentation.

## Validation

- The provider contract check shows the implemented harness's `sessionTitle` method is no longer a
  stub.
- A recorded hook input, or the built launch arguments, yields the expected title for that harness.
- One check needs a person: a plan command in the real harness shows the stage title in its
  session list.

## Documentation impact

| Document | Update |
| --- | --- |
| `docs/user/reference/codex-hooks.md` | List the title hook, if the hook mechanism ships |
| `docs/user/guides/harnesses/supported-harnesses.md` | Show which harnesses set stage titles automatically |

## Risks

- **Waiting has no end date.** The upstream request may never ship. The fallback from the earlier
  plan keeps working, so nothing degrades while this plan waits.
- **App-server temptation.** Using `thread/name/set` would mean running Codex through its app
  server, which "Session Launching — Milestone 1" lists as a non-goal. Revisit only if that changes.

## Open questions

- Is it worth shipping for one harness when only one of the two gains support? Recommended: yes;
  the work per harness is independent.
