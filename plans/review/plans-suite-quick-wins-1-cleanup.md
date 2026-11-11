---
id: vzgsx5vz
next_action: Run /plan-review on the submitted implementation.
blocked_by: []
depends_on: []
related: ["i5mnkm7z", "46qth5z8", "w7vls1yk", "permva27", "pvgx8oh7", "3xh2sq32"]
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

- [x] Implement the guarded operations and test them with disposable Git repositories and a
      fake GitHub CLI. Cover successful operations and refusals before changing permission defaults.
- [x] Update `manifests/inventory/agent-permissions.json` with the guarded command entries and
      named plan lifecycle entries. Add targeted assertions for the affected providers and
      regenerate with `node scripts/build/render-agent-permissions.mjs`. Document the command
      forms for the delivery follow-up.
- [x] Update both branch-safety rule copies and the Claude desktop rule. Keep the plan-execute
      folder confirmation and the normal approval for moving a checkout.
- [x] Add `09-deliver-finished-work.md` to the shared rule fragments and the required-source
      checklist in `manifests/platform/source-files.tsv`. The rule renderer discovers the
      fragment by directory. Regenerate with `bash scripts/build/render-rules.sh`.
- [x] Update the validator model wording in `plan-execute/SKILL.md`. Rewrite the Final Report
      sections of plan-review, plan-close, and plan-archive. Update the affected assertions in
      `scripts/test/plan-suite-skills-check.mjs`.
- [x] Correct the docs under Documentation impact. Check the complete lead-button and action
      tables against the portal and the lifecycle manifest, including the active and review rows.
- [x] Give the owner the required-check settings and smoke checks under Needs you. Owner configuration and read-back remain
      under Not tested until the owner confirms the change.

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

- [ ] Mark a draft PR ready with `roborepo delivery pr-ready`, and rerun a real failed CI run
      with `roborepo delivery retry-ci <run-id>`. Live `fetch`, `pr-body`, and the `retry-ci`
      refusal for an in-progress run passed against PR 63 (see Verification). The session's
      permission check refused a live `pr-ready` call, and PR 63 is not a draft and has no
      failed run. Live command-prompt suppression in Claude and Gemini is also still unverified.
- [ ] In a Claude desktop session in the default permission mode, enter an existing linked
      worktree with `EnterWorktree({ path })` and confirm edits there proceed without per-file
      folder prompts. On 2026-11-11 a session in auto mode entered this plan's worktree that way.
      The app still filed it under the primary checkout (`cwd` unchanged in session metadata),
      and its edits ran without prompts. Auto mode alone may explain the missing prompts, though.

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

## Decision Log

- Selected `roborepo delivery fetch|pr-body|pr-ready|retry-ci` as the guarded command forms.
  A separate namespace avoids inheriting the existing broad read-only `roborepo git` permission.
  Using raw Git and GitHub CLI commands would expand the defaults beyond the agreed guards.
- Used the existing hardened Git runner and network timeout. Fetch uses an explicit tracking
  destination, an empty refmap, and disabled tag and prune behavior to preserve local branches
  and tags even when configured fetch mappings target local branches.
- PR body input is a UTF-8 file. Its content is passed to GitHub CLI through standard input.
  This preserves multiline text and keeps it out of shell interpretation and option parsing.
- GitHub delivery resolves the configured upstream, verifies matching fetch and push repository
  identities over HTTPS or SSH, excludes the default branch, and validates the published PR
  head. It refuses fork PRs and ambiguous PR matches. Retry is limited to completed failed runs
  at that branch and commit.
- No GitHub ruleset was changed. The owner must confirm Always allow bypass access first.
  Public read-back lists one required PR approval and no required status checks. The CLI's
  public “cannot be bypassed” display does not establish owner-only bypass visibility.
- Procedural rule and doc edits used subagents with the current session model. The named
  Claude-only cheaper model was unavailable in this harness. The shared wording is now portable.

- Resolved: the earlier EPERM verification blocker came from the previous session's sandbox.
  A Claude session on 2026-11-11 removed disposable directories normally, and every blocked
  scoped check and the full gate then ran (see Verification).
- `plan-store-commands` on main already allows `preflight`, `approval`, `merge-readiness`,
  `landed`, `order`, `promote`, `start`, `submit`, `reopen`, `close`, and `archive`, so the new
  `plan-lifecycle` behavior adds only `sync-base` and `stop-servers`. Archive and close keep their
  approval gates inside the skills, not as command prompts; the existing allow was left as is.
- The shared delivery rule keeps generic wording (refresh tracking refs, open or update the PR)
  rather than naming `roborepo delivery fetch|pr-body|pr-ready`. Alternative: name the guarded
  commands now so agents avoid raw-command prompts. Kept generic because the plan's Proposed design
  fixes the rule's wording and assigns the command forms to the delivery follow-up (`i5mnkm7z`),
  and the guarded commands are GitHub-only while the rule applies to any remote.
- User decision (2026-11-11): Windows verification of the GitHub delivery commands is deferred
  to Windows Test Environment and Behavior Parity (`l1mz96d9`), which collects Windows checks.
  A task there now covers it, so it is no longer a Not tested entry here.
- User decision (2026-11-11): applying and verifying the required checks moves to "Protect a
  repo's plans and main branches on GitHub from one command" (`3xh2sq32`). Its `roborepo protect`
  creates managed rulesets with the three required checks, 1 approval, and the admin bypass, and its
  manual checks cover merge blocking and the bypass. The manual procedure in
  `docs/internal/testing.md` stays until that command replaces it. The owner ruleset entry is
  therefore no longer a Not tested entry or Open Question here.

## Open Questions

- None. The owner ruleset question moved to `3xh2sq32`; see Decision Log.

## Review

### Findings

- [x] Recheck upstream configuration before a GitHub mutation — fixed (a7b7977c). The first independent validator
      reproduced changing the remote during PR discovery, followed by a mutation on the old
      target. Fix compares a fresh local delivery target, including upstream remote, merge ref,
      fetch URL, and push URL, and adds four refusal regressions. All operation assertions
      completed after the fix, followed by the same EPERM cleanup blocker.
- [x] Pass line printed before the new projection assertions in
      `codex-command-permission-check.mjs` — fixed (d9bb970d)
- [x] Stale plan record: EPERM Not tested entry, EPERM Open Question, `next_action`, superseded
      gate results, and the pre-existing lifecycle allows — fixed in this plan update
- [x] `plan-suite.md` named a nonexistent **Copy Document Filename** menu item — renamed to
      **Copy file path**, the portal's label (2cf0dd68)
- [x] Claude and Gemini default-projection assertions lived in a Codex-named check — moved to
      `agent-permission-defaults-check.mjs` and registered in `check-groups.json` (2cf0dd68)
- [x] Stale Verification lines (five Not tested advisories, live characterization EPERM) —
      marked superseded in this plan update
- [x] The delivery rule does not name the guarded `roborepo delivery` commands — kept as
      designed; see Decision Log

### Verification

- Live GitHub (2026-11-11, PR 63 at 2cf0dd68, authenticated `gh`): `roborepo delivery fetch
  origin` refreshed `refs/remotes/origin/*`. `pr-body` rewrote the PR's empty body with the same
  empty content, and read-back showed the body and head unchanged. `retry-ci` on the in-progress
  run 43086685164 was refused with exit 1 before any mutation. No new regression test was added:
  these paths need real GitHub credentials, and `delivery-operations-check.mjs` already asserts
  the same arguments and refusals against a fake GitHub CLI.
- Current (2026-11-11, Claude session, at d9bb970d): the
  four previously blocked scoped checks (`delivery-operations-check`,
  `repositories-branch-sync-check`, `cli-command-catalog-check`,
  `permissions-render-live-characterization-check`) passed, cleanup included. `npm run check`
  passed 73/77 suites with doctor passing; the four browser suites failed only with
  ERR_MODULE_NOT_FOUND because the worktree had no installed dependencies, and all four passed
  after `npm ci`. Every EPERM, rollback-assertion, "full gate blocked", and "five Not tested
  advisories / kept active" entry below is superseded by this run.
- Validation: clean on pass 5 at 2cf0dd68 (fresh-context subagent). It noted that the
  16/16 native Codex policy assertions and the rule walkthrough assertions were one-off probes,
  not committed tests; the committed projection coverage is `agent-permission-defaults-check.mjs`.
- Validation pass 4 (fresh-context subagent) at d9bb970d found three fixes (Copy menu label,
  provider-neutral permission check, stale Verification lines) and one escalation, decided per the
  Decision Log. Fixes in 2cf0dd68; `codex-command-permission-check`,
  `agent-permission-defaults-check`, `orphan-test-check`, and `docs-reference-check` passed.
- Validation pass 3 (fresh-context subagent) found no code defects. Its fixes were stale plan
  records and the order of the pass line in `codex-command-permission-check.mjs` (fixed in
  d9bb970d, rerun passed).
- On the resumed run, delivery and branch-sync assertions reached their success messages
  before exiting at fixture cleanup. The catalog and live permissions checks also stopped
  at fixture cleanup. The standalone directory removal probe returned EPERM with expanded
  permissions.
- The full gate rerun passed doctor (98 checks). Its CLI suite then reported three package
  rollback assertion failures and a cleanup error. Running that CLI suite on unchanged
  main reproduced all three assertion failures and the cleanup error.
- The plan validator reported zero blocking findings, and the structural preflight passed.
  The GitHub CLI still reported an invalid login token.
- Validation pass 2 was clean at 13da1f95 (fresh-context subagent). It checked all nine
  validation criteria and the technical-writing rubric, confirmed the upstream freshness fix
  and four refusal regressions, and found no fix or new escalate findings. A separate fetch
  probe confirmed symbolic tracking refs preserve local branch values.
- Validation pass 1 (fresh-context subagent) found one fix, upstream configuration freshness,
  and classified the existing CLI cleanup failure as base. No documentation violations were
  found against the technical-writing rubric.
- Passed `node scripts/test/plan-suite-skills-check.mjs`,
  `node scripts/test/codex-command-permission-check.mjs`,
  `node scripts/test/agent-run-coverage-check.mjs`,
  `node scripts/test/orphan-test-check.mjs`,
  `node scripts/test/docs-reference-check.mjs`,
  `node scripts/build/render-agent-permissions.mjs --check`,
  `bash scripts/build/render-rules.sh --check`, `bash scripts/doctor.sh --quiet`
  (98 checks), and `git diff --check`.
- Native Codex policy evaluator assertions passed 16/16 for guarded allows, retained raw-command
  prompts/defaults, and merge/API/force-push denials.
- Disposable Git delivery assertions reached both success messages, covering tracking-ref fetch,
  branch/tag preservation, PR body contents, PR readiness, failed-only rerun arguments, and
  mismatched targets. The process then failed during temporary-directory cleanup with EPERM.
- Existing branch-sync assertions completed before their cleanup failed with the same EPERM.
  The CLI catalog check fails at temporary-directory cleanup on both this branch and main.
- `npm run check` was run once after registering the new test suite. Doctor passed, then
  the existing CLI suite failed rollback assertions and could not remove a fixture directory.
  Its built-in-package refusal assertion also requires an empty skill diff, while this run
  executed before the skill changes were committed. That source diff is now clean. The other
  assertion failure causes have not been independently established.
  The full gate is blocked and did not reach the later suites.
- Disposable rule walkthrough assertions passed for approved feature switching, keeping unrelated
  staged and untracked edits local, and detecting unpublished base commits before publishing.
  These assertions exercise Git behavior behind the prose, not provider autonomous compliance.
- Portal source assertions covered ten lead-button states, seven lifecycle menu sets, and the
  package's seven skill resources. The historical six-package migration account was preserved.
- Public GitHub run 42334175526 completed successfully at 5cb80dbacd3cf670eae7a54bdfd1ebccfe58aaf0.
  Its job names were verified as `check (ubuntu-latest)`, `check (macos-latest)`,
  and `windows-installer`.
- `node scripts/test/permissions-render-live-characterization-check.mjs` was attempted and
  blocked by EPERM at its first temporary-directory cleanup.
- The deterministic plan validator reports only five unconfirmed Not tested advisories.
  Completion preflight passed all six structural checks, but required verification remains
  blocked, so the implementation is kept active.
- No server was needed for this CLI and policy change. The actual CLI help and command fixtures
  exercise the normal entry point.
