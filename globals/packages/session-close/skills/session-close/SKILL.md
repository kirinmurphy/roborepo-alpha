---
name: session-close
description: >
  Use ONLY when the user explicitly asks to wrap up, close out, or finish the current
  chat/session before starting a new one — via the `/session-close` command or a clear
  instruction like "wrap this up", "let's close this out", "get this ready for a new
  chat". Runs a fixed sequence: self-review the code changed this session, sync
  project-specific tracking docs when they exist (e.g. an abstraction-matrix), refresh
  documentation screenshots the session's UI changes made stale, flag
  stray/uncommitted files, commit, then produce a status summary and handoff note for
  the next chat. Do not auto-invoke on ordinary edits, do not
  trigger on the mere presence of a diff, and do not run mid-task — this is an
  end-of-session action.
---

# Session Close

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**🧹 SESSION CLOSE — closing out this session**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Print a separator line like the one above (plain repeated characters — `━`, `=`, or
`*` all work; a bold emoji-prefixed label between two rules) as the FIRST thing in the
chat response when this skill starts running, before any review/commit output. This is
plain markdown text emitted directly in the response; do not generate terminal styling
commands for it. Its job is to make the
start of a session close visually obvious in a long conversation, the same way the handoff
block at the end is visually obvious.

## Overview

Session Close closes out a work session cleanly so the next chat can start cold without
re-deriving context. It reviews what was built, brings docs in line with it, checks
for anything left uncommitted, commits, and hands back both a status summary and a
handoff note for a fresh chat.

It is the session-boundary counterpart to a mid-session code-quality review and targeted doc
sync — session-close orchestrates both plus commit and handoff, only when the user is ending the session.

## When To Activate

Explicit invocation only:

- `/session-close`
- "wrap this up", "close this out", "wrap up this chat", "get this ready for a new chat"

Do not run automatically at the end of a task, on a large diff, or because the
conversation looks finished. The user decides when the session is over.

## Paired Skills

Load these when the session calls for them; do not wait to be asked for them by name.

| Skill | Load when | Contributes |
| --- | --- | --- |
| `plan-write` | The session worked on a repository plan, or the user sends an open thread to the backlog | Syncing the plan from evidence, and creating a backlog plan |

Each row is its own optional package, so check it before loading it:

1. Check the host's skill/package manager for `<skill>` and read its availability and activation state.
2. If `available` is true, `enabled` is true, and `status` is `enabled` or `configured`, load it.
3. If it is disabled, ask: "`<skill>` is not enabled. Enable it, or skip it for this run?"
   - **Enable:** use the host's package manager to enable `<skill>` with the user's permission, then load it.
   - **Skip:** continue without it, and name it as skipped in the status summary.
4. If `enabled` and `status` disagree (`partial`, `external`), report the status, offer
   the host's package reconciliation command or skip, and never describe a drifted package as loaded.
5. If it is `missing` or `unavailable`, skip it and say so in the status summary.

## Workflow

### 1. Review the code

Scope: the files this conversation actually edited or created — the concrete set touched by
Edit/Write/NotebookEdit tool calls in this conversation. This is an enumerable set from the
conversation history, not "the working tree diff": a repo can carry pre-existing uncommitted
changes from before the session started, or from other work in progress, and those are not
in scope here even though `git diff`/`git status` can't tell them apart from session work.
If you cannot enumerate this set (e.g. picking up mid-session with no memory of earlier edits),
say so explicitly rather than guessing from the working tree.

- If a dedicated code-quality review skill exists in the current environment, load it and run
  its review loop against the scoped files. Otherwise review the scoped files directly for:
  optimizations, functionality gaps, intuitiveness/naming, project-pattern conformance.
- Apply fixes that don't change intended behavior. Leave genuinely low-risk/cosmetic items as
  notes instead of silently changing more.
- Skip this step only if there is no code diff this session (docs-only or planning
  session) — say so rather than fabricating a review.

### 2. Sync documentation

- Check for any project-specific tracking doc implied by the session's own work — e.g.
  an abstraction matrix, decision log, architecture doc, ADR directory, changelog. These
  are project-defined, not skill-defined: find them by name/convention already
  established in the repo (search for the doc, don't invent a new one) and update the
  ones this session's changes actually affect. If a dedicated doc-refresh skill exists
  in the current environment, load it; otherwise proceed without one.
- When the session worked on a repository plan under `docs/plans`, sync it with `plan-write`:
  tick only tasks the code proves done, add `## Not tested` entries for gaps the session left, and
  update `next_action`. Then run the repository's canonical plan validator for `<plan>` and report its findings.
- Do not restructure or rewrite docs wholesale. Small, targeted edits, preserving existing
  structure.
- Refresh documentation screenshots the session made stale. A screenshot is stale when the
  session changed UI it depicts, or added UI that a documented view or doc section now describes
  but no image shows. Find the repository's existing capture mechanism (a capture script,
  opt-in screenshot tests, a documented reproduce command) by searching the images' directory and
  docs; do not invent one.
  - Regenerate through that mechanism, never by hand-editing or mocking up images. Copy the
    current images aside first, compare afterward, and keep only the files that actually changed.
  - For new UI no capture covers, add a capture to the existing mechanism with deterministic
    sample data consistent with the neighbouring captures, and reference the image where the
    docs describe that UI (and in any screenshot gallery).
  - Look at every regenerated or new image before committing: it shows the intended state, in
    every theme the gallery provides, with no personal data.
  - If no capture mechanism exists or regeneration needs something unavailable (a browser,
    credentials, live data), report the stale images by path as drift not fixed.
- Report drift found but not fixed, separately from what was changed.

### 3. Check for stray or uncommitted state

Before committing, run `git status` (never `-uall`) and diff its output against the
enumerable edit set from step 1.

First, stage the files this conversation actually edited or created, plus any documentation
updates from step 2, by explicit path. This defines the candidate session commit.

After those files are staged, inspect all remaining modified, deleted, staged, and untracked
paths in `git status`:

- If a remaining code or documentation change was not touched in this session but is directly
  related to the candidate session commit, include it in the commit. Stage it by explicit path
  and say why it belongs with the session work.
- If a remaining path is unrelated to the candidate session commit, leave it unstaged and
  classify it by likely commit domain. Use concrete domains from the files and diffs, such as
  "configuration UI", "command-line behavior", or "plan documentation".
- If relatedness is ambiguous, ask before staging it. Do not guess from path names alone when
  the diff could belong to a different task.

Unrelated or ambiguous leftovers are still stray work. Flag them; don't silently include or
silently discard them:

- Untracked files that look like real work product, not scratch/build output.
- Modified/staged files this conversation did not edit — including pre-existing uncommitted
  work that predates this session. Report these by path; never assume they're safe to ignore
  or safe to include.
- Existing stashes.

Determine how many commits worth of unrelated code remain outstanding. Finish the normal
session-close deliverables, then ask whether the user wants those leftovers committed too. The
question must articulate the proposed commit domain(s). If multiple proposed commits remain,
offer exactly these choices: commit the separate commits, commit them all together, or do
nothing and wait for instruction.

### 4. Commit

- Commit exactly the staged candidate set from steps 1-3. Never blanket `git add -A`/`git add .`,
  and never stage a file flagged as unrelated stray work in step 3.
- Commit message: standard repository commit conventions (see local contributor guidance) —
  summarize the *why* pulled from the session's own goal, not just a
  diff restatement. If the session covered multiple unrelated changes, say so and
  either split into multiple commits or ask which grouping the user wants.
- Do not push. Committing is as far as this skill goes unless the user separately asks
  to push.
- If there's nothing to commit (step 1/2 made no changes and nothing was already
  staged), skip the commit and say so.

### 5. Status + handoff prompt

Do not skip this step even if steps 1-4 found nothing to change — it's the actual
deliverable of a session close.

- Scan the session for open threads: explicit TODOs left in code/docs, questions the
  user deferred, follow-ups mentioned but not started, or the next unstarted step in
  an agreed plan.
- Classify open threads before writing the handoff:
  - **Must-fix / clear continuation:** concrete bugs, incomplete promised work, validation
    blockers, or follow-ups the user clearly asked to continue. These always go in the
    handoff prompt when one is produced.
  - **Ambiguous priority / maybe-later:** ideas, optional polish, speculative improvements,
    or deferred questions where the user has not committed to continuing.
- After committing but before writing the handoff prompt, review the open-thread list:
  - Add every must-fix / clear continuation item to the handoff note.
  - For ambiguous priority items, ask the user what to do with each item before including it.
    Offer exactly these choices: **include details in the handoff note**, **add it to the
    backlog as a new task**, or **forget about it**.
  - If the user chooses backlog, load `plan-write` and create a backlog plan for that issue
    before committing. Stage that plan with the same session commit, not a separate
    follow-up commit. Include the new plan path in the status summary.
  - If the user chooses forget, omit it from the handoff and do not create a plan.
  - After handling each selected option, complete with the normal handoff/status response;
    do not stop at the prompt.
- If nothing is outstanding, say so plainly rather than inventing a next step.
- Produce a short status summary (for the chat, not the pasted prompt): what shipped
  this session, what's still open.

**Skip the handoff note when there's nothing to hand off.** If the scan finds no open
work — no tasks left in a plan doc, no deferred questions, no unstarted follow-ups —
state that the session is fully closed and stop there. Do not generate the handoff
block (or its header/footer rule) in this case; a handoff note implies there is
a next task to run, and producing one anyway invents work that doesn't exist.

**The handoff note.** Only produced when step 5's scan found real open work. Give
the next chat enough standalone context to pick up
cold: repo + branch, what's next, and any constraint the user stated. When the session worked on a
repository plan, the note also names:

- the plan's repository-relative path and stable `id`;
- the current objective and the remaining tasks;
- the next action and any blockers;
- the relevant files;
- the verification already run, and the plan's open `## Not tested` entries;
- an instruction to re-check repository state rather than trusting the handoff blindly.

Do not copy the whole plan into the note; point at it. Then apply these filters to what you include:

- **Scope done-work to the next step's needs.** Only describe work completed this
  session when the next task actually depends on that context (a decision it must not
  re-litigate, an interface it will build on, a gotcha it will hit). If a piece of
  finished work is unrelated to what comes next, leave it out — the handoff is a runway
  for the next task, not a changelog of this one. When in doubt, prefer the shorter note.
- **Never reference commits or push state.** Do not name commit hashes, describe the
  local-vs-pushed commit situation, or tell the next chat to push. The user manages
  their own git history; the handoff is about work content, not VCS bookkeeping.
- **Do describe uncommitted/outstanding work** that the next chat needs to know exists
  (open plan items, a half-built feature, a deferred decision) — as work, by what it is
  and where it lives, without framing it in terms of commits.

**Rendering.** Write handoff headers directly as markdown. Do not generate shell
commands or terminal color-control sequences to style chat output. Some chat surfaces
render tool output as plain logs, so terminal styling can appear as unreadable control
text. Markdown headers, bold text, and plain rule characters render consistently.

The handoff body goes in one fenced code block so the copy button grabs exactly the
handoff text and nothing else. Put a plain markdown header directly above the block and
a matching rule directly below it. The header/footer are delimiters only; the copyable
content is the fenced body between them.

## What Session Close Must Not Do

- Do not run unless explicitly invoked.
- Do not push commits or open PRs — commit only, unless asked.
- Do not blanket-stage (`-A`/`.`) — name files.
- Do not invent a next step when none exists; say the session is fully closed instead.
- Do not restructure docs beyond the targeted updates the session's changes call for.
- Do not skip the review step silently — if skipped, say why.

## Risk Checkpoints

Take extra care, and say what to double-check, when the session's changes touched:
authentication; authorization/ownership/admin; database schema and migrations; API
behavior and mutations; environment variables and deployment config; file uploads and
storage; external integrations. Call these out in both the review step and the commit
message.
