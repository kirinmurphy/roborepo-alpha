# Push and hand off the feature branch

## Push

Every run that commits to the feature branch ends by pushing it, so the work never lives only on
this machine and CI runs the full gate on each step's result, including before `/plan-review`
starts. Push as the run's last Git step, after its final commit: after the submit transition
succeeds (as part of the handoff below), when the plan stays in `active/`, or after Review Findings
commits its fixes (also through the handoff). A run that made no feature-branch commit and whose
branch already matches its remote has nothing to push.

1. Re-read the worktree's branch and Git status. Push only the plan's feature branch, never the base
   branch or any other protected branch. Lifecycle commits are already on the plans branch.
2. From the worktree, run `git push -u <remote> <branch>`, where `<remote>` is the branch's upstream
   remote, or the repository's only remote when none is set. Never force-push.
3. With no remote, or when the push is refused (a permission prompt declined, a hook, a rejected
   non-fast-forward), do not retry, rebase, or work around it. The plan's lifecycle stands; report
   the exact command under Needs you and whether the session's permissions or the remote refused it.

## Hand off

After the submit transition, and after Review Findings commits its fixes, the plan reaches the user
as a pull request that merges cleanly into the current base. Run these steps in order from the
worktree, without asking.

1. **Merge the base in.** Run `roborepo plans sync-base --json`. It fetches the base branch's
   upstream, fast-forwards the local base when that is a pure fast-forward and the checkout holding
   the base has no uncommitted changes, then merges the base into the feature branch, or reports it
   already up to date. Invoking `/plan-execute` authorizes this merge of the base into the plan's own
   feature branch; it needs no further approval. Merging the feature branch into the base stays
   forbidden, and the protected-branch hook denies it. When the result's `baseUpdate.fetched` is
   false, the fetch failed (often a sandbox without network access) and the base was compared with
   the last fetch; say so in the report's Base line.
2. **A refusal** (a stale base that cannot be fast-forwarded: diverged, or its checkout has
   uncommitted changes) is not worked around. Report it under Needs you with the command's
   resolution, then still push and update the pull request, saying that the base was not merged.
3. **Conflicts** pause the merge with both sides in place. Resolve the ones inside the plan's scope
   by what both sides meant, never by picking a side blindly. Regenerate a generated file from its
   sources with the repository's generator rather than merging its text. Stage the resolution, then
   run `roborepo plans sync-base --continue --json`. A conflict that needs a decision outside the
   plan's scope is not resolved: run `git merge --abort`, and report the conflicting paths and the
   choice under Needs you. The branch is pushed without the merge.
4. **Recheck what the merge changed.** When the merge brought in changes (`state: merged`), run the
   checks for the files it touched, at the tier their change needs, and fix a failure the merge
   caused before pushing. A failure the base branch has too is recorded, not fixed.
5. **Push** the feature branch (Push, above).
6. **Open or update the pull request** against the base, with a written body: the plan's title and
   what it changes for a person, the checks that ran, the open `## Not tested` entries, and the
   plan's store path. Write the body to a file in the system temp directory. With no open pull
   request for the branch, run `gh pr create --base <base> --head <branch> --title "<plan title>"
   --body-file <file>`; otherwise run `roborepo delivery pr-body <file>`, and `roborepo delivery
   pr-ready` when the open pull request is a draft. Never merge it, enable auto-merge, or approve it.
7. **Report its state:** read `gh pr view --json url,mergeable,mergeStateStatus,statusCheckRollup`
   and give the pull request link, whether it merges cleanly, and CI's result so far. A CI run still
   in progress is reported as running, not waited for.

With no remote, or when GitHub is unreachable or refuses, the plan's lifecycle stands: report the
exact command that did not run under Needs you.
