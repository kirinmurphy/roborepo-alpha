# Push and hand off the feature branch

## Contents

- Push: every feature-branch push, and the draft pull request at the first one
- Hand off: base merge, push, pull request body, CI watch, and the report
- Watch CI: waiting for a result at the head commit and acting on it
- Mark ready: when the pull request leaves draft

## Push

Every run that commits to the feature branch ends by pushing it, so the work never lives only on
this machine and CI runs the full gate on each step's result, including before `/plan-review`
starts. `/plan-execute` also pushes as it goes: after the first implementation commit, after each
Validation Loop pass's fixes, and in the handoff below. It pushes last when the plan stays in
`active/`. `/plan-review` pushes its base merge and each fix as it lands. A run that made no
feature-branch commit and whose branch already matches its remote has nothing to push.

1. Re-read the worktree's branch and Git status. Push only the plan's feature branch, never the base
   branch or any other protected branch. Lifecycle commits are already on the plans branch.
2. From the worktree, run `git push -u <remote> <branch>`, where `<remote>` is the branch's upstream
   remote, or the repository's only remote when none is set. Never force-push.
3. **Open the draft after the first successful push.** Read the branch's open pull request with
   `gh pr view <branch> --json number,url,isDraft,baseRefName`. When none exists, open one as a
   draft: `gh pr create --draft --base <base> --head <branch> --title "<plan title>" --body-file <file>`,
   with a body written as Hand off step 6 describes. Never use `--fill`. A resumed run reuses the
   existing pull request, draft or not, and opens no second one.
4. With no remote, or when the push is refused (a permission prompt declined, a hook, a rejected
   non-fast-forward), do not retry, rebase, or work around it, and open no pull request. The plan's
   lifecycle stands; report
   the exact command under Needs you and whether the session's permissions or the remote refused it.

## Hand off

After a passing completion preflight, before the submit transition, and after Review Findings
commits its fixes, the plan reaches the user as a pull request that merges cleanly into the current
base, with CI watched to a result at its head commit. Run these steps in order from the worktree,
without asking. `<base>` is the plan's base branch (`main` unless repository policy names another);
pass it to every command below.

1. **Merge the base in.** Run `roborepo plans sync-base --base <base> --json`. It fetches the base
   branch's upstream, fast-forwards the local base when that is a pure fast-forward and the checkout holding
   the base has no uncommitted changes, then merges the base into the feature branch, or reports it
   already up to date, or `landed` when the base already absorbed the branch. Invoking `/plan-execute` authorizes this merge of the base into the plan's own
   feature branch; it needs no further approval. Merging the feature branch into the base stays
   forbidden. When the result's `baseUpdate.fetch` is `failed`, the fetch failed (often a sandbox
   without network access) and the base was compared with the last fetched copy; say so in the
   report's Base line. `local` means the base tracks a local branch, which needs no fetch.
2. **A refusal** (a stale base that cannot be fast-forwarded: diverged, or its checkout has
   uncommitted changes) is not worked around. Report it under Needs you with the command's
   resolution, then still push and update the pull request, saying that the base was not merged.
3. **Conflicts** pause the merge with both sides in place. Resolve the ones inside the plan's scope
   by what both sides meant, never by picking a side blindly. Regenerate a generated file from its
   sources with the repository's generator rather than merging its text. Stage the resolution, then
   run `roborepo plans sync-base --continue --base <base> --json`. A conflict that needs a decision outside the
   plan's scope is not resolved: run `git merge --abort`, and report the conflicting paths and the
   choice under Needs you. The branch is pushed without the merge.
4. **Recheck what the merge changed.** When the merge brought in changes (`state: merged`), run the
   checks for the files it touched, at the tier their change needs, and fix a failure the merge
   caused before pushing. A failure the base branch has too is recorded, not fixed.
5. **Push** the feature branch (Push, above).
6. **Open or update the pull request** against the base, only once a fresh read of the remote
   shows it holds the commit just pushed: `git ls-remote <remote> refs/heads/<branch>` prints
   `HEAD`'s commit. A local tracking ref can be stale, so it does not count. When the push was
   refused or this check fails, leave an existing pull request alone and report that its checks
   apply to the commit GitHub has, not to the local work.
   An existing open pull request whose base is not `<base>` is not edited or readied; report the
   mismatch under Needs you. The body is written for a person: the plan's title and what it
   changes for them, the checks that ran, the open `## Not tested` entries, and the plan's store
   path. Write the body to a file in the folder `roborepo scratch <plan-id>` prints, which
   `roborepo delivery pr-body` accepts; a session scratchpad can sit outside the locations it
   reads. When `roborepo scratch` notes that its folder is outside what `pr-body` reads (an
   overridden `ROBOREPO_STATE_ROOT` or `HOME` moved it), write the body to a `mktemp` file in the
   system temp folder the `pr-body` refusal names instead. With no open pull
   request for the branch, open the draft as Push step 3 describes; otherwise run
   `roborepo delivery pr-body <file>`. Leaving draft is not part of this step: see Mark ready. Never
   merge it, enable auto-merge, or approve it.
7. **Watch CI** at the pushed head (Watch CI, below), fixing what it finds.
8. **Report its state:** read
   `gh pr view --json url,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup` and give
   the pull request link, whether it is a draft or ready, whether it merges cleanly, and the result
   the watch reached, naming `headRefOid` as the commit they describe when it differs from `HEAD`.

With no remote, or when GitHub is unreachable or refuses, the plan's lifecycle stands: report the
exact command that did not run under Needs you.

## Watch CI

After a push that the pull request shows, run `gh pr checks <number> --watch` in the background where
the harness allows, so the wait spends no tokens; never poll it with repeated reads. When it
finishes, read `gh pr view <number> --json headRefOid,statusCheckRollup` and confirm `headRefOid` is
the commit just pushed. A result for an older commit is not the result: watch again.

| Result at head | Meaning | Action | Pull request |
| --- | --- | --- | --- |
| At least one check, all passed | Green | Continue | May leave draft |
| A failure that does not occur on base | Red | Read `gh run view <run-id> --log-failed`, fix, commit, push, watch again | Stays draft |
| The same check still failing after 3 fix commits for it | Blocked | Stop, record a blocker in Open Questions, report it | Stays draft |
| A failure that also occurs on base | Not green | Record it under `### Verification` as a base failure, continue, name it as an exception | Stays draft |
| No checks reported 2 minutes after the push | Not green | Run the canonical completion gate locally once, continue, name the exception | Stays draft |

`gh pr checks --watch` returns at once when no checks are reported yet. Wait the 2 minutes with the
harness's background wait (in Claude Code, a Monitor until-loop that reruns `gh pr checks` until a
check appears or the time passes), never a foreground sleep or repeated polling reads, then judge.

"Continue" means the caller's next step. Only `/plan-execute`'s Implementation Completion submits
after it, and a Blocked result there keeps the plan in `active/`. Review Findings and `/plan-review`
never run a lifecycle transition at this point.

- **Base failure.** Read the base branch's CI result for the base commit the branch last merged;
  when it has none, rerun the failing check locally on the base branch. A failure counts as a base
  failure only when that evidence shows the same check failing there.
- **Attempts.** At most 3 fix commits per failing check, counted per run, so a rerun of the skill
  starts fresh because a person chose to try again. One `roborepo delivery retry-ci <run-id>` is
  allowed per run for a failure that looks like infrastructure (a runner error, a network error, or
  a timeout inside a failed step, not a test assertion), and it does not count as an attempt. It
  reruns only a run whose conclusion is `failure`; a run that ended `timed_out` or `cancelled` is
  reported, not retried.
- **Never passing.** A base failure or no checks is not green, however the rest looks.
- **No revalidation in `/plan-execute`.** A CI fix there does not rerun the Validation Loop; the
  final report lists it, and `/plan-review`'s Validator covers it. A CI fix made during `/plan-review`
  is one of its step 5 fixes and gets a Validator pass there.

`gh pr checks --required` is not used: a repository may require no checks, and then it reports
nothing to wait for.

## Mark ready

Run `roborepo delivery pr-ready` only when all of these hold; otherwise the pull request stays a
draft and the report names which one did not:

- the Validator ended clean: a pass reported no `blocking` or `actionable` `fix` findings, not the
  eight-pass cap;
- CI is green at the head commit, by Watch CI's table;
- no `escalate` finding is open.

A Validator that stopped at its cap leaves the pull request a draft; `/plan-review` readies it after
its own pass. `gh pr ready` and `gh pr edit` are not used directly: the `roborepo delivery` commands
refuse a pull request whose repository, branch, or head does not match the pushed work.
