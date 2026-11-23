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
# Stage Titles for Codex and Gemini Sessions

## Summary

Make Codex and Gemini sessions show the plan-workflow stage in their titles automatically, as
Claude sessions do after "Session Titles Show the Workflow Stage" (`gcfw77cq`). This plan is
deliberately parked. Codex offers no way to set a session title from a hook, a launch flag, or the
agent, and Gemini's options have not been investigated; work starts when either has one.

## Context

The earlier plan gives sessions titles such as `/plan-execute: <plan title>`. Three things from
that plan matter here:

| From the earlier plan | What it is |
| --- | --- |
| Title hook | In Claude, a hook runs `roborepo plans session-title` on each prompt and Claude sets the title from its output |
| `session-title` capability | A feature a harness's RoboRepo provider (its code under `scripts/harnesses/<id>/` and manifest under `globals/harnesses/<id>/`) declares when the harness can set a title. Only Claude declares it. Two provider functions sit behind it: `sessionTitle.readHookInput` reads the prompt and current title from the harness's hook input, and `sessionTitle.hookOutput` returns the hook output text that sets a title |
| Rename-line rule | A rule in `globals/packages/plan-suite/rules.md` telling an agent that cannot rename its session to print `/rename <title>` for the person to paste, in every harness except Claude Code |

Outside Claude the person therefore pastes a rename line at each stage. This plan removes that
step for a harness once the harness can set the title itself.

## Goals

- Codex and Gemini sessions get the same stage titles without the person typing anything.
- The agent stops printing the rename line in a session whose title is set automatically.

## Non-goals

- Changing the title format, which the earlier plan owns.
- Driving Codex through its app server (a separate programmatic interface to Codex) only to rename
  sessions; see Risks.

## Current state

Codex facts were read in its official documentation and issue tracker on 2026-11-23 and not
exercised. Gemini has not been investigated; that is the first task.

| Possible mechanism | Codex today | What would unblock this plan |
| --- | --- | --- |
| Name a session at launch | Not available; requested in openai/codex issue 44422 | The flag ships for interactive `codex` and for `codex exec`, its non-interactive mode |
| Hook returns a title | None documented | A hook output field for the title |
| Agent renames its own session | None documented | A tool or command the agent can call |
| App-server request `thread/name/set` | Exists | Only useful if RoboRepo already runs Codex through the app server |
| Person types `/rename <name>` | Available | Already used as the fallback |

## Proposed design

For whichever harness gains a mechanism:

| Mechanism that ships | Change |
| --- | --- |
| Hook output | Declare `session-title` in that harness's provider manifest, implement `sessionTitle.readHookInput` and `sessionTitle.hookOutput` for its hook format, and add a `hooks` resource for that harness to the plan-suite package |
| Launch flag only | Add the title to the launch arguments built by the session launcher. The launcher is not built yet: it is planned in "Session Launching — Milestone 1" (`plan-session-launching-milestone-1`), which this option would then depend on. The launcher's prompt states that the title is already set, and the rule tells the agent to skip the rename line when the prompt says so. Sessions started by hand keep the rename line |
| Agent-callable rename | None. The earlier rule already tells an agent with a rename tool to use it |

When a harness's title is set by a hook, add that harness beside Claude Code in the rename-line
rule's "do nothing more" case, so the agent stops printing the line there.

## Implementation plan

- [ ] Investigate Gemini: how it titles sessions, whether a hook, flag, or agent can set the title,
      and whether it has a rename command. Add a Gemini column to the Current state table.
- [ ] Recheck Codex: issue 44422, the hooks reference, and the changelog.
- [ ] Apply the matching row of the Proposed design table for each harness that gained a mechanism.
- [ ] Update the rename-line rule and the documents listed under Documentation impact.

## Validation

- Given recorded hook input for the harness, `roborepo plans session-title --harness <id>` prints
  that harness's title output; or, for the launch-flag option, the built launch arguments contain
  the title.
- Enabling and disabling plan-suite adds and removes the new hook in a simulated config for that
  harness, extending `scripts/test/hook-composition-check.mjs`.
- One check needs a person: a plan command in the real harness shows the stage title in its
  session list.

## Documentation impact

| Document | Update |
| --- | --- |
| `docs/user/guides/harnesses/supported-harnesses.md` | Mark the harness as supporting `session-title` |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | Say which harnesses set stage titles automatically |
| `docs/user/reference/codex-hooks.md` | List the title hook, if Codex gains the hook mechanism |
| `docs/internal/harness-provider-interface.md` | Update the per-harness capability notes |

No Gemini hooks reference exists under `docs/user/reference/`; creating one belongs to whichever
plan first gives Gemini a hook.

## Risks

- **Waiting has no end date.** The upstream request may never ship. The fallback from the earlier
  plan keeps working, so nothing degrades while this plan waits.
- **App-server temptation.** Using `thread/name/set` would mean running Codex through its app
  server, which "Session Launching — Milestone 1" lists as a non-goal. Revisit only if that changes.

## Open questions

- Is it worth shipping for one harness when only one of the two gains support? Recommended: yes;
  the work per harness is independent.
