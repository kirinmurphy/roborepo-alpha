---
id: 9xzkn4vz
priority: high
next_action: Run /plan-execute to implement permanent deletion, the discard receipt, and the legacy recovery migration; ask before creating the worktree.
blocked_by: []
depends_on: []
related: ["4xc0gjuw", "a7bslb00", "z3j2x3x1", "b2sgiejd", "l1mz96d9", "0jped168"]
reviewed_commit: a774d0bed99bd4b0083f66a0001eacb782ff13da
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
| UI deletion | Boolean `discardChanges` consent; always writes a committed-tip backup | `portal/home/worktree-dialogs.js`, `modules/repositories/worktree-removal.mjs` |
| Archive and remove | Captures local layers and offers restore details; its route also serves as the dialog's preview | `portal/home/index.html`, `portal/home/api.js`, `scripts/cli/worktree-cleanup.mjs` |
| Automatic cleanup | Proves preservation; snapshots preserved local layers before removal. The plan-close step and the `post-merge` hook both use this path | `modules/repositories/worktree-preservation.mjs`, `scripts/cli/worktree-cleanup.mjs`, `scripts/cli/worktree-hook.mjs` |
| CLI confirmed removal | `cleanup --remove <name> --confirm --apply` removes a clean checkout even with unmerged commits; only the backup protects them | `scripts/cli/worktree-cleanup.mjs` |
| Ignored paths | Only root `node_modules` and `test-results` are disposable; other ignored paths can block confirmed discard. The guard parses unquoted `status --porcelain=v1` output | `modules/repositories/worktree-snapshot.mjs`, `modules/repositories/worktree-guards.mjs` |
| Inventory | Refuses filter or merge-driver config, `core.autocrlf`, sparse and split indexes, index flags, special files, nested repositories, unsafe names, and files over 64 MiB; holds file bytes in memory | `modules/repositories/worktree-snapshot.mjs` |
| Home survey | Runs the guard without a preservation result, then shows its reason, such as `valuable ignored path: .venv/`. The dialog also compares that reason text to detect a dirty checkout | `scripts/cli/worktree-observations.mjs`, `portal/developer-runtime/repository-root-row.js`, `portal/home/worktree-dialogs.js` |
| CLI discard | Backend accepts `discardChanges`; cleanup argument parser does not expose it | `scripts/cli/worktree-cleanup.mjs` |
| Retry | Archive removal can retire a leftover branch using snapshot metadata | `modules/repositories/worktree-removal.mjs` |
| Landing | Accepts a name under `refs/heads/` and needs its reflog, so it cannot assess a legacy ref as it stands | `modules/repositories/worktree-landed.mjs` |
| Storage | Removal log is append-only and absent from the retention registry | `modules/repositories/worktree-removal.mjs`, `modules/retention/registry.mjs` |
| Unused routes | `GET .../worktrees/:branch/assessment` and `GET .../worktrees/archives` have no portal or test consumer | `scripts/cli/portal-routes-repositories.mjs` |

Preservation checks assess staged and filesystem layers against an absorbing base commit,
including squash landing and plan-path moves. Removing snapshot creation must retain these proofs.

The motivating case is a durably closed transcript-export plan whose checkout retained ignored
`.venv/`, `build/`, `*.egg-info/`, and `__pycache__/` directories. A prototype reported those
directories eligible; no native deletion ran. This plan does not claim that prototype shipped or
authorize removal of that real checkout.

Read-only inspection of this RoboRepo clone found 11 committed-tip backup refs and 3 snapshot
refs. Four backup tips are ancestors of local `main`; seven are not proven by that check, which
does not establish uniqueness after squash merges. Snapshot manifests list 1,294, 1,295, and
1,283 entries. All but one or two entries per manifest are tracked files, and none are ignored.
Backup ref names do not reliably state their tip: `runtime-row-layout-skill-f8086e` points at
`d19c7b19`, which a second ref also holds. Payload contents and their preservation were not
assessed. No recovery refs were changed.

### Related plans

The `active/`, `ready/`, and `review/` folders hold no plans at the recorded commit.

| Plan | Classification | Reconciliation |
| --- | --- | --- |
| Retire worktrees safely ([[4xc0gjuw]]) | Landed dependency; completed. Squash `c6d14d32` is an ancestor of `HEAD` | Keeps its preservation proof, plan-path mapping, landed recovery, and merge readiness. Supersedes its Archive and remove, its verified snapshot for dirty automatic cleanup, its boolean Delete consent, and its "no CLI discard flag" rule. Its archives stay readable until the migration resolves them. No lifecycle change |
| Worktree lifecycle cleanup ([[a7bslb00]]) | Landed dependency; completed. Squash `7627bfc` is an ancestor of `HEAD` | Supersedes its committed-tip refs and clean-only confirmed removal. Keeps its guards and landing scan. No lifecycle change |
| Finish safe worktree cleanup reliably ([[z3j2x3x1]]) | Archived; its hashing fix `f101af02` is an ancestor of `HEAD` | The fix stays. This plan does not revive the retired scope |
| Cleanup as a reversible setting ([[b2sgiejd]]) | Unlanded adjacent story; backlog | Owns hook enablement, settings, and `hook.log`; this plan owns removal semantics, and neither waits for the other. Stale prose for its own promotion: `next_action` waits on a plan that has completed, and Risks says removal requires a clean worktree |
| Windows test environment ([[l1mz96d9]]) | Unlanded adjacent story; backlog | Its task to verify snapshot capture and restore narrows to restore once capture is gone. Update it through `/plan-write` after this lands |
| Agent behavior evals ([[0jped168]]) | Unlanded adjacent story; backlog | Relies on `cleanup --plan <id> --apply`, which stays. No conflict |

## Proposed behavior

### Ordinary cleanup and explicit deletion

| Entry point or result | Action | User attention |
| --- | --- | --- |
| Closed plan; committed and local work preserved | Remove checkout and local branch without capture | No prompt; brief completion result |
| Same, with recognized ignored artifacts | Remove artifacts with checkout | No prompt |
| Closed plan; unique or uncertain leftovers | Keep checkout and branch; closure stays committed | Show paths and discard-all or keep |
| `post-merge` hook; same outcomes | Same removals; a kept checkout stays | None; the reason goes to the hook log and Home |
| CLI `cleanup --remove`, work proven preserved | Remove checkout and branch | `--confirm --apply` |
| CLI `cleanup --remove`, anything unproven | Keep, and name the `discard` command | Run `discard` |
| UI Delete worktree | Preview loss, confirm, then permanently remove selected checkout and branch | One destructive confirmation |
| State changed after preview | Keep target and show the change | Renew confirmation |
| Checkout removed; branch retirement fails | Report each outcome and allow guarded retry | Only unresolved failure needs attention |

The UI has one Delete worktree action and cancel/keep. Remove Archive and remove, backup labels,
restore snippets, and archive lifecycle details from the deletion workflow. Warn about unmerged
commits, tracked changes, untracked files, ignored files, and an active plan when present. State
that no recovery copy is created and remote branches and PRs are untouched. Do not promise secure
erasure or immediate Git object reclamation. Dialog copy says "repo", never "repository".

For `/plan-close`, durable closure precedes cleanup. Routine cleanup produces no archive choices,
retention prompts, or per-artifact chatter. An already-completed retry performs only pending
cleanup, without repeating closure. PR approval and invoking `/plan-close` do not authorize
discarding later edits.

### Generated artifacts

One shared policy serves the guards, preservation inventory, and consent preview. A directory is
disposable only when all of these hold: Git reports it ignored, it is a real directory rather than
a symlink, it has no tracked descendants, it contains no `.git` entry at any depth, and it matches
a row below.

| Directory, at any depth | Required shape |
| --- | --- |
| `node_modules`, `test-results` | At the checkout root, nothing further. Nested, `package.json` in the parent |
| `.venv` | Contains `pyvenv.cfg` |
| `__pycache__` | Contains only `*.pyc` and `*.pyo` files |
| `*.egg-info` | Contains `PKG-INFO` |
| `build` | Parent holds `pyproject.toml`, `setup.py`, `setup.cfg`, `package.json`, `CMakeLists.txt`, or `Makefile` |

Anything else ignored, including `.env` and a `build/` with no project file beside it, stays
protected and reaches the leftover choice. Discovery uses NUL-separated Git output. It walks only
the entries Git aggregates, so a wholly ignored `src/` is searched for matching directories rather
than treated as an artifact. A directory hiding tracked descendants is never pruned: staged and
unstaged tracked changes still participate in preservation. Removing a disposable directory
removes symlinks inside it without following them.

### Complete loss inventory

Preservation keeps `inventoryWorktree`. Destructive consent gets its own inventory, because the
existing refusals would make Delete fail in repos where it works today, such as any machine with a
global Git LFS filter configured.

| Concern | Consent inventory |
| --- | --- |
| Git filter, driver, `autocrlf`, sparse, or index-flag config | Allowed; files are read raw and no filter runs |
| Detached worktree | Allowed |
| Tracked content | Index mode, object id, stage, and flags, plus the file's own type, mode, and SHA-256 |
| Untracked and unknown ignored files | Path, type, mode, size, and streamed SHA-256, with no 64 MiB limit |
| Symlinks | Target bytes hashed and never followed |
| Sockets, FIFOs, and devices | Listed by type |
| Disposable directories | Path, file count, and bytes, from `lstat` only |
| Nested repository or submodule outside a disposable directory | Blocker |
| Unreadable entry, or over the 120-second budget | Blocker |

A blocker keeps the worktree and names the path. Disposable directories are shown, but a change
inside one does not invalidate a confirmation, because automatic cleanup removes them with no
consent at all.

### One-time discard consent

Policy and transaction checks live in the shared repository backend. CLI and portal adapters
present the same assessment and invoke the same operation; skill prose must not implement an
alternate deletion procedure.

A preview issues a **receipt**: a one-use, backend-held record of exactly what the user reviewed.
Applying requires it, and a boolean is never sufficient. Writing the receipt is the only change a
preview makes.

```text
roborepo git worktrees discard <branch-or-name> --scope leftovers|all [--base <branch>] [--json]
roborepo git worktrees discard --plan <id> [--base <branch>] [--json]
roborepo git worktrees discard <branch-or-name> --receipt <id> --apply [--json]
```

| Scope | Requires | Discards | Used by |
| --- | --- | --- | --- |
| `leftovers` | Committed work proven landed | Local state only | `/plan-close`; `--plan` implies this scope and rejects `all` |
| `all` | Nothing further | Local state and unmerged commits, listed with count and subjects | UI Delete; explicit CLI request |

A preview returns the data below, as JSON with `--json`. The groups list every path, except that
disposable directories appear as one entry each. Exit status is 0 for a preview with a receipt
and 1 for a blocker or any apply that does not end with `action: "removed"`.

```json
{
  "action": "preview",
  "eligible": true,
  "scope": "leftovers",
  "receipt": "<uuid>",
  "expiresAt": "<iso-8601>",
  "target": { "repositoryId": "<id>", "path": "<checkout>", "name": "<name>", "branch": "<branch>", "tip": "<sha>", "baseRef": "<ref>", "baseCommit": "<sha>" },
  "commits": { "landed": true, "unmerged": 0, "subjects": [] },
  "groups": {
    "tracked": [{ "path": "src/a.js", "change": "modified" }],
    "untracked": [{ "path": "notes.md", "bytes": 120 }],
    "ignored": [{ "path": ".env", "bytes": 42 }],
    "disposable": [{ "path": ".venv", "files": 4120, "bytes": 88000000 }]
  },
  "servers": [{ "pid": 123, "ports": [3000] }],
  "warnings": ["plan still active"],
  "blockers": []
}
```

The receipt stores the target, scope, state digest, and per-path identities needed to report a
difference. It never stores file contents and holds no Git refs. Above 2 MiB it keeps only one
digest per group, and a later change names the changed groups rather than paths. The portal uses
the same operation with `all` scope:

```text
POST /api/repositories/:id/worktrees/remove-preview   { branch }           -> preview, without target.path
POST /api/repositories/:id/worktrees/remove           { branch, receipt }  -> result
```

A removal request without a valid receipt is refused. The `discardChanges` and
`requiresDiscardConfirmation` fields leave the contract.

`/plan-close` shows the grouped preview, then asks **Discard all listed leftovers and remove** or
**Keep worktree**. It runs the apply form only after the user chooses to discard. Confirmation
wording says no backup will be created.

```mermaid
flowchart TD
  A[Take repo cleanup lock] -->|read| B{Receipt exists, unexpired, unconsumed, same repo and worktree?}
  B -->|no| K[Keep; require new preview]
  B -->|yes| C{Guards pass and state matches receipt?}
  C -->|no| D[Keep; report added, removed, and changed paths]
  C -->|yes| E[Stop selected checkout's servers]
  E -->|recheck| F{Guards pass and state still matches?}
  F -->|no| D
  F -->|yes| G[Mark receipt consumed and record intent]
  G -->|run| H[Remove checkout with force]
  H -->|on success| I[Retire branch at expected tip]
  I -->|record| J[Delete record; append to removal log]
```

Each recheck covers identity, tip, local content, index, relevant base evidence, and all removal
guards. A failed recheck never refreshes the receipt silently. A consumed receipt authorizes only
the recorded remaining branch retirement; it cannot delete a recreated checkout or new work.

`leftovers` consent cannot authorize unmerged commits: the apply step reproves landing for that
scope, so an agent cannot turn it into whole-branch discard. Git's `--force` is passed only after a
matching receipt or a fresh `preserved` proof with an unchanged fingerprint.

Primary/current-checkout, locks, submodule, active-plan, and branch-occupancy protections keep
their existing modes. Stop external writers operationally; a lock does not prevent arbitrary editor
writes after the last check. Report that limitation honestly rather than claiming atomic filesystem
deletion. Do not kill agent sessions or bypass a refusal with manual folder removal.

### Partial cleanup without snapshots

Each removal writes one small JSON record to
`<stateRoot>/worktree-cleanup/transactions/<uuid>.json`. A receipt is this record in its earliest
state; automatic removal starts directly at `applying`, with its proof in place of a receipt.

| Field | Value |
| --- | --- |
| `state` | `previewed`, `applying`, or `checkout-removed` |
| Identity | Repository id, worktree name and path, branch, expected tip |
| Authority | `scope` (`leftovers`, `all`, or `proof`), plus the receipt digest or evidence commit |
| Bounds | `createdAt`, `expiresAt` |

Writing the `applying` state must succeed before any mutation, or the worktree is kept. A later
recording failure is reported alongside the actual filesystem and Git outcome. The record is
deleted on completion.

`cleanup --remove <branch-or-name> --confirm --apply` finds a `checkout-removed` record when the
checkout is gone. It verifies checkout absence, branch occupancy, and expected tip before retiring
the branch. Ambiguous crashes, moved branches, or a recreated checkout require reassessment rather
than replayed discard. The portal reports the partial outcome and names this command, since the
row is gone once its checkout is. The snapshot-based retry leaves with `archive-remove`; a branch
stranded by an older partial removal stays an ordinary branch.

Receipts expire after 24 hours, long enough for an agent to wait on a user's answer. Records older
than 7 days are pruned. After either, prove landing afresh or obtain fresh consent. The removal
log is never a source of permission, because it will be compacted.

### Legacy recovery migration and public commands

No legacy recovery data is deleted during plan authoring or merely because new removals stop
archiving. The migration is CLI-only and acts on the repo containing the working directory.

```text
roborepo git worktrees legacy-recovery [--discard <ref>]... [--json]
roborepo git worktrees legacy-recovery [--discard <ref>]... --approve <digest> --apply [--json]
roborepo git worktrees restore <archive-id-or-abandoned-ref> --destination <new-path> [--apply] [--json]
```

The first form is the dry-run inventory: every item under `refs/roborepo/abandoned/` and
`refs/roborepo/worktree-archives/`, with exact ref and object identity, date where known, layer
counts, class, proof limits, and paths without payloads. Its `digest` covers the exact set of
refs, objects, and classes proposed for deletion. Approval names that digest, so it cannot cover a
report the user did not see.

| Legacy class | Resolution |
| --- | --- |
| Tip backup proven reachable or absorbed in retained base history | Proposed for deletion, with recorded proof |
| Snapshot whose committed and every captured local layer are proven preserved | Proposed for deletion, with layer-specific evidence |
| Unique or uncertain data | Stays until the user names it with `--discard`, or restores it and then names it |
| Invalid or unreadable recovery data | Reported unresolved; deleted only when named with `--discard` |

Proof uses the object recorded in the ref and the manifest's own layers. Age is never inferred from
a ref name, a tip never from a name suffix, and preservation never from an archive's commit parent
alone. Apply deletes with the expected object id, so a changed ref requires renewed review. It is
idempotent, reports individual failures, and never runs forced pruning.

Restoring a backup ref creates a detached worktree at its tip; the existing snapshot restore keeps
its verification. Verification compares every entry in the captured manifest, independently of the
disposable policy, and keeps captured index and filesystem versions, modes, symlinks, and empty
directories. Fixtures are synthetic rather than real credential files.

A cancelled migration stays pending, derived from the refs themselves with no extra state. When
refs remain, `cleanup` adds `legacyRecoveryPending: <count>` to its JSON and one line to its text
output, and `/plan-close` relays it. No timeout destroys uncertain data.

| Command or route | Change |
| --- | --- |
| `git worktrees archive-remove`, `POST .../worktrees/archive-remove` | Removed, with no alias |
| `GET .../worktrees/archives`, `GET .../worktrees/:branch/assessment` | Removed, as they have no consumer |
| `git worktrees discard`, `git worktrees legacy-recovery`, `POST .../worktrees/remove-preview` | Added |
| `git worktrees restore` | Also accepts backup refs |
| `git worktrees archives` | Unchanged. It and `restore` stay for installs that have not migrated; this plan does not retire them, and retiring them needs a later decision |
| `git worktrees cleanup` | Same flags. `--remove` narrows as described above and gains the retry |
| `POST .../worktrees/remove` | Takes `receipt` in place of `discardChanges` |

### Storage housekeeping

Two stores join the retention registry, and neither adds settings or archive UI.

| Store id | Target | Shape | Bound |
| --- | --- | --- | --- |
| `worktree-removal-log` | `worktree-cleanup/removals.jsonl` | Log | 30 days, 2 MiB, `floorBytes: 0` |
| `worktree-cleanup-transactions` | `worktree-cleanup/transactions/` | File set | 7 days, 5 MiB |

The log compacts on append with the temp-file rename used by Runtime history. Writers from
different repos can interleave, and an append landing between compaction's read and rename would
be lost, so every append and compaction holds a state-root lock with a bounded wait. A failed
intent write keeps the worktree; a failed outcome write is reported. Pruning a live transaction
fails closed: its receipt is simply missing. Let ordinary Git maintenance reclaim unreachable
objects; never run aggressive immediate pruning as part of cleanup or migration.

`hook.log` is written by the hook's shell redirect and stays with the cleanup-setting plan.

## Implementation plan

Module ownership: `modules/repositories/worktree-artifacts.mjs` holds the disposable policy, and
`modules/repositories/worktree-discard.mjs` holds the consent inventory, receipts, and transaction
records. `worktree-snapshot.mjs` keeps inventory, listing, reading, and restore, and loses capture.
`scripts/cli/worktree-cleanup.mjs` and the portal routes stay thin adapters.

- [ ] Inventory consumers of `archive-remove`, `createWorktreeSnapshot`, `archiveBranchTip`,
      `retryArchivedBranchRetirement`, `verifiedSnapshot`, and `discardChanges` before changing them.
- [ ] Add the disposable policy with `-z` discovery. Use it in `worktree-guards.mjs` and the
      preservation inventory; retain tracked-descendant visibility and nested-repository detection.
- [ ] Add the consent inventory, and the receipt and transaction records, with cross-process
      locking, one-use consumption, expiry, and evidence-write failure handling.
- [ ] Remove backup and snapshot creation from `removeWorktree` and `cleanupWorktrees`. Replace
      `verifiedSnapshot` with explicit preservation evidence or a validated receipt, and gate
      `--force` on them. Narrow `cleanup --remove`, and add the record-based retry.
- [ ] Add the `discard` command definition and adapter, remove the `archive-remove` definition and
      `worktreeArchiveCommand` branch, and wire `scripts/cli/telemetry.mjs` handlers and
      `scripts/cli/portal-routes-repositories.mjs` to the contract above.
- [ ] Simplify `portal/home/worktree-dialogs.js`, `portal/home/index.html`, `portal/home/api.js`, and
      related styles; replace backup promises with complete loss warnings and stale-preview
      handling. Preserve existing stop-server and active-plan behavior.
- [ ] Stop `scripts/cli/worktree-observations.mjs` reporting recognized artifacts as blocking
      reasons, and stop the dialog parsing reason text to detect a dirty checkout.
- [ ] Update `globals/packages/plan-suite/skills/plan-close/SKILL.md` step 10 to close durably,
      clean quietly, and request exact-set discard only for unresolved work.
- [ ] Extract the layer-absorption step of `worktree-preservation.mjs` and a commit-based landing
      entry in `worktree-landed.mjs`, so proofs accept a legacy ref and manifest. Add
      `legacy-recovery`, extend `restore`, and disable disposable pruning in its verification.
      Move the snapshot writer into a test fixture helper under `scripts/test/`.
- [ ] Register both stores, add the shared log lock and compaction to `appendRemoval`, and prune
      transaction records through the file-set measurement.
- [ ] Update the documentation below and focused regression tests; run the validation below.

## Validation

Use real Git fixtures and harmless synthetic files. First demonstrate the relevant failures against
the current behavior, then assert final outcomes rather than only helper calls.

| Suite | Coverage |
| --- | --- |
| `scripts/test/worktree-lifecycle-check.mjs` | Removal, guards, consent, retry, and routes |
| `scripts/test/worktree-snapshot-check.mjs` | Legacy read, restore, and migration |
| `scripts/test/retention-policy-check.mjs` | New stores, compaction, and concurrent writers |
| `scripts/test/plan-close-integration-check.mjs`, `scripts/test/plan-suite-skills-check.mjs` | Close followed by cleanup; skill text |
| `scripts/test/cli-command-catalog-check.mjs`, `scripts/test/cli-surface-integration-check.mjs` | Command changes |
| `scripts/test/portal-ui/portal-ui.spec.mjs` | The Delete worktree dialog |

| Scenario | Required assertion |
| --- | --- |
| Clean landed branch; normal and squash merges | Checkout and branch removed; no new recovery refs |
| Local index/filesystem versions absorbed in merged history | Both proofs retained; actual removal succeeds without capture |
| Ignored Python/Node artifacts, including nested directories | Automatic cleanup succeeds; no broad parent exclusion |
| Unignored artifacts, tracked descendants, unknown ignored configuration | Unique work remains protected |
| `build/` with no project file; a disposable name containing `.git` | Not disposable; reaches the leftover choice |
| Ignored environment symlink; symlink inside `.venv` | External target survives; no traversal or automatic environment assumption |
| Ignored path needing Git quoting, such as a name with a space | Classified correctly |
| Approved unfamiliar ignored/untracked/tracked leftovers | One discard-all confirmation removes exactly the previewed target |
| Plan-leftover consent with unmerged implementation | Removal refused; broader discard not inferred |
| `cleanup --remove` on a clean checkout with unmerged commits | Refused, naming `discard`; commits intact |
| File/index/mode/tip/base change, new file, removed file after preview | Consent rejected; difference reported; no deletion |
| Change inside a disposable directory after preview | Consent still valid |
| Server writes a file during shutdown | Consent rejected after the post-shutdown recheck |
| Wrong repository, replayed receipt, expiry, recreated checkout | Refused without deleting new work |
| Removal request with no receipt, or the old boolean | Refused |
| File larger than 64 MiB; incomplete inventory | Large files can be safely previewed, or a concrete blocker keeps checkout |
| Global LFS filter config, detached worktree, unusual file names | Preview and Delete still work |
| Nested repository, unreadable entry | Named blocker keeps the checkout |
| Main/current checkout, locks, active plan, submodules, servers | Existing protections retained; no unrelated process stopped |
| Branch retirement or log/transaction write failure | Accurate partial outcomes; retry cannot discard moved/new work |
| Already-completed plan with cleanup remaining | Closure commit unchanged; cleanup resumes independently |
| UI deletion | One action, honest loss warning, complete categories, stale-preview refresh; no archive details |
| Legacy captured artifacts now classified disposable | Restore still verifies every captured entry |
| Legacy backup whose name suffix does not match its tip | Proof uses the object, not the name |
| Legacy unknown/unique/corrupt refs or changed ref identity | No deletion without required resolution and approval |
| Apply with a stale digest | Refused; report must be re-reviewed |
| Migration retry | Already-removed refs harmless; per-ref failures explicit; no forced pruning |
| Log and receipt pressure, concurrent repository writers | Fixed bounds enforced without losing valid concurrent records or widening consent |

Run the suites above, then these checks. CI runs the full gate; do not repeat it locally. Report
eligibility separately from actual native deletion if host restrictions block it.

```bash
npm run test:portal-ui -- --grep 'worktree'
bash scripts/doctor.sh --quiet
node scripts/test/docs-reference-check.mjs
bin/roborepo skill render-commands --check
bin/roborepo skill triggers --check
git diff --check
```

## Documentation impact

| Source | Required update |
| --- | --- |
| `docs/user/reference/repositories.md` | Permanent deletion, artifact policy, remaining-work choices, migration and partial retry; remove restore instructions for new removals |
| `docs/user/reference/roborepo-cli.md` | `discard` and `legacy-recovery`, narrowed `--remove`, `archive-remove` removal |
| `docs/user/reference/plans-portal.md` | Single deletion flow and separation of plan closure from cleanup |
| `docs/user/reference/architecture.md` | Two new rows in the local stores table |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | Quiet cleanup, explicit leftover consent, already-closed retry |
| `docs/internal/cli-internals.md` | Replace "Worktree snapshot transactions" with shared transaction ownership, bounded metadata and migration |
| `globals/packages/plan-suite/skills/plan-close/SKILL.md` | Canonical calls, consent boundaries and concise result reporting |
| `local/skills/roborepo-development/SKILL.md` | Remove the claim that worktrees are archived before removal; update the command list |

## Risks

| Risk | Safeguard |
| --- | --- |
| A confirmed deletion cannot be undone | Complete preview, one-use receipt, rechecks before mutation, and wording that says no backup exists |
| An external writer changes files after the last check | Stop writers operationally; report the limitation rather than claim atomic deletion |
| A recognized `build/` holds something unique | Ignore evidence plus project-file shape; anything else reaches the leftover choice |
| Hashing a large unknown ignored directory is slow | Streamed hashing and a 120-second budget, then a named blocker |
| Receipts hold paths and file digests in the state root | No contents, 7-day and 5 MiB bounds, machine-local storage |
| Removing archive creation strands old data | `archives` and `restore` remain; pending items surface through `cleanup` |

## Scope and decisions

Selective preservation is handled by keeping the checkout and moving valuable work through ordinary
workflows before a fresh cleanup preview; no per-file archive picker is introduced. Plan lifecycle
`archived/` still means an abandoned plan and is unaffected.

No remote branches or PRs are changed. No real worktree or legacy ref may be destroyed merely to
validate this feature. Ask before creating or switching implementation branches or worktrees.

Destroying this clone's legacy refs requires the user's approval of its concrete inventory at
implementation time. This plan does not grant that approval.

## Decision log

Decided during promotion, each reversible by refining this plan before implementation starts:

| Decision | Reason |
| --- | --- |
| A new `discard` command rather than more flags on `cleanup` | Preview and apply carry a receipt and a scope; `cleanup` keeps meaning proven-safe removal |
| `cleanup --remove` refuses unproven work | With no backup, `--confirm` alone would permanently delete unmerged commits with no preview |
| One transaction record per removal, also serving as the receipt | One-use consumption needs stored state, and a single file makes consumption and intent one atomic step |
| Disposable directories bound by identity, not content | Automatic cleanup removes them without consent, so binding adds no protection, and hashing `node_modules` is slow |
| `build/` needs a project file beside it | It has no marker of its own; an unrecognized one costs a single confirmation, not lost work |
| Consent inventory separate from `inventoryWorktree` | Reuse would break Delete wherever LFS or `autocrlf` is configured |
| Migration is CLI-only, with pending state derived from refs | The plan adds no archive UI, and refs are already the source of truth |
