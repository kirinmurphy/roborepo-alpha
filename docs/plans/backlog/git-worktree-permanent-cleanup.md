---
id: 9xzkn4vz
priority: high
next_action: Run /plan-promote to finalize the consent contract and legacy recovery migration before implementation.
blocked_by: []
depends_on: []
related: ["4xc0gjuw", "b2sgiejd"]
reviewed_commit: 56af6f0f46baaea611e7e9a6d8d1c5ceba1d1e7f
worktree:
---

# Finish worktree cleanup without recovery copies

## Summary

Make intentional worktree deletion permanent and routine post-merge cleanup quiet. A closed
plan should leave its merged result in the base branch, without a recovery copy or a stranded
checkout full of generated files. When unique or uncertain work remains, keep the checkout and
offer one explicit confirmation to discard the displayed leftovers.

This combines permanent deletion with actionable cleanup of ignored build and environment
artifacts. Existing recovery data receives a separate, consent-based migration.

## Goals

- Remove future committed-tip backups and full recovery snapshots from every removal path.
- Automatically remove landed work and local layers proven preserved in merged history.
- Recognize common ignored generated artifacts without treating every ignored file as disposable.
- Give unfamiliar leftovers a clear discard-all or keep choice, bound to the exact reviewed state.
- Complete durable plan closure even when checkout or branch cleanup cannot finish.
- Bound cleanup bookkeeping and resolve legacy recovery data without silently losing unique work.

## Current state

The following behavior was inspected at the commit recorded above.

| Surface | Current behavior | Source |
| --- | --- | --- |
| UI deletion | Confirms dirty discard, but creates a committed-tip backup | `portal/home/worktree-dialogs.js`, `modules/repositories/worktree-removal.mjs` |
| Archive and remove | Captures local layers and offers restore details | `portal/home/index.html`, `scripts/cli/worktree-cleanup.mjs` |
| Automatic cleanup | Proves preservation; snapshots preserved local layers before removal | `modules/repositories/worktree-preservation.mjs`, `scripts/cli/worktree-cleanup.mjs` |
| Ignored paths | Only root `node_modules` and `test-results` are disposable; other ignored paths can block confirmed discard | `modules/repositories/worktree-snapshot.mjs`, `modules/repositories/worktree-guards.mjs` |
| CLI discard | Backend accepts `discardChanges`; cleanup argument parser does not expose it | `scripts/cli/worktree-cleanup.mjs` |
| Retry | Archive removal can retire a leftover branch using snapshot metadata | `modules/repositories/worktree-removal.mjs` |
| Storage | Removal log is append-only and absent from the retention registry | `modules/repositories/worktree-removal.mjs`, `modules/retention/registry.mjs` |

Preservation checks assess staged and filesystem layers against an absorbing base commit,
including squash landing and plan-path moves. Removing snapshot creation must retain these proofs.

The reported motivating case is a durably closed transcript-export plan whose checkout retained
ignored `.venv/`, `build/`, `*.egg-info/`, and `__pycache__/` directories. The supplied investigation
reported prototype eligibility checks, not successful native deletion. This plan does not claim
that prototype shipped or authorize removal of that real checkout.

Read-only inspection of this RoboRepo clone found 11 committed-tip backup refs and 3 snapshot
refs. Four backup tips are ancestors of local `main`; seven are not proven by that check, which
does not establish uniqueness after squash merges. Snapshot manifests list 1,294, 1,295, and
1,283 entries respectively, including tracked and untracked layers. Payload contents and their
preservation were not assessed. No recovery refs were changed.

The related cleanup-setting plan (`b2sgiejd`) owns hook enablement and settings, not removal
semantics. This plan owns shared deletion behavior; it does not depend on that setting shipping.
The completed preservation plan (`4xc0gjuw`) records the implementation being revised.

## Proposed behavior

### Ordinary cleanup and explicit deletion

| Entry point or result | Action | User attention |
| --- | --- | --- |
| Closed plan; committed and local work preserved | Remove checkout and local branch without capture | No prompt; brief completion result |
| Same, with recognized ignored artifacts | Remove artifacts with checkout | No prompt |
| Closed plan; unique or uncertain leftovers | Keep checkout and branch; closure stays committed | Show paths and discard-all or keep |
| UI Delete worktree | Preview loss, confirm, then permanently remove selected checkout and branch | One destructive confirmation |
| State changed after preview | Keep target and show the change | Renew confirmation |
| Checkout removed; branch retirement fails | Report each outcome and allow guarded retry | Only unresolved failure needs attention |

The UI has one Delete worktree action and cancel/keep. Remove Archive and remove, backup labels,
restore snippets, and archive lifecycle details from the deletion workflow. Warn about unmerged
commits, tracked changes, untracked files, ignored files, and an active plan when present. State
that no recovery copy is created and remote branches and PRs are untouched. Do not promise secure
erasure or immediate Git object reclamation.

For `/plan-close`, durable closure precedes cleanup. Routine cleanup produces no archive choices,
retention prompts, or per-artifact chatter. An already-completed retry performs only pending
cleanup, without repeating closure. PR approval and invoking `/plan-close` do not authorize
discarding later edits.

### Generated artifacts and complete inventories

Use one shared disposable-artifact policy for guards and preservation inventory. Extend the
existing recognized directories to ignored `.venv`, `build`, `*.egg-info`, and `__pycache__`
directories, including nested occurrences, alongside the existing Node/test artifacts.
Recognition requires Git ignore evidence and the expected directory shape; a name alone is
insufficient. Unknown ignored files, including configuration such as `.env`, remain protected.

Use matching ignored-path discovery rather than treating an aggregated parent such as `src/` as
the artifact. Never prune a directory that would hide tracked descendants: staged and unstaged
tracked changes must still participate in preservation. Do not follow symlinks outside the
checkout; a symlink with a familiar directory name is not automatically a disposable environment.

Separate the inventory needed for preservation from the complete inventory needed for destructive
consent. A consent preview covers all local files deletion will remove, including automatically
disposable directories. Preserve paths, types, modes, staged and filesystem versions, and content
identity without creating recovery objects. Use bounded/streamed hashing where appropriate so
discard does not inherit the snapshot writer's 64 MiB payload limit. If a complete, trustworthy
preview cannot be obtained, keep the worktree and report the specific blocker.

### One-time discard consent

Keep policy and transaction checks in the shared repository backend. CLI and portal adapters
present the same assessment and invoke the same operation; skill prose must not implement an
alternate deletion procedure.

1. Preview the selected repository/worktree identity, branch and tip, base evidence when required,
   and complete local state. Present tracked, untracked, and ignored groups separately; include
   directory counts and sizes where available, with access to the complete path list.
2. For blocked plan cleanup, offer **Discard all listed leftovers and remove** or **Keep worktree**.
   For UI deletion, include unmerged committed work in the loss warning. Confirmation explicitly
   says no backup will be created.
3. Bind confirmation to a backend-issued, one-use receipt containing the exact reviewed state and
   operation scope. Reuse existing fingerprint and lock mechanisms; do not accept a boolean as
   sufficient authorization for a changed target. Persist only bounded metadata needed across
   CLI calls, never file payloads or recovery refs.
4. Under the cleanup lock, recheck identity, tip, local content, index, relevant base evidence,
   and all removal guards immediately before mutation. Recheck after server shutdown as well.
   Changed paths, new files, removed files, or changed contents invalidate consent; present the
   difference and require a new preview and confirmation. Do not silently refresh the receipt.
5. Consume authorization for one transaction. Retrying an interrupted transaction may finish only
   the recorded remaining branch retirement; it cannot delete a recreated checkout or new work.

Plan-leftover consent retains the requirement that committed implementation has landed. It cannot
authorize unmerged commits. The general confirmed UI/CLI deletion operation can discard unmerged
commits only when that broader loss was explicitly previewed and confirmed. Encode the scope in
the backend receipt, so an agent cannot accidentally turn leftover consent into whole-branch
discard. Finalize the exact CLI flags and receipt representation during promotion; retain dry-run
and machine-readable output and expose a supported apply path for agents after user confirmation.

Keep primary/current-checkout, locks, submodule, active-plan, server, branch-occupancy, and state
change protections according to their existing modes. Stop only the selected checkout's servers
after other guards pass. Stop external writers operationally; a lock does not prevent arbitrary
editor writes after the last check. Report that limitation honestly rather than claiming atomic
filesystem deletion. Do not kill agent sessions or bypass a refusal with manual folder removal.

### Partial cleanup without snapshots

Replace snapshot-dependent retry evidence with a small transaction record identifying repository,
worktree, branch, expected tip, consent/proof scope, and completed steps. It contains no file
contents and holds no Git refs. Record intent before removal and checkout/branch outcomes as they
occur. Fail before mutation if required evidence cannot be written; report later recording errors
alongside the actual filesystem/Git outcome.

On retry, verify checkout absence, branch occupancy and expected tip before retiring a leftover
branch. Ambiguous crashes, moved branches, or a recreated checkout require reassessment rather
than replayed discard. Give transient receipts and transaction records a fixed bounded lifetime;
after expiry, prove landing afresh or obtain fresh consent. The removal log must not be the sole
source of permission or correctness, because it will be compacted.

### Legacy recovery migration and public commands

No legacy recovery data is deleted during plan authoring or merely because new removals stop
archiving. Implement a one-time migration workflow with a dry-run inventory and an explicit
apply step. Present a concrete per-repository migration report before asking to destroy refs.

| Legacy class | Proposed resolution |
| --- | --- |
| Tip backup proven reachable/preserved in retained base history | Propose ref deletion with recorded proof; apply only after migration approval |
| Snapshot whose committed and every captured local layer are proven preserved | Propose ref deletion with layer-specific evidence and approval |
| Unique or uncertain data | Require explicit discard, or restore/export to a user-selected durable destination and verify it before ref deletion |
| Invalid or unreadable recovery data | Report unresolved; no automatic expiry or deletion |

Inventory both `refs/roborepo/abandoned/` and `refs/roborepo/worktree-archives/`, recording exact ref
and object identities, dates where known, layer counts, and proof limits. Do not infer age from a
branch name or infer preservation from an archive's commit parent alone. Recheck exact object IDs
before approved ref deletion. A changed ref requires renewed review. Apply is idempotent and
reports individual failures. A cancelled migration remains explicitly pending; it is not a
permanent “keep indefinitely” product option. Completion requires resolving each inventoried
item, but no timeout may silently destroy uncertain data.

Remove the public `archive-remove` command and matching portal route with the feature change;
do not retain an alias that unexpectedly discards instead. Retain the existing `archives` and
`restore` capabilities solely to resolve already-created data during migration. This is data
access, not a new archive product. Retire them only after a supported migration/export path can
handle old data on installations that have not migrated; absence of refs on this developer clone
is not sufficient. Document this explicit compatibility decision before deleting command entries.

Legacy restore verification must use all entries in the captured manifest, independently of the
new disposable-artifact exclusions. Restore/export must preserve captured index and filesystem
versions, modes, symlinks, and empty directories. Use synthetic fixtures rather than reading real
credential files. Migration reports should expose paths/metadata, not payload contents.

### Storage housekeeping

Register the removal log with existing retention measurement and compaction infrastructure.
Use fixed defaults of 30 days and 2 MiB, with no age floor that would retain small logs forever.
Compact on append under a lock shared by all writers to this state-root log; repository-specific
cleanup locks alone do not serialize different repositories. Bound transient consent/transaction
metadata by both age and size and make expiry fail closed. No retention settings or archive UI
are added. Let ordinary Git maintenance reclaim unreachable objects; never run aggressive
immediate pruning as part of cleanup or migration.

## Implementation plan

- [ ] Finalize preview/apply CLI and portal contracts, receipt scope, expiry, and partial-result
      fields. Inventory command consumers before removing archive creation interfaces.
- [ ] Unify ignored-artifact classification and complete loss inventory in the shared repository
      modules; retain preservation proofs and tracked-descendant visibility.
- [ ] Remove backup/snapshot creation from confirmed and automatic removal. Replace snapshot-based
      guard exemptions with explicit preservation evidence or validated discard authorization.
- [ ] Implement one-use preview-bound discard and snapshot-free partial cleanup retry, including
      cross-process locking, state changes during server shutdown, and evidence-write failures.
- [ ] Update `scripts/cli/worktree-cleanup.mjs`, its command catalog entries, and
      `scripts/cli/portal-routes-repositories.mjs` to use the shared transaction.
- [ ] Simplify `portal/home/worktree-dialogs.js`, `portal/home/index.html`, and
      `portal/home/api.js`; replace backup promises with complete loss warnings and stale-preview
      handling. Preserve existing stop-server and active-plan behavior.
- [ ] Update `globals/packages/plan-suite/skills/plan-close/SKILL.md` and affected references to
      close durably, clean quietly, and request exact-set discard only for unresolved work.
- [ ] Add legacy inventory, proof, restore/export verification and approved migration apply;
      remove archive creation while preserving access to existing data as specified above.
- [ ] Bound the removal log and transient metadata through the existing retention infrastructure;
      handle concurrent writers, compaction errors and expired retry evidence safely.
- [ ] Update affected documentation and focused regression tests; run the validation below.

## Validation

Use real Git fixtures and harmless synthetic files. Existing starting points are
`scripts/test/worktree-lifecycle-check.mjs`, `scripts/test/worktree-snapshot-check.mjs`, and
`scripts/test/retention-policy-check.mjs`. Extend the affected CLI/route and portal browser tests
after identifying their current coverage. First demonstrate the relevant failures against the
current behavior, then assert final outcomes rather than only helper calls.

| Scenario | Required assertion |
| --- | --- |
| Clean landed branch; normal and squash merges | Checkout and branch removed; no new recovery refs |
| Local index/filesystem versions absorbed in merged history | Both proofs retained; actual removal succeeds without capture |
| Ignored Python/Node artifacts, including nested directories | Automatic cleanup succeeds; no broad parent exclusion |
| Unignored artifacts, tracked descendants, unknown ignored configuration | Unique work remains protected |
| Ignored environment symlink | External target survives; no traversal or automatic environment assumption |
| Approved unfamiliar ignored/untracked/tracked leftovers | One discard-all confirmation removes exactly the previewed target |
| Plan-leftover consent with unmerged implementation | Removal refused; broader discard not inferred |
| File/index/mode/tip/base change, new file, removed file after preview | Consent rejected; difference reported; no deletion |
| Wrong repository, replayed receipt, expiry, recreated checkout | Refused without deleting new work |
| File larger than snapshot limit; incomplete inventory | Large files can be safely previewed, or a concrete blocker keeps checkout |
| Main/current checkout, locks, active plan, submodules, servers | Existing protections retained; no unrelated process stopped |
| Branch retirement or log/transaction write failure | Accurate partial outcomes; retry cannot discard moved/new work |
| Already-completed plan with cleanup remaining | Closure commit unchanged; cleanup resumes independently |
| UI deletion | One action, honest loss warning, complete categories, stale-preview refresh; no archive details |
| Legacy captured artifacts now classified disposable | Restore/export still verifies every captured entry |
| Legacy unknown/unique/corrupt refs or changed ref identity | No deletion without required resolution and approval |
| Migration retry | Already-removed refs harmless; per-ref failures explicit; no forced pruning |
| Log and receipt pressure, concurrent repository writers | Fixed bounds enforced without losing valid concurrent records or widening consent |

For implementation, run affected tests and their callers plus `bash scripts/doctor.sh --quiet`,
docs references, skill structure/trigger/render checks when affected, and `git diff --check`.
Use the repository's scoped portal browser runner for the changed interaction. CI runs the full
gate; do not repeat it locally unless changing test orchestration or otherwise required by repo
rules. Report eligibility separately from actual native deletion if host restrictions block it.
Planning-only verification is the plan validator, docs references, and independent prose/design
review; no implementation suite is needed to create this document.

## Documentation impact

| Source | Required update |
| --- | --- |
| `docs/user/reference/repositories.md` | Permanent deletion, artifact policy, remaining-work choices, migration and partial retry |
| `docs/user/reference/roborepo-cli.md` | Confirmed-discard contract and archive command retirement/access policy |
| `docs/user/reference/plans-portal.md` | Single deletion flow and separation of plan closure from cleanup |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | Quiet cleanup, explicit leftover consent, already-closed retry |
| `docs/internal/cli-internals.md` | Shared transaction ownership, bounded metadata and migration |
| Plan-close skill and linked references | Canonical calls, consent boundaries and concise result reporting |
| Repo development skill's CLI overview | Remove the claim that worktrees are archived before removal |

## Scope and decisions

The attachment's archive-all and mixed archive/discard choices are superseded by the requested
permanent-deletion model. Selective preservation is handled by keeping the checkout and moving
valuable work through ordinary workflows before a fresh cleanup preview; no per-file archive
picker is introduced. Plan lifecycle `archived/` still means an abandoned plan and is unaffected.

No remote branches or PRs are changed. No real worktree or legacy ref may be destroyed merely to
validate this feature. Ask before creating or switching implementation branches/worktrees.

The proposed legacy migration policy requires approval of a concrete inventory before destructive
apply. That is an implementation-time data decision, not approval granted by this plan. Receipt
representation and exact command spelling remain promotion tasks; the preservation and consent
guarantees above are requirements.
