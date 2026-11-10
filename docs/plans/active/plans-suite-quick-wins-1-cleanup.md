---
id: vzgsx5vz
next_action: Run /plan-execute and begin with guarded fetch and GitHub delivery operations.
blocked_by: []
depends_on: []
related: ["i5mnkm7z", "46qth5z8", "w7vls1yk", "permva27", "pvgx8oh7"]
reviewed_commit: 7ab4c5c96b8db028e58d7375b5e23838f805b05f
worktree: plans-suite-quick-wins-1-cleanup
---

# Clear agent friction: permissions, rule conflicts, and stale docs

## Summary

Agents working through the plan suite stop for permission prompts on steps the skills already
require, follow rules that contradict the skills, and report in formats that bury the result. The
user docs also describe behavior that has changed. This plan removes those frictions with changes
to rule text, skill text, the permissions manifest, and docs. It adds a rule for delivering
finished work through a pull request and records the repository owner's steps for requiring CI.

The follow-up, Deliver finished plans as a watched pull request (`i5mnkm7z`), applies its own
delivery sequence to implementation plans.

## Goals

- Routine workflow steps can run without a command prompt where the provider supports it. Archive
  and close retain their approval gates.
- Rules and skills agree on creating worktrees and on how to enter one.
- A plan skill's closing report leads with the outcome and the next step, and leaves out what the
  reader does not need, using qualitative rules rather than a word limit.
- User docs match the package's seven skills and the portal's real lead buttons.
- Finished work covered by the delivery rule ends in an open pull request with a reported CI result.
- GitHub blocks an ordinary merge when any required check is failing or pending. The owner
  retains the bypass needed to publish plan lifecycle commits.

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

`manifests/inventory/agent-permissions.json` supplies the default permission buckets. The first
two rows support the delivery follow-up. The third covers the existing plan suite.

| Command | Manifest behavior |
| --- | --- |
| `gh pr edit`, `gh pr ready` | `ask` through `post-to-github` |
| `gh run rerun`, `git fetch` | Provider default |
| The plan lifecycle commands under Proposed design | Provider default. The existing `inspect-install` behavior already allows `plans validate` and `plans repair` |

The primary checkout's local Claude settings already allow `roborepo plans *`. Test defaults in
a clean fixture without this override. The buckets are machine-wide defaults. Their effects
depend on the provider and do not grant network or credential access.

### Rule conflicts

| Rule | Says | Conflicts with |
| --- | --- | --- |
| `globals/system/rules/shared/06-branch-safety.md`, `globals/packages/branch-safety/rules.md` | Never create a branch or worktree without asking | `plan-execute/SKILL.md` Preflight resolves new worktrees under `worktreeRoot` "without asking"; it confirms only the folder, once per repo |
| `globals/system/rules/claude/90-claude-specific.md` | Enter a worktree with `change_directory` | `46qth5z8` records that `change_directory` re-files the whole session under the worktree in the desktop sidebar, and that `EnterWorktree({ path })` does not |
| `plan-execute/SKILL.md` | Launch procedural subagents with `model: sonnet` | The shared skill names a Claude model. `scripts/test/plan-suite-skills-check.mjs` asserts the wording |

The linked Claude plan records the sidebar behavior from earlier sessions. The current rule
still directs agents to `change_directory`. The effect of the proposed wording needs a fresh
Claude desktop session after installation.

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

The repository's active `no-push-to-main` ruleset (26185384) requires a pull request and one
approval. `protect-main` (25203565) blocks deletion and non-fast-forward updates. Neither ruleset
lists required status checks. The available GitHub session could read the rules but could not
authenticate as the owner to verify bypass actors. GitHub only returns that field to actors with
write access to the ruleset. The CI workflow runs on pull requests without a path filter and
defines Linux, macOS, and Windows installer jobs.

## Related plans

| Plan | Relationship to this work |
| --- | --- |
| Deliver finished plans as a watched pull request (`i5mnkm7z`) | Unlanded downstream dependency. It owns draft, review, and readiness behavior for plan PRs. Its implementation must use the command forms agreed here. |
| Keep local agent work within useful boundaries for Claude (`46qth5z8`) | Plan-versus-code conflict. Its draft says the new rule already names `EnterWorktree`. The source still says `change_directory`. This plan owns the rule and live smoke check. The other plan owns the fallback hook and provider changes. |
| GitHub Integration Part 01 (`w7vls1yk`) | Unlanded follow-up. It owns bot identity and any identity-scoped access to `gh api`. Its ruleset snapshot assumes these required checks already exist and lists zero approvals. The live ruleset showed one approval and no required checks. Preserve its existing review settings during this change. |
| Audit Global Agent Permissions Management (`permva27`) | Unlanded audit, independent of this change. It can assess these defaults and their provider coverage when it runs. |
| Store plans on a dedicated Git branch (`pvgx8oh7`) | Ready, implementation unlanded. It owns plan storage, lifecycle commit placement, and synchronization. Reconcile the allowlist with its guarded operations when it lands. |
| A Repeatable Plan Lifecycle from Preparation Through Verified Delivery | Landed foundation in `c29a7f18`. Promotion and other lifecycle moves still commit from the primary checkout on the base branch. This plan changes the skills' output and permission defaults. |
| Keep Main Green and Let CI Run the Full Gate | Landed foundation in `727cb5bb`. Keep its split between local scoped checks and CI. Required status checks enforce that existing workflow for ordinary merges. |

The delivery, Claude, and permissions-audit plans record baseline revisions that are ancestors
of this checkout. The source still has the behavior those three backlog plans propose to change.

## Proposed design

### Permissions

Give the delivery workflow named RoboRepo operations with validated inputs and fixed subprocess
arguments. Keep raw `git fetch`, `gh pr edit`, `gh pr ready`, and `gh run rerun` under their current
permission policy. Add the guarded entry points to the manifest by command name. Reuse the
repository's Git process runner and remote-refresh logic where they preserve the restrictions
below. Keep GitHub validation with the guarded operations. Run Git and GitHub CLI commands with
argument arrays and no shell. The lifecycle CLI continues to own its transition checks.

| Behavior | Intended operation |
| --- | --- |
| Pull requests and CI | Resolve the PR from the current feature branch and configured GitHub repository. Check that the PR head is the branch and pushed commit being delivered. Permit body updates and marking that PR ready. For a retry, verify the run belongs to that head and rerun failed jobs only. |
| Fetch | Refresh the configured remote's tracking refs. Use a destination restricted to its namespace under `refs/remotes/` and disable configured ref mappings that could target local branches. Accept a configured remote name and refuse caller-supplied URLs, options, and refspecs. |
| Plan lifecycle | `preflight`, `approval`, `merge-readiness`, `landed`, `order place`, `sync-base`, `stop-servers`, `promote`, `start`, `submit`, and `reopen` |

`order place` changes backlog ordering. `sync-base` merges into the linked worktree, and
`stop-servers` can stop matching Runtime processes after landing. Keep their existing guards.
Keep archive, close, worktree creation, and raw merge outside the new allows. Preserve the
denials for PR merge, direct GitHub API calls, and force-push. Document provider support where the
same permission bucket projects differently. On guard refusal, report the mismatched target or
disallowed operation. A command prompt remains available for separately authorized raw commands.

### Rules

Branch safety, in both copies, gains one exception:

> Invoking a workflow that explicitly creates its own worktree, such as `/plan-execute`, authorizes
> that worktree under the workflow's directory policy. Follow the selected delivery procedure for
> other work and retain the harness approval for worktree creation or checkout changes.

When eligible work starts on the default branch, request approval to run `git switch -c <branch>`.
Before switching, confirm the branch name is unused and check that the proposed PR will contain
only the intended commits. If unrelated local base commits would ride along, report the mismatch
before publishing. The switch carries existing edits in place. Stage only the intended changes
and leave the primary checkout on the feature branch. Tell the user which branch is checked out
and that the base branch must be checked out again before plan lifecycle transitions.

The Claude rule becomes:

> In the desktop app, enter a linked worktree of this repo with `EnterWorktree({ path })`.
> `change_directory` re-files the whole session under the worktree, and `request_directory` alone
> leaves the session in the old folder, where edits still prompt.

A new fragment, `globals/system/rules/shared/09-deliver-finished-work.md`, holds the delivery rule:

> When requested work is finished and its checks pass, stage only the paths or hunks from that
> work and commit them on a feature branch. Confirm the target, push the branch, open or update
> its pull request with a written body, and follow CI at the pushed head. Fix failures attributable
> to the change or report the blocker. The user merges. Skip delivery for unfinished experiments,
> when the user asks to keep work local, when the repository has no remote, or when the active
> skill defines its own delivery rule. If the push is refused, report the exact command and reason.

### Model wording

`plan-execute/SKILL.md` becomes "Launch them on a cheaper model where the harness offers a
choice." The pinned string in `plan-suite-skills-check.mjs` changes with it.

### Reports

`/plan-review`, `/plan-close`, and `/plan-archive` adopt the principles `final-report.md` already
applies:

- Lead with one line naming the plan and its outcome, then the next command.
- Print a status field only when it departs from the expected result or the reader must act on it.
- Show evidence through `feature-verification` where it applies, without restating it.
- Leave out passing gates, commit ids, and Git status unless one is the point of an exception.
- Point at the plan document for the full record.

Each skill states these rules because `response-output` is optional. Keep the approval question
and exact commit in `/plan-review`, and the reason for each refusal in `/plan-close`.

### Required CI

The repository owner updates `no-push-to-main` (26185384) in GitHub. Confirm the owner has an
Always allow bypass before adding required checks. If the bypass is missing or differs, report
the setting and ask the owner before changing the ruleset. Preserve the existing pull request
review settings. Apply the following settings to the same ruleset.

| Setting | Value |
| --- | --- |
| Required checks | `check (ubuntu-latest)`, `check (macos-latest)`, `windows-installer` |
| Require branches to be up to date | Off |

Choose the check names from a recent run on this repository. After saving, verify that a failing
or pending required check blocks the ordinary merge path and confirm the owner's bypass from
the settings. Use the owner's next already-authorized lifecycle push to confirm direct push
behavior. [GitHub ruleset configuration](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
and [bypass-list visibility](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset)
describe the distinction between ordinary merges and owner access.

## Implementation plan

- [ ] Implement the guarded operations and test them with disposable Git repositories and a
      fake GitHub CLI. Cover successful operations and refusals before changing permission defaults.
- [ ] Update `manifests/inventory/agent-permissions.json` with the guarded command entries and
      named plan lifecycle entries. Add targeted assertions for the affected providers and
      regenerate with `node scripts/build/render-agent-permissions.mjs`. Document the command
      forms for the delivery follow-up.
- [ ] Update both branch-safety rule copies and the Claude desktop rule. Keep the plan-execute
      folder confirmation and the normal approval for moving a checkout.
- [ ] Add `09-deliver-finished-work.md` to the shared rule fragments and the required-source
      checklist in `manifests/platform/source-files.tsv`. The rule renderer discovers the
      fragment by directory. Regenerate with `bash scripts/build/render-rules.sh`.
- [ ] Update the validator model wording in `plan-execute/SKILL.md`. Rewrite the Final Report
      sections of plan-review, plan-close, and plan-archive. Update the affected assertions in
      `scripts/test/plan-suite-skills-check.mjs`.
- [ ] Correct the docs under Documentation impact. Check the complete lead-button and action
      tables against the portal and the lifecycle manifest, including the active and review rows.
- [ ] Give the owner the required-check settings and smoke checks under Needs you. After the owner
      confirms the GitHub change, read the rules with
      `gh ruleset view 26185384 --repo kirinmurphy/roborepo-alpha` and record what was verified.

## Validation

- Run `node scripts/test/plan-suite-skills-check.mjs` for the report requirements, portable
  validator wording, and retained review and close safeguards.
- Test that guarded fetch updates tracking refs and leaves local branches intact, including when
  a configured ref mapping would otherwise target a local branch. Test rejection of extra options,
  caller-supplied refspecs, PRs from another branch or repository, and runs for an outdated head.
- Check the delivery rule with a clean base, with unrelated edits, and with unpublished base
  commits. The normal case switches to a feature branch. Only intended changes reach the PR,
  and delivery pauses if unrelated base commits would be included.
- Run `node scripts/build/render-agent-permissions.mjs --check` and
  `bash scripts/build/render-rules.sh --check`. Assert the selected operations in the provider
  projections, plus the unchanged raw command policy and the retained protections for PR merge,
  direct GitHub API, and force-push.
  Check the real provider behavior where a generated entry alone does not establish enforcement.
- Run `node scripts/test/docs-reference-check.mjs`. Review current package counts and portal
  actions in the affected guides, while preserving the historical six-package account.
- Run `bash scripts/doctor.sh --quiet` and `git diff --check`. CI runs the full gate for the
  implementation pull request.

## Not tested

- [ ] The owner verifies all three required checks, ordinary merge blocking, and the admin
      bypass on the next authorized lifecycle push.
- [ ] In a fresh Claude desktop session after `roborepo update`, enter an existing linked
      worktree with `EnterWorktree({ path })`. Confirm the session stays filed under the primary
      checkout and edits proceed without per-file folder prompts.

## Documentation impact

| Doc | Update |
| --- | --- |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | Seven commands and the lead-button and action tables |
| `docs/user/reference/plans-portal.md`, `docs/user/reference/config-control-panel.md`, `docs/user/guides/setup-and-daily-use.md`, `docs/internal/plans-portal-internals.md` | Seven commands |
| `docs/user/reference/config-control-panel.md` | The behavior buckets and the provider-specific limits on prompt suppression |
| `docs/internal/rules-parity-and-layering.md` | The shared delivery fragment and when a skill's delivery rules take precedence |
| `docs/internal/testing.md` | The repository's required checks and the owner's verification procedure |
| `docs/user/reference/roborepo-cli.md` | The guarded delivery commands and their target restrictions |

## Risks

| Risk | Mitigation |
| --- | --- |
| A flaky macOS run blocks a merge | Rerun failed jobs for the same head when the failure appears infrastructural |
| The delivery rule pushes something the user wanted to keep local | It covers only finished work the user asked for, and yields to "don't push", which the user can say at any time |
| `EnterWorktree` behaves differently from what `46qth5z8` observed in October | Tracked under `## Not tested`; if agents still misfile sessions, the hook in that plan returns as the fallback |
| Permission defaults affect other repositories | Test both the agreed command forms and the retained guards for broader operations |

## Decisions

- **Default branch delivery.** Switch to a new feature branch in the primary checkout after
  checkout approval. Report the resulting branch so the user can return to the base branch
  before running plan lifecycle transitions.
- **Permission scope.** Allow only the guarded fetch and GitHub operations described above.
  Preserve existing prompts and default handling for the raw commands.
