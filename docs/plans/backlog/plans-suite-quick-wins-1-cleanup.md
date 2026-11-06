---
id: vzgsx5vz
next_action: Run /plan-promote, settling how delivery leaves the default branch (Open questions) before implementation.
blocked_by: []
depends_on: []
related: ["i5mnkm7z", "46qth5z8", "w7vls1yk", "permva27", "pvgx8oh7"]
reviewed_commit: 7ab4c5c96b8db028e58d7375b5e23838f805b05f
worktree:
---

# Clear agent friction: permissions, rule conflicts, and stale docs

## Summary

Agents working through the plan suite stop for permission prompts on steps the skills already
require, follow rules that contradict the skills, and report in formats that bury the result. The
user docs also describe behavior that has changed. This plan removes those frictions with changes
to rule text, skill text, the permissions manifest, and docs. It adds a rule that finished work
gets delivered as a pull request, and has the user require CI on the repo's merge ruleset.

It is the first of two plans. Deliver finished plans as a watched pull request (`i5mnkm7z`) builds
on the permissions and the delivery rule here.

## Goals

- Commands the plan skills run as fixed steps no longer prompt, apart from `archive` and `close`.
- Rules and skills agree on creating worktrees and on how to enter one.
- A plan skill's closing report leads with the outcome and the next step, and leaves out what the
  reader does not need, using qualitative rules rather than a word limit.
- User docs match the package's seven skills and the portal's real lead buttons.
- Finished work outside plans ends in an open pull request whose CI was watched.
- A pull request in this repo cannot merge through the normal button with a failing check.

## Non-goals

- Lifecycle file moves, which branch lifecycle commits land on, and who pushes the base branch.
  Store plans on a dedicated Git branch (`pvgx8oh7`) owns those.
- `/session-close`. It keeps its no-push rule, which the delivery rule yields to.
- Allowing `git worktree add`. The user is present when a plan starts, and an allow would apply to
  every session. Revisit it with any scheduled job.
- Allowing raw `git merge`. `/plan-review` synchronizes through `roborepo plans sync-base`, and the
  push guard does not cover merges into a local base branch.
- The worktree-entry hook in `46qth5z8`, which this plan's rule change is expected to make
  unnecessary.

## Current state

Skill paths such as `plan-execute/SKILL.md` are under `globals/packages/plan-suite/skills/`.

### Permissions

`manifests/inventory/agent-permissions.json` renders into each harness's settings. These commands
are fixed steps in the plan skills but are not in the `allow` bucket:

| Command | Today | Bucket or behavior |
| --- | --- | --- |
| `gh pr edit`, `gh pr ready` | Prompts | `ask`, `post-to-github` |
| `gh run rerun` | Prompts by default | In no behavior |
| `git fetch` | Prompts by default | In no behavior |
| `roborepo plans` `preflight`, `approval`, `merge-readiness`, `landed`, `order`, `sync-base`, `stop-servers`, `promote`, `start`, `submit`, `reopen` | Prompts by default | In no behavior; `inspect-install` allows only `validate` and `repair` |

This repo's own `.claude/settings.local.json` allows `roborepo plans *`, so the prompts show up in
other repos and in worktrees without that file.

### Rule conflicts

| Rule | Says | Conflicts with |
| --- | --- | --- |
| `globals/system/rules/shared/06-branch-safety.md`, `globals/packages/branch-safety/rules.md` | Never create a branch or worktree without asking | `plan-execute/SKILL.md` Preflight resolves new worktrees under `worktreeRoot` "without asking"; it confirms only the folder, once per repo |
| `globals/system/rules/claude/90-claude-specific.md` | Enter a worktree with `change_directory` | `46qth5z8` records that `change_directory` re-files the whole session under the worktree in the desktop sidebar, and that `EnterWorktree({ path })` does not |
| `plan-execute/SKILL.md:406` | Launch procedural subagents with `model: sonnet` | The skill runs on every harness; that model name is Claude-specific. `scripts/test/plan-suite-skills-check.mjs:225` pins the text |

The `change_directory` rule first appears at its current path on October 30, after the October 7–15
sessions `46qth5z8` draws its evidence from, so that plan never tested correcting the instruction.

### Reports

`plan-execute/references/final-report.md` already follows outcome-first rules: a one-line headline,
tables only for what changed, what needs the reader, and a "What to leave out" list. `/plan-review`,
`/plan-close`, and `/plan-archive` each print a fixed block of status fields followed by "also
report" lists of evidence and Git status, whatever the outcome.

### Docs

| Doc | Stale claim | What is true |
| --- | --- | --- |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | Active plans lead with **Review**, **Update**, or **Continue** | `recommendedPlanCommand` in `portal/plans/plan-actions.js` returns nothing for an active plan; those actions are menu-only, as `docs/user/reference/plans-portal.md` already says |
| `plan-suite.md`, `docs/user/reference/plans-portal.md`, `docs/user/reference/config-control-panel.md`, `docs/user/guides/setup-and-daily-use.md`, `docs/internal/plans-portal-internals.md` | Six plan commands or skills | `globals/packages/plan-suite/skills/` holds seven; `/plan-suite-init` is the one left out |

The sentence in `plan-suite.md` saying the commands "were once six packages" is history and stays
true. The count of what the update installs does not.

### Merge protection

`kirinmurphy/roborepo-alpha` has two rulesets. `no-push-to-main` (id `26185384`) requires a pull
request and lets the repository admin bypass it. `protect-main` (id `25203565`) cannot be bypassed.
Neither requires a status check, and pull request #59 merged with `check (macos-latest)` failing.
`.github/workflows/ci.yml` has no path filter, so a required check still reports on docs-only pull
requests.

## Proposed design

### Permissions

Add three behaviors in the `allow` bucket, and take `gh pr edit` and `gh pr ready` out of
`post-to-github`:

| Behavior | Commands | Why it is safe to allow |
| --- | --- | --- |
| `manage-own-pull-requests` | `gh pr edit`, `gh pr ready`, `gh run rerun` | None changes a branch's contents; `gh pr merge` stays denied |
| `fetch-from-remote` | `git fetch` | Updates remote-tracking refs only |
| `run-plan-lifecycle` | The `roborepo plans` commands in the table above | Each is a read, or a local commit or merge guarded by its own validator. `archive` and `close` keep prompting because they retire a plan or remove a worktree |

### Rules

Branch safety, in both copies, gains one exception:

> A command whose workflow creates a worktree, such as `/plan-execute`, counts as asking. So does
> delivering finished work from the default branch under Deliver Finished Work.

The Claude rule becomes:

> In the desktop app, enter a linked worktree of this repo with `EnterWorktree({ path })`.
> `change_directory` re-files the whole session under the worktree, and `request_directory` alone
> leaves the session in the old folder, where edits still prompt.

A new fragment, `globals/system/rules/shared/09-deliver-finished-work.md`, holds the delivery rule:

> When work the user asked for is finished and its checks passed, deliver it: commit the paths you
> changed, push, open a pull request with a written body, watch CI to its result, and fix what
> fails. The user merges. Skip this for unfinished experiments, when told not to push, when the repo
> has no remote, or when a skill sets its own rule. When a push is refused, report the exact command
> instead of working around it.

### Model wording

`plan-execute/SKILL.md:406` becomes "Launch them on a cheaper model where the harness offers a
choice." The pinned string in `plan-suite-skills-check.mjs` changes with it.

### Reports

`/plan-review`, `/plan-close`, and `/plan-archive` adopt the principles `final-report.md` already
applies:

- Lead with one line naming the plan and its outcome, then the next command.
- Print a status field only when it departs from the expected result or the reader must act on it.
- Show evidence through `feature-verification` where it applies, without restating it.
- Leave out passing gates, commit ids, and Git status unless one is the point of an exception.
- Point at the plan document for the full record.

There is no word or character limit. Each skill states these rules itself because `response-output`
is an optional package. Required content that protects a decision stays: `/plan-review`'s approval
question and exact commit, and `/plan-close`'s refusal reasons.

### Required CI

Agents cannot change rulesets, so this step is the user's. It is tracked under `## Not tested`, which
keeps `/plan-close` from finishing until the user confirms it.

Add a "require status checks" rule to `no-push-to-main`, leaving the admin bypass in place:

| Setting | Value | Why |
| --- | --- | --- |
| Required checks | `check (ubuntu-latest)`, `check (macos-latest)`, `windows-installer` | The three real checks on pull request #59 |
| Require branches to be up to date | Off | CI already runs on the merge of head and base, and an extra requirement forces a rerun whenever base moves |

Do not add it to `protect-main`. That ruleset has no bypass, so direct pushes to `main` would likely
be rejected, based on GitHub's documented behavior rather than a test here.

## Implementation plan

- [ ] Add the `manage-own-pull-requests`, `fetch-from-remote`, and `run-plan-lifecycle` behaviors,
      remove `gh pr edit` and `gh pr ready` from `post-to-github`, and run
      `node scripts/build/render-agent-permissions.mjs`.
- [ ] Update both branch-safety copies and `90-claude-specific.md`.
- [ ] Add `09-deliver-finished-work.md`, register it in `manifests/platform/source-files.tsv`, and
      run `scripts/build/render-rules.sh`.
- [ ] Change the model wording in `plan-execute/SKILL.md` and its pin.
- [ ] Rewrite the Final Report sections of `/plan-review`, `/plan-close`, and `/plan-archive`, and
      update any pins in `plan-suite-skills-check.mjs` that name their old fields.
- [ ] Correct the docs in the table above.
- [ ] Report the required-checks step under Needs you, with the settings above.
- [ ] After the user confirms it, read the result with
      `gh ruleset view 26185384 --repo kirinmurphy/roborepo-alpha` and record it in the plan.

## Validation

- `node scripts/test/plan-suite-skills-check.mjs` passes with the updated pins.
- `node scripts/build/render-agent-permissions.mjs --check` and `scripts/build/render-rules.sh
  --check` pass, and `generated/claude/settings.json` lists the moved commands under `allow`.
- `gh pr merge`, `gh api`, and `git push --force` remain denied in every generated permissions file.
- A search of `docs/` outside `docs/plans/` finds no current-tense claim of six plan commands.
- `bash scripts/doctor.sh --quiet` passes. CI runs the full gate, because this changes generated
  outputs and permissions.

## Not tested

- [ ] `no-push-to-main` requires `check (ubuntu-latest)`, `check (macos-latest)`, and
      `windows-installer`. Agents cannot change rulesets; confirm it after making the change, and
      that a direct push to `main` still works through the admin bypass.
- [ ] After the rule change, a Claude desktop session entering a worktree uses `EnterWorktree`, stays
      filed under the main checkout, and edits in the worktree without per-file prompts. It needs a
      live session started after `roborepo update`, which no test can provide.

## Documentation impact

| Doc | Update |
| --- | --- |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | Seven commands; the active row of the lead-button table |
| `docs/user/reference/plans-portal.md`, `docs/user/reference/config-control-panel.md`, `docs/user/guides/setup-and-daily-use.md`, `docs/internal/plans-portal-internals.md` | Seven commands |
| `docs/user/reference/config-control-panel.md` | The new permission behaviors, if it lists them when the work reaches it |

## Risks

| Risk | Mitigation |
| --- | --- |
| A flaky macOS run blocks a merge | Rerun it, which `gh run rerun` now allows without a prompt, or use the admin bypass |
| The delivery rule pushes something the user wanted to keep local | It covers only finished work the user asked for, and yields to "don't push", which the user can say at any time |
| `EnterWorktree` behaves differently from what `46qth5z8` observed in October | Tracked under `## Not tested`; if agents still misfile sessions, the hook in that plan returns as the fallback |
| Permission allows are repo-wide, not plan-scoped | Each allowed command is already a fixed skill step, and destructive forms stay denied |

## Open questions

1. **How does delivery leave the default branch?** Finished work on `main` needs a feature branch,
   and agents cannot get back: `occupy-main` denies switching to `main`.
   - **(a) `git switch -c <branch>` and say so.** Keeps uncommitted edits and takes one prompt, but
     leaves the checkout off `main` until the user returns it. `/plan-execute` start transitions
     refuse a primary checkout that is off the base branch.
   - **(b) Move the work to a new worktree.** Leaves the checkout on `main`, but carrying uncommitted
     edits across is more steps and a new way to lose work.
   - **Recommendation:** (a). It is the simpler and safer move, and the report tells the user the
     checkout moved.
