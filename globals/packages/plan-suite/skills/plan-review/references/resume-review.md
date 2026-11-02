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
in the required plan copies before returning an unchanged success. For post-merge recovery, verify any existing committed primary evidence through the canonical
approval reader before deciding a write is missing.
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

1. Confirm landing before editing. Resolve the assigned worktree and branch from Git; missing or
   detached worktrees remain unavailable. Record the full current branch tip, base ref and commit,
   absorbing commit, repository identity, and current primary/worktree plan blob ids. Both
   precursor versions must already be integrated on base. Requirements, tasks, findings, identity,
   and assignment must agree; refuse conflicting copies or approval records.
2. Write Result if established by existing completed review evidence, explicit Approval with the
   human answer, and `### Post-merge recovery` on primary only. Do not edit, synchronize, or commit
   the old worktree. The recovery subsection uses exactly these fields:

   ```md
   ### Post-merge recovery
   - Repository identity: <canonical repository id>
   - Worktree: <assigned Git administrative name>
   - Branch: <assigned branch>
   - Assessed branch tip: <full commit id>
   - Base ref: refs/heads/<base>
   - Base commit: <full pre-recovery base commit id>
   - Absorbing commit: <full absorbing commit id>
   - Primary precursor blob: <full pre-recovery primary plan blob id>
   - Worktree precursor blob: <full pre-recovery worktree plan blob id>
   ```

3. Recheck Git status and the exact precursor documents immediately before committing only the
   selected primary plan on base. Only Result, Approval, and the recovery subsection may change.
   Pending evidence is never durable approval. Refuse independent edits rather than overwriting.
4. Run `roborepo plans approval <plan> --json`; require fresh approval and complete fresh review.
   The shared verifier derives identity, integrated precursors, exact implementation, and historical
   absorption again from Git. Verify the primary commit changes only that plan and the old
   worktree stayed unchanged. A later implementation change invalidates this exception.

A retry reuses identical committed evidence rather than replacing provenance with newer tips.
Existing manually aligned copies need no synthetic commit when byte-identical and verified
landed. Missing, conflicting, or incomplete records require repair, never an inferred human
answer. This recovery records evidence; it does not close, merge, push, or waive tests.
