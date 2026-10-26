# Resume a review

Review evidence survives interrupted chats. First resolve the plan in the primary checkout. If its
completed document is committed on base and has no pending edits, report already closed and stop.
Do not resolve its old worktree or run the approval check. Report uncommitted completion or pending
edits as a discrepancy instead of treating them as durable closure.
If an old active or review path is missing, resolve by the known plan id or the same filename in
completed and verify its identity against available evidence; never select a different plan.

For an active plan, run step 1's completion preflight and submit transition first. The resume
shortcuts below apply only once the primary plan is in review.

For a review plan, before synchronizing base or running checks, read the authoritative
plan, resolve the current feature and base tips, and run:

```bash
roborepo plans approval <plan> --json
```

The command is read-only. Exit 1 means approval is not fresh; inspect the JSON rather than treating
that exit alone as a failed review. Top-level `state` describes human approval. `review.state`
describes the separate `### Result` record; `review.baseChangedPaths` lists implementation changes
on base since the recorded base commit. Both comparisons exclude `docs/plans/`.

Read Git status before choosing a resume path. Pending implementation edits prevent reusing the
review for approval; do not commit or discard someone else's changes. Check approval durability
in the required plan copies before returning an unchanged success. If a post-merge recovery
committed only its worktree copy, finish its missing primary write as described below first.
Confirm the Result is committed before asking for approval. If a previous run wrote its own valid
review evidence but failed to commit it, finish that plan-only commit first; independently edited
plan content needs reconciliation rather than automatic staging.

## Contents

- Choose the remaining work
- Recover missing records
- Commit approval durably

## Choose the remaining work

Resume means continuing the workflow, not just reporting its state. Apply the entrypoint's
**Continue until a human decision** contract to every route below: finish authorized work, ask
for the specific input or action that blocks progress, or ask for exact-commit approval once the
review is complete. After an answer, continue from that step without requiring a new invocation.
Fresh approved and committed completed results still return without another approval prompt;
an explicit human pause or deferral still stops the workflow.

| Evidence | Resume at |
| --- | --- |
| Committed completed plan, without pending edits to that plan | Report already closed; stop without checking a removed worktree or repeating review. |
| Fresh, durably recorded approval; no pending implementation edits, new findings, or required manual checks; unchanged base implementation | Report already approved with the approved commit; make no commit and ask no new approval question. |
| Fresh complete review, approval missing, requested, or stale, unchanged base implementation | Approval only: show the reviewed commit, summarized evidence, and any recorded base failures; ask only for the missing human decision on this implementation. |
| Same complete review, with an explicit human approval already available for that implementation | Record the existing answer immediately through step 6a; do not ask again. |
| Changed implementation, changed requirements, or reopened findings | Review the changes and their effects on the acceptance criteria; run the affected checks, the completion gate, and a Validator pass before another complete Result. Preserve earlier review evidence as history. |
| Base implementation changed before landing | Synchronize through step 2 and review the resulting changes; do not renew approval for implementation the human has not seen. |
| Missing, invalid, or unavailable evidence | Resolve the missing evidence below; do not guess a reviewed commit or a human answer. |

Check the plan's current requirements, findings, and Not tested entries as well as the Git result.
A `fresh` result compares implementation content; it cannot detect a scope decision written only
in plan prose. New requirements or open findings prevent the unchanged success path. Reuse prior
test and Validator evidence only for the implementation it covered, and label it as reused.

When the work has already landed, use the canonical landed evidence, including the branch tip and
absorbing commit, to establish that fact. Reused evidence must name the same repository, branch,
base, and current branch tip; fresh Git reads must confirm the tip is unchanged and the absorbing
commit remains in base's first-parent history. Otherwise run the repository's canonical landed
check. Base changes made after landing do not require merging base into the old feature
branch to recover its approval. Review freshness still compares the reviewed commit with that
feature branch's current implementation; `/plan-close` separately checks the current landed work.

## Recover missing records

An explicit human answer is evidence when the available conversation identifies the reviewed plan
and implementation and clearly grants approval. Record the answer's chat/turn reference or quote
with its date. A checklist, test result, merge, summary saying approval was requested, or "I thought
I approved it" is not that answer. If the answer is unavailable or ambiguous, ask one confirmation
for the named reviewed implementation; do not replay the full review packet or tests.

For older plans without `### Result`, inspect their existing review packets, verification, and
resolved findings. Recover a Result only when those records identify the full reviewed commit and
base commit and cover the final implementation. Verify the commits exist, compare implementation
content with the current tip, and check for subsequent requirement changes. Record the evidence
used. If a commit or a required check cannot be established, run only the missing review work;
never manufacture a complete Result to skip it. Frontmatter `reviewed_commit` records plan-document
freshness and is not proof of completed implementation review.

## Commit approval durably

Before recording approval, read the branch tip, plan contents, and Git status again. The explicit
answer must cover the complete reviewed implementation, with every finding and required manual
check resolved. If implementation changed while waiting, return to review of those changes.

Before landing, write and commit the approval in the authoritative worktree as in step 6a. Repeated
approval of identical implementation with the same recorded human answer is a no-op. Preserve an
existing fresh approval rather than replacing its commit just because a plan-only commit moved HEAD.

For post-merge recovery while the plan remains in review:

1. Confirm landing before editing. Confirm the primary plan and authoritative worktree plan have
   matching bytes; if they differ, reconcile the plan evidence explicitly without overwriting
   either copy's unrelated edits. Do not synchronize or change implementation to repair a record.
2. Record the Result if needed, the explicit approval, and its evidence in the authoritative plan;
   commit only that plan in the worktree.
3. Apply the same evidence-only document to the primary plan after rechecking that the primary
   still matches the pre-edit document. Commit only that primary plan on base. If it changed, stop
   and report the discrepancy rather than overwriting it. These plan-only commits preserve the
   reviewed implementation and let the close integration check recognize the new plan version.
4. Run the canonical approval check; require `fresh`. Verify both commits contain only the selected
   plan and the two working documents match. If either commit fails, report exactly which copy is
   recorded and resume the missing write on the next run. Do not claim approval is durably recorded
   on base until the primary commit succeeds.

If a retry finds the approval already committed in the worktree but not in primary, verify the
primary matches that worktree commit's parent version of the plan, then finish only step 3. Never
copy over an independently changed primary plan. A missing or detached assigned worktree remains
an unavailable approval check; report the repository's restore-worktree remedy instead of guessing
its branch. This recovery records approval; it does not close, merge, push, or waive tests.
