---
id: txhlglk
priority: medium
next_action: Run /plan-promote to validate and prepare the minimal plan-execute skill change
blocked_by: []
depends_on: []
related: []
reviewed_commit:
worktree:
---

# Keep long plan executions moving with guided context compaction

## Summary

Teach `/plan-execute` to recommend native context compaction at useful implementation boundaries, preserve the facts needed to continue, and resume without requiring harness-specific provider code.

## Context

Long `/plan-execute` runs can fill the agent's context before the plan is complete. Waiting for automatic compaction may leave too little room to preserve the right implementation state. A new session can recover from the plan, but starting again may require unnecessary rediscovery. The first solution should be a small change to skill instructions, not new monitoring or orchestration infrastructure.

## Goals

- Conserve context during long-running execution without routinely stopping the user.
- Keep guidance portable across Claude Code and Codex by relying on each harness's native compaction capability.
- Preserve enough durable state to continue work after compaction or a new session.
- Make it explicit when the agent must ask the user to initiate compaction itself.

## Non-goals

- Automatic context-percentage monitoring, fixed compaction thresholds, or token-based triggers.
- New provider interfaces, hooks, telemetry, settings, runtime services, or session launchers.
- Automatically creating a new chat, transferring live session state, or bypassing usage limits.
- Changing how plan lifecycle transitions, commits, or normal approval decisions work.
- Creating a generalized context-management skill or reference before this small experiment is validated.

## Current state

`globals/packages/plan-suite/skills/plan-execute/SKILL.md` already directs the agent to implement coherent slices, keep the active plan synchronized, and resume from the first open task and `next_action`. Its **Run Mode** currently says not to stop for milestone check-ins or ask the user questions during implementation. That rule needs a narrow, explicit exception for context-preserving compaction; otherwise the new instruction could conflict with existing behavior.

The plan document in the assigned worktree remains the authoritative progress record. Compaction does not reset harness usage limits, and native `/compact` commands may be user-only rather than agent-callable.

## Proposed design

Add a short **Context management** instruction to `plan-execute` and reconcile the existing **Run Mode** wording:

1. **Consider, do not schedule.** At a *logical completion boundary* after a meaningful implementation slice, assess whether the accumulated conversation is large enough that compaction would materially help before the next substantial slice. Do not pause at every task or use an arbitrary percentage.
2. **Checkpoint first.** Before requesting or initiating compaction, synchronize the authoritative plan: completed tasks, `next_action`, decisions, blockers, changed work and verification state. Reuse existing plan sections and Git state; do not create a second handoff document by default.
3. **Use native behavior when actually available.** If the agent can invoke the harness's native compaction mechanism, do so. Otherwise explicitly ask the user to trigger compaction and supply concise instructions. Never claim a command was invoked when it was only suggested.
4. **Preserve selectively.** Keep the plan identity/path, current worktree and branch, progress, decisions, constraints, changed files, open problems, checks and immediate next action. Drop redundant tool output, completed investigation, failed or superseded approaches, and repetitive conversation.
5. **Resume deliberately.** After compaction, consult the authoritative plan and current worktree as necessary, then continue at the first unfinished unblocked task. Do not restart the plan or re-run successful work without reason.

A compaction request is the *only new permitted mid-run interruption*, and only when the agent reasonably judges the context at risk. If the user declines or compaction is not available, continue with the existing execution and progress-recording rules rather than repeatedly prompting at every boundary. A compaction prompt is not a design decision and does not belong in the batched Open Questions queue.

### Example user-facing request

> Context is getting large, so this is a good checkpoint. I've updated the plan with completed work and the next action. Please compact this session using your harness's native command. Preserve the plan/worktree identity, outstanding tasks, key decisions, changed files, blockers, and verification state; discard verbose tool output and obsolete exploration. Then I'll continue from the next unchecked task.

This is illustrative wording, not a harness-specific command syntax. Where the harness accepts custom compaction instructions, the preservation text can be supplied with the native action.

## Implementation plan

- [ ] Update `globals/packages/plan-suite/skills/plan-execute/SKILL.md` with concise, harness-agnostic context-management guidance at a suitable point in the Implementation Workflow.
- [ ] Reconcile the Run Mode prohibition on check-ins/questions so a *necessary context-compaction request* is explicitly allowed, without weakening normal uninterrupted execution or the existing blocker policy.
- [ ] Check the guidance against existing plan progress, worktree authority, resume, and verification instructions; remove any redundancy or conflicting requirements.
- [ ] Update the plan-suite user walkthrough's `/plan-execute` description if the new compaction interruption needs to be documented for users.
- [ ] Perform focused manual smoke checks with Claude Code and Codex; note whether each can initiate compaction or needs a user action, and confirm that continuing does not lose task state.

## Success criteria

- [ ] The skill recommends compaction only when useful, at coherent work boundaries, rather than prompting on every milestone.
- [ ] When compaction is needed, the agent has updated the authoritative plan first and gives preservation/discard guidance suitable for its harness.
- [ ] The agent does not assume `/compact` can be issued by the agent, or report compaction as complete without evidence.
- [ ] Execution resumes using the existing plan and worktree rather than creating a parallel tracking mechanism.
- [ ] Ordinary `plan-execute` behavior still runs without routine user check-ins, and there are no provider changes or new configuration surfaces.

## Validation

- Run the repository's canonical plan validator for this plan when it is added to the checkout. Confirm frontmatter, namespace, sections, and checklist are accepted.
- Review the `plan-execute` skill diff for conflicting Run Mode instructions, extra infrastructure, and repeated prose.
- In a representative multi-slice plan, check that an early low-context slice continues silently, while a deliberately context-heavy checkpoint produces one actionable compaction request with accurate state.
- For Claude Code and Codex, validate the applicable native/user-triggered path and verify that the agent resumes from the first unfinished task after compaction. Record unsupported or unverified behavior honestly; do not consume large amounts of context just to force a threshold.
- No broad test suite is required for a prose-only instruction change unless repository validators or affected checks require it.

## Documentation impact

- `docs/user/guides/plan/lifecycle/plan-suite.md`: update the `/plan-execute` behavior description only if the new mid-run prompt is user-visible enough to warrant a sentence. Do not add a separate guide.

## Risks

- **Over-prompting:** agents might treat every completed slice as a compaction request. Explicitly require meaningful benefit and avoid repeated requests after the user declines.
- **Unsupported direct invocation:** native slash commands may only be accepted from users. Provide a user-triggered fallback rather than assuming agent access.
- **Lost state:** compaction can omit details that exist only in conversation. Synchronize the authoritative plan before any request.
- **Conflicting policies:** the new exception must be reconciled with `plan-execute`'s no-check-in and Open Questions rules.

## Open questions

None blocking. The smoke checks determine how well the shared instruction works in each harness; any future provider-specific mechanism is a separate, evidence-driven decision.
