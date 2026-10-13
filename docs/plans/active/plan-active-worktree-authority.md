---
id: 6q16tocb
priority: high
next_action: Confirm the `## Not tested` entries by hand, then merge the branch and run /plan-close.
blocked_by: []
depends_on:
  - a7bslb00
related:
  - age4cm7r
  - wk7p4n2
  - 7m4q9dx
  - a7bslb00
reviewed_commit: 77fb0952537f9afc2aea9866f52f13ebed678b59
worktree: plan-active-worktree-authority
---

# Make Active Plan State Follow Its Assigned Worktree

## Summary

A normal RoboRepo user runs one RoboRepo instance from the primary checkout (`main`). That instance
reads plan documents from every checkout of each known repository, including linked worktrees whose
branches have diverged from `main`. During implementation, the plan's progress is written in the
worktree, but today the portal shows the primary checkout's copy, so `/plan-start` copies the plan
back to `main` at the end of each run to keep the portal current.

This plan gives each plan exactly one authoritative copy, decided by its lifecycle stage:

| Stage | Authoritative copy |
| --- | --- |
| Backlog | Primary checkout |
| Active, with an assigned worktree that holds the plan | That worktree |
| Active, with no usable assigned worktree | Primary checkout |
| Completed or archived | Primary checkout, after integration |

The primary portal aggregates: it reads an active plan's content directly from its worktree and
never asks for it to be copied to `main`. Nothing synchronizes copies in either direction. Git
carries the worktree's plan to `main` when the branch merges, like any other file on the branch; the
one exception is abandoned work, which never merges, so `/plan-close` carries its plan to `main`
once, in the archive commit. The one check RoboRepo adds is whether the *other* copy was edited out
of turn; when it was, the plan shows a finding, and nothing is chosen, overwritten, or merged
automatically.

## Context

### Terms

| Term | Meaning |
| --- | --- |
| Primary checkout | The repository's main working tree, resolved from Git administrative state by `modules/plan-suite/checkouts.mjs`, not from the registry's first root |
| Assigned worktree | The linked worktree whose administrative name equals the primary copy's `worktree` frontmatter |
| Authoritative copy | The one copy of a plan that the portal shows and RoboRepo writes |
| Outside edit | A change to the non-authoritative copy of an active plan that the authoritative copy never had |
| Primary portal | The RoboRepo instance started from the primary checkout; the normal deployment |

### What exists today

Verified on `main` at `77fb095`, which includes [[a7bslb00]]'s worktree cleanup (`7627bfc`, #31).

- `modules/plan-suite/canonical-scan.mjs#scanRepository` reads every checkout, main first, and
  merges copies by plan `id`. The main copy always wins when it exists. When the copy in the plan's
  own worktree has a different content hash, the main record gets `divergentCheckouts` and an
  advisory `PLAN_DIFFERS_IN_WORKTREE` finding whose resolution says the main copy is the one the
  portal shows and edits. Copies in unrelated worktrees are ignored. A plan found only in a
  worktree is shown from there with `checkout` set to the worktree's label. The file is 187 lines,
  near the repository's file-size cap.
- `modules/plan-suite/checkouts.mjs#repositoryCheckouts` lists checkouts as
  `{ path, isMain, isWorktree, label }`. It enumerates linked worktrees through
  `modules/repositories/worktree-inventory.mjs#linkedWorktrees`, which already reads each
  worktree's `branch` from its administrative `HEAD`; `repositoryCheckouts` drops that field.
- `modules/plan-suite/index.mjs#updatePlanField` and `#movePlanLifecycle` write to the selected
  record's `absolutePath`, with optimistic `mtimeMs` checks. Whichever copy the scan selects is the
  copy the portal writes, so changing the selection changes where portal writes land.
- `planSnapshotFingerprint` decides when to rebuild the snapshot from directory stats under each
  checkout's `docs/plans`. It reads no Git refs.
- `globals/packages/plan-start/skills/plan-start/SKILL.md` Preflight item 14 and Implementation
  Workflow item 8 tell an implementation run to mirror plan updates into the primary checkout's copy
  once at the end, and `references/start-validation.md` calls the primary copy "the canonical
  plan". That mirroring was a user request recorded in [[age4cm7r]]'s Decision Log, made so the
  portal could show active progress.
- `globals/packages/plan-close/skills/plan-close/SKILL.md` edits the plan document throughout a
  run: validator fixes in step 2, corrected claims in step 3, `## Not tested` evidence in step 5.
  Step 4 archives superseded or abandoned plans, step 6 confirms the branch landed, step 7 moves a
  complete plan to `completed/`, and step 9 runs the worktree cleanup command scoped to the plan.
  #31 already removed step 6's old "post-merge plan synchronization" exception.
- Worktree cleanup decides whether a plan is still active from the primary checkout alone:
  `scripts/cli/worktree-policy.mjs#activeWorktreeNames` reads the `worktree` field of each plan in
  the primary checkout's `docs/plans/active/`, and
  `modules/repositories/worktree-guards.mjs#checkWorktreeRemoval` refuses automatic removal of an
  active plan's worktree or of one that has not landed, and refuses any removal, automatic or
  confirmed, of a worktree with uncommitted or untracked changes.
- `portal/home/worktree-dialogs.js` builds Home's Delete Worktree confirmation, which names the
  active plan still using the worktree.
- `docs/user/reference/plans-portal.md` documents the current copy table, including "The main
  checkout's copy is canonical".
- `scripts/test/plan-suite-canonical-check.mjs` asserts the current behavior: identical copies
  collapse, an unrelated behind worktree marks nothing, and the main copy wins when the assigned
  worktree differs.
- `modules/repositories/git-exec.mjs#defaultRunGitSync` is the synchronous, hardened Git path the
  snapshot build can call. Its read-only allow-list already includes `merge-base`, `rev-parse`, and
  `log`, which is all the outside-edit check needs. Its default timeout is 1500 ms.

### The mirror already drifts

On 2026-10-11 the primary copy of `docs/plans/active/git-worktree-lifecycle-cleanup.md` differed
from the copy in its assigned worktree: the worktree had a newer `next_action`, a newer
`reviewed_commit`, and rewritten §7 and §8. The portal showed the older primary copy, with a
**Differs in worktree** finding. This is the normal outcome of mirroring: the worktree keeps moving
and the mirror lags.

## Goals

- [x] Every plan has exactly one authoritative copy, decided by its lifecycle stage and its assigned
      worktree, never by which branch is ahead or behind.
- [x] The primary portal shows an active plan's content from its assigned worktree, with no copy to
      `main`.
- [x] RoboRepo writes only to the authoritative copy: portal mutations, skills, and commands.
- [x] An outside edit to the non-authoritative copy is reported as a finding; nothing merges,
      overwrites, or picks between copies automatically.
- [x] Authority moves only at defined lifecycle transitions: `/plan-start`, integration by merge,
      and `/plan-close`.
- [x] A worktree is never removed while it holds the only copy of its plan's current state.
- [x] Any RoboRepo instance, of any version, running from any checkout, derives authority from the
      same repository state, with nothing persisted or shared between instances.
- [x] `plan-start` stops mirroring plan updates into the primary checkout.

## Non-goals

- Synchronizing plan copies in either direction, or reconciling them on a schedule.
- A dedicated `roborepo/plans` branch, `canonicalPlanRef`, or any Git-ref-backed document store.
- A database, lockfile, lease, shared registry entry, or service that records which copy owns a plan.
- Preventing direct edits to plan Markdown. RoboRepo detects outside edits; it does not block them.
- CI that moves plan files, fails builds over plan copies, or commits plan changes.
- A Markdown editor in the portal.
- Automatically merging two edited copies.
- Changing the meaning of the `worktree` frontmatter field, or adding lifecycle states.
- Cross-machine collaboration. Git remains the transport between machines.

## Authority Model

### One rule

The primary copy decides **which stage** a plan is in, because every lifecycle transition is
committed there (`/plan-start` commits the start transition on the base branch; `/plan-close` moves
the plan on the base branch). During the active stage, the assigned worktree decides **what the plan
says**.

The worktree copy is authoritative only when all of these hold:

1. the primary copy is in `docs/plans/active/` and names a worktree;
2. Git has a linked worktree with that administrative name;
3. that worktree holds a readable copy with the same `id`, still in `docs/plans/active/`, naming the
   same worktree.

Otherwise the primary copy is authoritative. Condition 3 makes the handoff at start atomic: the
worktree copy becomes usable only once the worktree contains the start-transition commit, which
`roborepo plans start` fast-forwards into a fresh worktree.

```mermaid
flowchart TD
    P{"primary copy in active/<br/>and names a worktree?"}
    P -->|no| M["primary copy is authoritative"]
    P -->|yes| W{"that worktree exists and its copy<br/>is in active/ naming the same worktree?"}
    W -->|no| F["primary copy is authoritative<br/>+ PLAN_WORKTREE_COPY_UNAVAILABLE"]
    W -->|yes| A["worktree copy is authoritative"]
    A -->|then checks the primary copy| C{"primary copy holds a version<br/>the worktree never had?"}
    C -->|no| Q["no finding"]
    C -->|yes| E["PLAN_EDITED_OUTSIDE_WORKTREE"]
```

### Every case

| Plan condition | Authoritative copy | Finding |
| --- | --- | --- |
| Backlog, completed, or archived in the primary checkout | Primary | none |
| Active in the primary, no `worktree` | Primary | none |
| Active in the primary, assigned worktree holds a usable copy | Worktree | `PLAN_EDITED_OUTSIDE_WORKTREE` only when the primary copy has an outside edit |
| Active in the primary, assigned worktree missing, its copy missing or unreadable, or its copy no longer in `active/` or naming a different worktree | Primary | `PLAN_WORKTREE_COPY_UNAVAILABLE`, with the reason |
| Present only in a worktree | That worktree, labeled with its name, as today | none |
| A copy in any unassigned worktree | Never | none |

A worktree being behind or ahead of `main` changes nothing in this table.

### Outside edits

The worktree copy is free to change; that is normal progress, and RoboRepo never reports it. The
check runs only on the non-authoritative primary copy of an active plan.

The primary copy is consistent when its bytes equal a version of the plan that the worktree's own
history already contains:

- the plan at the merge base of the primary checkout's `HEAD` and the worktree branch, read at the
  primary copy's path; or
- any plan blob the worktree branch's own commits produced (`git log --raw --no-abbrev --format=
  <base>..<branch> -- docs/plans`); or
- the worktree's current working bytes.

Anything else is an outside edit. Matching by content needs no path tracking: a blob that equals
the primary copy byte for byte carries the same `id`. The primary copy's blob id is computed in
process from its working bytes, using the hash function that `git rev-parse --show-object-format`
names (SHA-1 or SHA-256), because `hash-object` is not on the read-only allow-list.

| What happened to the primary copy | Consistent? | Why |
| --- | --- | --- |
| Nothing since `/plan-start` | yes | equals the merge-base version |
| The branch was squash- or rebase-merged and `main` pulled | yes | equals a blob the branch produced |
| `main` was merged into the worktree after an edit on `main` | yes | the merge base moved past the edit |
| Edited on `main`, committed or not, and not yet merged into the worktree | no | the worktree never had that version |
| An older RoboRepo portal wrote a priority change to the primary copy | no | same as any outside edit |

The check is a pure function of current Git and filesystem state. It persists nothing, and it is
recomputed on every snapshot rebuild, so rebases and moving merge bases need no special handling.
It runs only when the two copies differ, and costs one `merge-base`, one `rev-parse`, and one `log`
per such plan. When Git cannot answer (a detached primary or worktree `HEAD`, a missing branch, a
timeout), the plan gets `PLAN_AUTHORITY_UNCHECKED` instead of a guess.

### Resolving an outside edit

RoboRepo reports and stops there. The finding names both copies and offers the two Git-native
resolutions:

- merge the base branch into the worktree, which brings `main`'s edit into the authoritative copy
  through an ordinary Git merge and its conflict handling; or
- move the edit into the worktree copy by hand, then revert it in the primary checkout.

The portal keeps showing the worktree copy while the finding stands.

## Lifecycle Transitions

The normal story:

1. `/plan-start` commits the start transition in the primary checkout and fast-forwards the fresh
   worktree to it. The worktree copy becomes authoritative.
2. Implementation runs edit the plan in the worktree. The primary portal shows those edits as they
   happen, and the primary copy stays as `/plan-start` left it.
3. The branch merges into `main` through a PR, and the primary checkout pulls. The primary copy now
   equals the worktree copy.
4. `/plan-close` first confirms the worktree's plan copy is already in `main`. From then on it
   works only in the primary checkout: verification and the move to `completed/` happen there, and
   the move returns authority to the primary copy for good.
5. `/plan-close` step 9 removes the worktree through [[a7bslb00]]'s cleanup command, since its plan
   is no longer active. A later pull's post-merge cleanup hook would do the same.

```mermaid
stateDiagram-v2
    [*] --> Primary: plan-write creates it in backlog/
    Primary --> Worktree: /plan-start commits the transition and fast-forwards the worktree
    Worktree --> Worktree: implementation edits the worktree copy
    Worktree --> Integrated: the branch merges and main is pulled
    Integrated --> Worktree: a new edit in the worktree un-lands the plan copy
    Integrated --> Closing: /plan-close confirms the worktree holds nothing main lacks
    Closing --> Closed: /plan-close records verification and moves the plan
    Closing --> Integrated: /plan-close refuses; its notes stay in the primary copy
    Worktree --> Closed: /plan-close archives abandoned work, carrying the worktree copy
    Worktree --> Primary: the worktree copy becomes unusable, or worktree is cleared
    Closed --> [*]: /plan-close step 9 or the post-merge hook removes the worktree
```

`Integrated` names the state in which `main` already has every plan version the worktree has. The
portal still selects the worktree copy there, because the rule above depends only on repository
state and the plan is still in `active/`. `Closing` is a `/plan-close` run: from its integration
check on, the run writes only the primary copy, and the portal follows once the plan leaves
`active/`.

Authority changes hands only at these points:

| Transition | Who | Authority before → after | Safeguard |
| --- | --- | --- | --- |
| Start | `/plan-start` → `roborepo plans start`, from the primary checkout | primary → worktree | unchanged transition: plan-only commit on the base branch, fast-forward of a fresh worktree; the worktree copy becomes usable only once it contains that commit |
| Implementation | `plan-start`, `plan-write`, `session-close`, the portal | worktree | every write goes to the worktree copy; nothing is copied to `main` |
| Merge main into the worktree | the user | worktree | Git merges `main`'s plan edits into the worktree copy and reports conflicts itself |
| Merge the branch into `main` | the user, through a PR | worktree; the primary copy now equals it | the primary copy matches a blob the branch produced, so no finding |
| Close as completed | `/plan-close`, from the primary checkout | worktree → primary, at the start of the run | new integration check, below, before any other step; then every plan edit goes to the primary copy, followed by the existing landed check and move |
| Close as archived | `/plan-close`, from the primary checkout | worktree → primary | archive handoff, below: the worktree copy is carried into the primary checkout once, refused on an outside edit |
| Release without closing | the user clears `worktree` in the primary copy | worktree → primary | explicit; the worktree copy is ignored from then on |
| Automatic worktree cleanup | `/plan-close` step 9, or [[a7bslb00]]'s post-merge hook | none | its plan-active guard reads the primary checkout's `active/` folder, so it waits for `/plan-close` |
| Confirmed worktree removal | the user, from Home or the cleanup command | worktree → primary, with `PLAN_WORKTREE_COPY_UNAVAILABLE` | [[a7bslb00]]'s clean-tree guard keeps uncommitted edits; the archive ref keeps committed ones |

### Integration check in `/plan-close`

By the time a plan is complete, its branch has merged and `main` has been pulled, so the worktree
has nothing left to contribute. `/plan-close` therefore reads the worktree once, at the very start
of the run, and otherwise works only in the primary checkout.

1. **Integration check, before step 1.** When the plan names a worktree whose copy is usable,
   `/plan-close` confirms that the worktree holds no plan version `main` never had: the worktree's
   working bytes for the plan equal the primary copy's working bytes, or a plan blob in the primary
   checkout's history since the branch's fork (`git log --raw --no-abbrev --format=
   <fork>..HEAD -- docs/plans`, run in the primary checkout). This is the outside-edit check with
   the two checkouts swapped. When the worktree copy is unavailable, the check is skipped, and the
   report says the worktree's plan state was not available.
2. **Not integrated.** If the worktree holds a version `main` never had, its plan progress has not
   landed. `/plan-close` refuses with `plan: not integrated`, naming the worktree and the plan path,
   and makes no plan edits. It never copies the worktree's version into `main`. The only other
   outcome of such a run is archiving superseded or abandoned work through the archive handoff
   below.
3. **Integrated.** Authority returns to the primary checkout for the rest of the run. Every plan
   edit in steps 2 through 7 — validator fixes, corrected claims, `## Not tested` evidence,
   verification, the move to `completed/` — goes to the primary copy.
4. **Refusal after the check.** If a later step refuses (unfinished work, an unconfirmed
   `## Not tested` entry, `landed: unconfirmed`), the plan stays in `active/` and its notes stay in
   the primary copy. Nothing is copied to the worktree. Until the plan closes, the portal shows the
   worktree copy with `PLAN_EDITED_OUTSIDE_WORKTREE` pointing at those notes. The finding clears
   when a rerun of `/plan-close` succeeds, which the notes do not block because `main` already has
   every version the worktree has, or when the user merges `main` into the worktree to resume work
   there.

This check is what keeps cleanup safe. Step 9's cleanup and the post-merge hook wait until the plan
leaves `active/`, and the plan leaves `active/` only through `/plan-close`, which refuses while the
worktree holds unlanded plan state. Between merging the PR and running `/plan-close`, the plan
should not be edited in the worktree. An edit made there is either uncommitted, which fails the
clean-tree guard, or a new commit, which makes the branch no longer landed; either way the worktree
is kept.

### Archive handoff in `/plan-close`

Abandoned or superseded work never merges, so Git never brings the worktree's plan copy, including
the reason the work stopped, to `main`. Closing as archived (step 4's superseded or abandoned
verdict) therefore carries it there once:

| Copies | `/plan-close` archiving does |
| --- | --- |
| Worktree copy integrated, as the integration check defines it | records the reason in the primary copy and moves it to `archived/`, as today |
| Worktree copy authoritative, primary copy consistent | writes the worktree copy's content into the primary copy, records the reason, and moves it to `archived/`, all in one archive commit on the base branch |
| Primary copy has an outside edit | refuses with `plan: conflicting copies`, naming both; the user resolves it as in "Resolving an outside edit" |
| Worktree copy unavailable | archives the primary copy and states in the report that the worktree's plan state was not available |

This is the only place RoboRepo copies plan content between checkouts. It runs once, in one
direction, at a lifecycle transition, and never merges two edited copies.

## Multiple Portal Instances

Developing RoboRepo itself can mean several portals at once, each started from a different
worktree and possibly running a different RoboRepo version. They need no coordination, because:

- authority is derived from Git and filesystem state on every scan, and never stored;
- `repositoryCheckouts` resolves the primary checkout from Git's administrative files, so a portal
  started from a worktree still treats the primary checkout as primary;
- the scan writes nothing; the only writes are user-initiated mutations, each guarded by an
  `mtimeMs` check on the file it writes.

A portal that predates this plan still shows and writes the primary copy. Its writes are outside
edits, and every instance that has this plan reports them as `PLAN_EDITED_OUTSIDE_WORKTREE`.

## Proposed Design

### 1. A pure authority resolver

Add `modules/plan-suite/plan-authority.mjs`, separate from checkout discovery and from the scan
loop:

- `resolvePlanAuthority({ primary, assigned })` takes the primary copy and the assigned worktree's
  copy (either may be absent) and returns `{ source, reason }` per the rule above. It is pure.
- `checkOutsideEdits({ primary, assigned, git })` runs only when `source` is `worktree` and the bytes
  differ. It asks Git, through `defaultRunGitSync` in `modules/repositories/git-exec.mjs` (the
  snapshot build is synchronous), for the merge base, the base blob, and the branch's plan blobs,
  computes the primary copy's blob id in process, and returns `consistent`, `outside-edit` (with
  whether it is committed), or `unchecked`. It needs the worktree's branch, so
  `repositoryCheckouts` carries the `branch` that `linkedWorktrees` already reads; a detached
  worktree returns `unchecked`.

`/plan-close`'s integration check is the same comparison with the checkouts swapped. It stays skill
prose with explicit Git commands, as step 6's landed check does; no new CLI command is added.

`canonical-scan.mjs` stays orchestration: enumerate checkouts, collect copies per `id`, call the
resolver, and build the snapshot.

### 2. The scan returns the authoritative record

Change `scanRepository` so it collects the primary copy and the assigned worktree's copy for each
plan before choosing a record, then returns the authoritative one. Only the selected copy needs a
full `readPlanRecord`; other copies still need only their `id` and hash, as today.

Each public plan carries a compact, path-free authority object:

```json
{ "authority": { "source": "worktree", "worktree": "plan-active-worktree-authority" } }
```

`source` is `primary` or `worktree`; `worktree` is set only for `worktree`. Remove
`divergentCheckouts` and `PLAN_DIFFERS_IN_WORKTREE`; the authority object and the findings below
replace them.

Repository grouping, `id` and key resolution, relationships, lifecycle counts, and Home's
plan-to-worktree join (`repository-overview-projections.mjs#associatePlans`, which joins on the
`worktree` field) are unchanged. The lifecycle a plan is counted under is the primary copy's, which
an authoritative worktree copy shares by condition 3.

An unreadable plan file is a scan error reported by its repository-relative path, never a record:
in an assigned worktree it leaves the primary copy to stand in with `PLAN_WORKTREE_COPY_UNAVAILABLE`.
Two copies with one `id` in the assigned worktree are a genuine duplicate there, so both are returned
with `DUPLICATE_PLAN_ID`, as in the primary checkout.

Add to `planSnapshotFingerprint` the `HEAD` file of the primary checkout and of each linked
worktree, the loose ref or `packed-refs` stat it points to, and, in a reftable repository, the
shared and per-worktree `reftable/tables.list`. A merge of `main` into a worktree
can change the outside-edit result without touching any plan file, and the fingerprint must notice.
Move the fingerprint and its `statPlanTree` helper into `modules/plan-suite/snapshot-fingerprint.mjs`
so `canonical-scan.mjs` stays a short orchestrator within the file-size cap.

### 3. Findings

Add to `modules/plan-suite/findings.mjs`, all advisory:

| Code | When | Message names | Resolution |
| --- | --- | --- | --- |
| `PLAN_EDITED_OUTSIDE_WORKTREE` | The primary copy of an active plan holds a version its worktree never had | the worktree, and whether the edit is committed | Merge the base branch into the worktree, or move the edit into the worktree copy and revert it in the primary checkout. RoboRepo shows the worktree copy and merges nothing |
| `PLAN_WORKTREE_COPY_UNAVAILABLE` | The primary copy names a worktree whose copy is not usable | the worktree and the reason: worktree missing, copy missing or unreadable, copy left `active/`, or copy names another worktree | Restore the worktree, land its plan changes, or clear `worktree` to release the plan to the primary checkout. Progress recorded only in the worktree is not shown |
| `PLAN_AUTHORITY_UNCHECKED` | Git could not establish the merge base or branch history | the worktree and the Git failure, without paths | Showing the worktree copy; an outside edit to the primary copy cannot be ruled out |

Like `PLAN_DIFFERS_IN_WORKTREE` today, each appears in the drawer's warnings and the Warnings filter.
None of them blocks a lifecycle move or an edit.

### 4. Writes follow authority

Because portal mutations already write the selected record's file, selecting the worktree copy
routes them there. Make that explicit and close the one gap:

- Plan document reads and `updatePlanField` (priority) write the authoritative copy, with the
  existing `mtimeMs` check on that file.
- `movePlanLifecycle` refuses when `authority.source` is `worktree`, with a new domain error
  `LIFECYCLE_OWNED_BY_PRIMARY`: lifecycle moves are committed in the primary checkout, so moving
  the worktree copy would create a second lifecycle. Its resolution points to `/plan-close`, or to
  clearing `worktree` first. The dropdown stays a manual override wherever the primary copy is
  authoritative.
- `roborepo plans start` is unchanged; it already runs in the primary checkout.
- Audit `scripts/cli/plans.mjs` and `scripts/cli/portal-routes-plans.mjs` for any other path that
  resolves a plan from the global snapshot and assumes the primary checkout.

### 5. Skills follow the same rule

Write the rule once, in `globals/packages/plan-write/skills/plan-write/references/plan-schema.md`,
as a "Plan authority" section beside "Worktree association", in tool-neutral prose. Each suite
skill applies it rather than restating it:

| Skill | Change |
| --- | --- |
| `plan-start` | Delete Preflight item 14's synchronization sentence and Implementation Workflow item 8. State that after `APPROVED` the worktree copy is the plan, and every plan update, including `## Not tested` entries, goes there. In `references/start-validation.md`, stop calling the primary copy "the canonical plan" and drop "Plan status updates still go to the primary checkout's canonical copy" |
| `plan-write` | Before editing an active plan, resolve the authoritative copy by the rule and edit only that copy. When the rule falls back to the primary copy because the worktree copy is unavailable, or the primary copy has an outside edit, report it and edit nothing else. A session started in the primary checkout may need write access to the worktree for this; it asks for that access rather than falling back to the primary copy |
| `session-close` | No change expected: it delegates plan syncing to `plan-write`. Confirm no text tells it to copy to the primary checkout |
| `plan-close` | Add the integration check as the first action of a run, before step 1, and state that after it every plan edit goes to the primary copy, including the notes of a later refusal. Add the archive handoff to step 4's archive path. Step 6's old synchronization exception is already gone |

### 6. Portal presentation

- The Plans drawer shows where the plan was read from ("From worktree `<name>`") when
  `authority.source` is `worktree`, and renders the three findings in the existing warning section.
- Normal worktree progress is quiet: no badge, no warning.
- Home adds no badge. Its worktree row already represents the plan, and a separate badge would
  restate the drawer.
- Home's Delete Worktree confirmation, when it names an active plan, adds that the plan's progress
  recorded in the worktree will no longer be shown in Plans.
- When `movePlanLifecycle` refuses, the existing domain-error surface shows the message and
  resolution.

## Affected Repository Files

| Area | Path | Change |
| --- | --- | --- |
| Authority | `modules/plan-suite/plan-authority.mjs` | New: `resolvePlanAuthority` and `checkOutsideEdits` |
| Scan | `modules/plan-suite/canonical-scan.mjs` | Collect copies, return the authoritative record, add `authority`, remove `divergentCheckouts` and `markDiverged` |
| Fingerprint | `modules/plan-suite/snapshot-fingerprint.mjs` | New: `planSnapshotFingerprint` moved out of `canonical-scan.mjs`, extended with `HEAD` refs; `modules/plan-suite/index.mjs` re-exports it from the new file |
| Checkout listing | `modules/plan-suite/checkouts.mjs` | Carry `branch` from `linkedWorktrees` into each worktree checkout |
| Findings | `modules/plan-suite/findings.mjs` | Add the three codes; remove `PLAN_DIFFERS_IN_WORKTREE` |
| Mutations | `modules/plan-suite/index.mjs` | `movePlanLifecycle` refusal; `publicPlan` carries `authority` |
| Routes and CLI | `scripts/cli/portal-routes-plans.mjs`, `scripts/cli/plans.mjs` | Audit; change only where a path assumes the primary copy |
| Plans UI | `portal/plans/plan-drawer.js`, `portal/plans/plan-drawer-partial.html` | "From worktree" line |
| Home UI | `portal/home/worktree-dialogs.js` | Delete Worktree confirmation sentence |
| Plan schema | `globals/packages/plan-write/skills/plan-write/references/plan-schema.md` | "Plan authority" section |
| Skills | `globals/packages/plan-start/skills/plan-start/SKILL.md`, its `references/start-validation.md`, `globals/packages/plan-write/skills/plan-write/SKILL.md`, `globals/packages/plan-close/skills/plan-close/SKILL.md` | As in §5. The rendered `generated/packages/*/commands/` files carry only each skill's frontmatter `description`, so they need regenerating only if a description changes |
| Checks | `scripts/test/plan-suite-canonical-check.mjs`, `scripts/test/plan-suite-check.mjs`, `scripts/test/plan-suite-findings-check.mjs`, `scripts/test/plans-portal-state-check.mjs`, `scripts/test/plan-promote-plan-start-check.mjs`, `scripts/test/portal-ui/portal-ui.spec.mjs` | Replace the main-copy-wins assertions; add the fixture cases, skill-text assertions, and dialog assertion in Validation |
| Docs | `docs/user/reference/plans-portal.md`, `docs/user/guides/plan/lifecycle/plan-suite.md` | Replace the copy table and "main checkout's copy is canonical"; describe the integration check |

## Implementation Plan

### Phase 1 — Authority resolver and outside-edit check

- [x] Add `modules/plan-suite/plan-authority.mjs` with `resolvePlanAuthority`, covering every row of
      the "Every case" table.
- [x] Carry each worktree's `branch` through `repositoryCheckouts`.
- [x] Add `checkOutsideEdits` through the read-only Git path, covering every row of the "Outside
      edits" table, uncommitted primary edits, a detached worktree, and the `unchecked` case.
- [x] Unit-test the resolver as a pure function, and the check against temporary fixture
      repositories with a primary checkout and a linked worktree.

### Phase 2 — Scan and findings

- [x] Refactor `scanRepository` to collect copies and return the authoritative record, keeping one
      full record per plan.
- [x] Add the `authority` object; remove `divergentCheckouts`, `markDiverged`, and
      `PLAN_DIFFERS_IN_WORKTREE`.
- [x] Add the three findings and their messages.
- [x] Move `planSnapshotFingerprint` into `snapshot-fingerprint.mjs` and extend it with `HEAD` and
      ref state.
- [x] Rewrite the main-copy-wins assertions in `plan-suite-canonical-check.mjs`.

### Phase 3 — Writes

- [x] Add the `LIFECYCLE_OWNED_BY_PRIMARY` refusal to `movePlanLifecycle`.
- [x] Confirm `updatePlanField` and document reads use the authoritative copy, with fixture tests.
- [x] Audit `scripts/cli/plans.mjs` and `scripts/cli/portal-routes-plans.mjs`.

### Phase 4 — Skills and schema

[[a7bslb00]]'s rewrite of `/plan-close` steps 6 through 9 has landed, so this phase edits that
file as it stands now.

- [x] Add "Plan authority" to `plan-schema.md`.
- [x] Remove mirroring from `plan-start` and `start-validation.md`.
- [x] Add authority resolution to `plan-write`; confirm `session-close` needs nothing.
- [x] Add the integration check as `plan-close`'s first action, the primary-only rule for every
      later plan edit and refusal note, and the archive handoff on step 4's archive path.
- [x] If a skill's frontmatter `description` changed, regenerate the rendered commands with
      `scripts/build/render-slash-commands.mjs`.
- [x] Add the skill-text assertions from Validation to `scripts/test/plan-promote-plan-start-check.mjs`.

### Phase 5 — Portal and docs

- [x] Add the "From worktree" line to the Plans drawer and render the new findings.
- [x] Add the progress sentence to Home's Delete Worktree confirmation.
- [x] Update `docs/user/reference/plans-portal.md` and the plan-suite guide.

## Validation

Focused checks while iterating:

```text
node scripts/test/plan-suite-canonical-check.mjs
node scripts/test/plan-authority-check.mjs
node scripts/test/plan-suite-authority-scan-check.mjs
node scripts/test/plan-suite-authority-edge-check.mjs
node scripts/test/plan-close-integration-check.mjs
node scripts/test/plan-suite-check.mjs
node scripts/test/plan-suite-commands-check.mjs
node scripts/test/plan-suite-findings-check.mjs
node scripts/test/plan-promote-plan-start-check.mjs
node scripts/test/plans-portal-state-check.mjs
node scripts/test/repository-overview-check.mjs
npm run test:portal-ui
```

Fixture coverage, each a temporary repository with a primary checkout and at least one linked
worktree:

- [x] An active plan edited only in its assigned worktree is returned from the worktree, with
      `authority.source: "worktree"` and no finding.
- [x] A worktree that is behind `main` and never touched the plan changes nothing: the plan is read
      from the worktree, and there is no finding.
- [x] An uncommitted edit to the primary copy produces `PLAN_EDITED_OUTSIDE_WORKTREE`; so does a
      committed one; merging `main` into the worktree clears it.
- [x] After a squash merge of the branch and a pull in the primary checkout, there is no finding.
- [x] A missing worktree, a missing worktree copy, a worktree copy moved out of `active/`, and a
      worktree copy naming another worktree each fall back to the primary copy with
      `PLAN_WORKTREE_COPY_UNAVAILABLE` and the matching reason.
- [x] A worktree that does not yet contain the start-transition commit is not authoritative.
- [x] A copy in an unassigned worktree is never authoritative and produces no finding.
- [x] An unresolvable merge base produces `PLAN_AUTHORITY_UNCHECKED`.
- [x] A worktree-only plan is still shown, labeled with its worktree.
- [x] Changing an active plan's priority from the portal writes the worktree copy and leaves the
      primary copy byte-identical.
- [x] Changing a backlog plan's priority writes the primary copy.
- [x] Moving a worktree-authoritative plan out of `active/` from the portal is refused with
      `LIFECYCLE_OWNED_BY_PRIMARY`, and neither copy changes.
- [x] Merging `main` into a worktree without touching any plan file changes the snapshot
      fingerprint.
- [x] `/api/plans` output contains no absolute path.
- [x] A worktree whose `HEAD` is detached produces `PLAN_AUTHORITY_UNCHECKED`.
- [x] Skill checks: `plan-start` contains no instruction to copy plan updates to the primary
      checkout; `plan-close` runs the integration check before step 1, sends every later plan edit
      and refusal note to the primary copy, and describes the archive handoff.
- [x] Portal UI: the Delete Worktree confirmation for a plan's worktree says the plan's worktree
      progress will no longer be shown.
- [x] A registry that knows only the worktree, or knows it before the primary checkout, still
      returns the assigned worktree's copy.
- [x] A second clone whose directory has the assigned worktree's name is never authoritative; a plan
      found only in that clone is labeled with the clone's directory.
- [x] An unreadable copy in the assigned worktree falls back to the primary copy with
      `PLAN_WORKTREE_COPY_UNAVAILABLE` (`copy-missing`), the repository scan still succeeds, and the
      file is listed as a scan error by its relative path.
- [x] Two copies with one `id` in the assigned worktree are both shown with `DUPLICATE_PLAN_ID`.
- [x] A merge into a worktree whose branch ref was packed changes the fingerprint.
- [x] In a reftable repository, an outside edit is reported rather than left unchecked, and a commit
      or merge in a worktree changes the fingerprint.
- [x] Each authority finding's message names its worktree and reason, and its resolution offers the
      documented way out.
- [x] `/plan-close`'s step 0 and archive commands, read from the shipped skill and run against a
      squash-merged fixture, give the documented verdicts: integrated after a squash merge and after a
      refusal note, not integrated after new worktree progress, integrated for a plan the worktree
      never edited, and `plan: conflicting copies` for an outside edit until `main` is merged.

Because this changes shared Plans behavior, portal-visible state, and rendered skill output, finish
with the repository gate:

```text
npm run check
```

## Success Criteria

- An active plan progresses in its worktree, and the primary portal shows that progress with no copy
  to `main`.
- Each plan has one authoritative copy, and every RoboRepo write goes to it.
- A worktree that is behind or ahead of `main` never changes which copy is authoritative and never
  produces a finding by itself.
- An outside edit to the primary copy is reported, and neither copy is changed by RoboRepo.
- `/plan-close` refuses to complete a plan whose worktree holds unlanded plan state, so cleanup never
  removes the only copy of it, and once its check passes it edits only the primary copy.
- An archived plan on `main` carries its worktree's final plan content, including why the work
  stopped.
- Two portals of different versions, started from different checkouts, show the same authoritative
  copy for every plan, with no shared state between them.
- No synchronization machinery, database, plan branch, lockfile, CI mover, or editor is introduced.

## Risks

| Risk | Mitigation |
| --- | --- |
| A rebase or a merge of `main` changes the merge base mid-story | The check is recomputed from current Git state on every rebuild and persists nothing; the fingerprint includes `HEAD` refs |
| The plan's important state is uncommitted | The worktree's working bytes are the authoritative content and an accepted version in the check; the primary copy's working bytes are what is checked |
| A Git clean filter or line-ending conversion makes identical text hash differently | The blob id is computed in process from working bytes, with no filters applied, so a repository whose filters rewrite Markdown can see a false outside edit. The finding is advisory, and the fixture covers plain Markdown only |
| The assigned worktree is removed while the plan is active | Fallback to the primary copy with `PLAN_WORKTREE_COPY_UNAVAILABLE`; [[a7bslb00]]'s archive ref holds committed progress, and its clean-tree guard refuses removal over uncommitted progress |
| A plan is edited in the worktree after its PR merged | `/plan-close`'s integration check refuses; the edit lands through another merge, or is discarded |
| `/plan-close` refuses after the integration check | Its notes stay in the primary copy and show as an outside edit until the plan closes or `main` is merged into the worktree; the integration check still passes on the rerun |
| A session in the primary checkout edits an active plan whose worktree is outside its write scope | `plan-write` asks for write access to the worktree and never falls back to editing the primary copy |
| The repository uses SHA-256 object ids | The in-process blob id uses the hash named by `git rev-parse --show-object-format` |
| An older RoboRepo version writes the primary copy | Reported as an outside edit by every current instance |
| Two copies are edited and the user wants them combined | Git merges them when `main` is merged into the worktree; RoboRepo never does |
| Cross-machine unpushed edits | Out of scope; Git is the transport between machines |

## Implementation Notes

- Copy collection and selection live in `modules/plan-suite/plan-copies.mjs`; `canonical-scan.mjs`
  is the orchestrator, and `snapshot-fingerprint.mjs` holds the fingerprint.
- The "From worktree" line is a meta row built in `portal/plans/templates.js#drawerContent`;
  `plan-drawer.js` and its partial render meta rows unchanged.
- Phase 3 audit: `scripts/cli/plans.mjs` reads, prompts, and mutations all resolve plans from the
  snapshot, which now returns the authoritative copy, and `readPlanDocument` bounds the file by the
  record's own checkout root. `portal-routes-plans.mjs` serializes any domain error generically.
  Neither needed a change.
- No skill frontmatter `description` changed, so the rendered commands were not regenerated.
- Fixture coverage: `scripts/test/plan-authority-check.mjs` (resolver table, outside-edit check
  including squash, rebase, unresolvable merge base, detached `HEAD`s, SHA-256),
  `scripts/test/plan-suite-authority-scan-check.mjs` (scan, findings, writes, fingerprint,
  `/api/plans`), `scripts/test/plan-suite-authority-edge-check.mjs` (registration order, second
  clones, unreadable and duplicate worktree copies, packed refs, reftable),
  `scripts/test/plan-close-integration-check.mjs` (the skill's own Git commands),
  `testAuthorityFindingsExplainThemselves` in `plan-suite-findings-check.mjs`, and the existing
  canonical, skill-text, and portal UI checks.
- `npm run check` runs `test-cli.sh` and only the `ci` group of `run-checks.mjs`, so a new
  `*-check.mjs` is not in the gate by being discovered. The canonical, authority, edge, and
  `/plan-close` integration checks are registered in `test-cli.sh` beside the other plan-suite
  suites.

## Not tested

- [x] On the real primary portal, an active plan whose worktree holds its copy shows the worktree's
      content, the **From worktree** line, and no warning. The fixtures cover the scan; this needs
      the user's own repositories and a browser.
      Confirmed by the user on 2026-10-13 against a portal running this branch's code (port 4339),
      side by side with one running `main`'s earlier code (port 4317). For `6q16tocb`, 4339 shows the
      worktree's `next_action` and progress, `read from: From worktree plan-active-worktree-authority`,
      and no authority warning, while 4317 shows the primary copy's stale `next_action` with
      "Differs in worktree". In the same session, `3jp3yhtq` showed its worktree's `next_action` with
      the From worktree row and a correct `PLAN_EDITED_OUTSIDE_WORKTREE` for close-review notes left
      uncommitted in the primary copy; the warning cleared once that plan moved to `completed/`.
      `koww80zh` showed no From worktree row and `PLAN_WORKTREE_COPY_UNAVAILABLE` ("the worktree's copy
      is not in active/"), because its worktree had already moved its copy to `completed/`.
- [ ] `/plan-close` on a merged plan with a worktree runs the integration check before step 1 and
      then edits only the primary copy; on an unmerged plan it refuses with `plan: not integrated`.
      Skill prose is checked only for presence; following it needs an agent run.
- [ ] `/plan-close` archiving abandoned work carries the worktree copy into the primary copy once,
      and refuses with `plan: conflicting copies` when the primary copy has an outside edit. Needs
      an agent run against a real abandoned branch.
- [ ] `/plan-write` invoked from the primary checkout on an active, worktree-assigned plan asks for
      worktree access and edits the worktree copy. Needs an agent run.
- [ ] Two portals started from different checkouts show the same authoritative copy for every plan.
      The scan is stateless and covered from one checkout; running two portals side by side needs a
      manual session.

## Open Questions

None.

## Decision Log

### 2026-10-12 — A duplicate `id` in the assigned worktree shows every copy

**Decision:** When the assigned worktree holds more than one copy with the plan's `id`, the scan
returns all of them from the worktree, each carrying `DUPLICATE_PLAN_ID`. Authority is resolved from
the copy in `active/` that names the worktree. Confirmed by the user.

**Alternatives considered:** fall back to the primary copy with a new `copy-duplicated` reason; leave
the first file in sort order to win.

**Reason:** File order silently hid the real copy behind a stray one. Reporting both matches how a
duplicate in the primary checkout is already shown.

### 2026-10-12 — In a reftable repository, Git names the worktree's branch

**Decision:** When a worktree's `HEAD` file holds reftable's `refs/heads/.invalid` placeholder, the
outside-edit check asks Git for the checked-out branch with `symbolic-ref`, one extra read-only call
made only when the copies differ. `worktree-inventory.mjs` is unchanged. Confirmed by the user.

**Alternatives considered:** fix the shared inventory so it never reports `.invalid`; record
reftable as a known gap.

**Reason:** The placeholder made every differing plan `PLAN_AUTHORITY_UNCHECKED`. The inventory
avoids subprocesses by design and serves other callers, so the fix stays where the branch is used.

### 2026-10-12 — A worktree-only plan carries no authority object

**Decision:** A plan with no primary copy has `authority: null`; its `checkout` label still names
where it was read. `movePlanLifecycle` refuses only when `authority.source` is `worktree`, so a
worktree-only plan keeps today's manual lifecycle override.

**Alternatives considered:** `{ source: "worktree" }` for worktree-only plans too, which would make
the portal refuse their lifecycle moves; a third `source` value.

**Reason:** The refusal exists because the primary copy owns the lifecycle; a worktree-only plan has
no primary lifecycle to protect. "Present only in a worktree … as today" keeps its moves working,
and the two-value `source` contract stays as specified.

### 2026-10-12 — `/plan-close`'s integration check also accepts the plan at the fork

**Decision:** The worktree copy is integrated when it equals the primary copy, the plan at the
branch's fork, or a plan blob the base branch produced since the fork.

**Alternatives considered:** only the primary copy or blobs produced since the fork, as written.

**Reason:** A worktree that never edited its plan holds the fork's version, which the base branch
already had; without it, an outside edit on the base branch would make such a plan "not
integrated" although the worktree holds nothing new.

### 2026-10-12 — The archive handoff is staged, not committed, by `/plan-close`

**Decision:** The skill describes the archive handoff as one archive change staged by path on the
base branch, rather than "one archive commit".

**Reason:** `/plan-close` commits only when the user asks; the handoff keeps that rule while still
landing the worktree content, the reason, and the move together.

### 2026-10-12 — This run did not mirror the plan into the primary checkout

**Decision:** The installed `/plan-start` that ran this plan still says to copy plan updates to the
primary checkout at the end of the run. This run did not.

**Reason:** This plan removes that step with the user's confirmed reversal, the new scan reads the
worktree copy directly, and a mirrored copy would be an uncommitted outside edit on `main` under
the new model. Until this branch merges, a portal running `main`'s code shows the primary copy as
`/plan-start` left it.

### Use the assigned worktree as the authoritative active copy

**Decision:** During active implementation, the worktree named by the plan's `worktree` field is the
one authoritative copy.

**Alternatives considered:** continuously mirror to `main`; add a dedicated plan branch; store plan
state in a database.

**Reason:** The worktree already provides isolated history, conflict handling, and eventual merge
into `main`. Reusing it removes synchronization writes without adding a persistence layer.

### Detect competing edits instead of blocking them

**Decision:** Direct file editing stays valid. RoboRepo reports outside edits rather than installing
CI failures or locks.

**Reason:** RoboRepo does not own every editor or agent that changes Markdown. Advisory detection
keeps the filesystem-first model.

### Defer a dedicated plan branch

**Decision:** No `roborepo/plans` branch or configurable canonical plan ref in this story.

**Reason:** A dedicated branch adds remote synchronization, branch lifecycle, permissions, and
conflict handling before the simpler worktree model has been tried. Revisit only if cross-machine
collaboration becomes a demonstrated problem.

### 2026-10-11 — One authority per stage; no reconciliation machinery

**Decision:** Replaced the earlier design, which compared both copies against a common base,
classified seven variant states, and had a generic portal move out of `active/` copy worktree
content into the primary checkout. Now the primary copy decides the stage, the worktree decides
active content, and the only check is whether the non-authoritative copy holds a version the
authority never had.

**Reason:** The seven-state classifier treated both copies as peers whose changes had to be
weighed, and the portal handoff was a synchronization path. Under a single authority, a change in
the worktree is never a conflict, so only edits to the other copy need detection, and those are
resolved by Git merges the user already performs.

### 2026-10-11 — Lifecycle moves of a worktree-authoritative plan are refused in the portal

**Decision:** The portal's lifecycle dropdown refuses to move a plan whose authoritative copy is in
its worktree, pointing to `/plan-close` or to clearing `worktree`.

**Reason:** Lifecycle transitions are committed in the primary checkout. Moving the worktree copy
would give the plan two lifecycles, and moving the primary copy would release authority without
integrating the worktree's state. This narrows the manual override recorded in [[age4cm7r]] to
plans whose primary copy is authoritative. The user confirmed the reversal on 2026-10-11.

### 2026-10-11 — `/plan-start` stops mirroring to the primary checkout

**Decision:** Remove the end-of-run mirror that [[age4cm7r]] added at the user's request.

**Reason:** The mirror existed so the portal could show active progress. The portal now reads the
worktree copy directly, and the mirror is itself an outside edit under this model; on 2026-10-11 it
had already drifted from the worktree copy of [[a7bslb00]]. The user confirmed the reversal on
2026-10-11.

### 2026-10-11 — `/plan-close` refuses unlanded plan state instead of copying it

**Decision:** Closing as completed requires that the worktree's plan copy holds no version `main`
never had (refined on 2026-10-12 from "equals the primary copy", so a refusal's notes in the primary
copy do not block a rerun).

**Reason:** Completed work has already merged, so Git is available to carry any remaining plan edits
to `main`. Refusing keeps the merge as the only path for landed work, and keeps [[a7bslb00]]'s
cleanup from removing the only copy of the plan's final state.

### 2026-10-12 — `/plan-close` hands authority back at the start of a completion run

**Decision:** `/plan-close` runs the integration check before step 1. Once it passes, every plan
edit in the run goes to the primary copy, including the notes of a later refusal; the worktree copy
is only read, for that check. Integration means the worktree holds no plan version `main` never
had, so refusal notes in the primary copy do not block a rerun. Confirmed by the user.

**Alternatives considered:** carrying a refusal's notes into the worktree copy; buffering every plan
edit until the verdict; editing the worktree copy throughout and carrying it to `main` at close.

**Reason:** A completed plan's branch has already merged, so the worktree has nothing left to
contribute. Writing only to the primary copy needs no copying between checkouts. After a refusal,
the outside-edit finding accurately reports where the notes are.

### 2026-10-11 — `/plan-close` carries an abandoned plan's worktree copy to `main` once

**Decision:** Closing as archived writes the worktree copy into the primary checkout in the archive
commit, refusing when the primary copy has an outside edit. Confirmed by the user.

**Alternatives considered:**

| | Refuse until landed | Archive the primary copy | Carry the worktree copy once (chosen) |
| --- | --- | --- | --- |
| Archived record on `main` | complete | missing the worktree's progress and the reason work stopped | complete |
| Cost to the user | a merge for work being abandoned | none | none |
| Copies between checkouts | none | none | one, one-way, at a lifecycle transition |

**Reason:** Abandoned work never merges, so Git cannot carry its plan. A single one-way transfer at
the archive transition keeps the record complete without ongoing synchronization.

### 2026-10-11 — No `worktree-only` or `primary-changed` distinction

**Decision:** A worktree-only plan keeps today's labeled display with no finding, and an outside
edit is one finding whether or not the worktree also changed.

**Reason:** Neither distinction changes what the user does next. Fewer states keep the findings
readable.

## Cross-Plan Notes

Recorded here rather than edited into the other plans.

- [[a7bslb00]] (worktree lifecycle cleanup) is a **landed dependency**: completed, merged as
  `7627bfc` (#31), an ancestor of `77fb095`. Its plan-active guard
  (`worktree-policy.mjs#activeWorktreeNames`) reads the primary checkout's `active/` folder, which
  matches "the primary copy decides the stage", and its landed test plus clean-tree guard keep any
  worktree that holds unlanded plan edits. It moved the worktree enumerator into
  `worktree-inventory.mjs#linkedWorktrees`, which this plan consumes, and rewrote `/plan-close`
  steps 6 through 9, which this plan edits as they now stand. Its note that confirmed removal can
  remove an authoritative copy stays true; this plan's fallback finding covers it, and Phase 5 adds
  the progress sentence to its Delete Worktree confirmation that this note previously only
  suggested.
- [[age4cm7r]] (atomic plan-suite commands) is landed and completed. `roborepo plans start` keeps
  its primary-checkout transition and fast-forward unchanged. Two of its Decision Log rows are
  superseded: the end-of-run mirror, and the lifecycle dropdown as an unconditional manual override.
  The plan is closed, so no lifecycle cleanup is needed; this note records the supersession.
- [[wk7p4n2]] (plan-worktree Home association) and [[7m4q9dx]] (plan-first Home hierarchy) are
  landed and completed. Home's join on the `worktree` field is unchanged.
- Two backlog plans also touch `movePlanLifecycle` without conflict: `p3vbk03v` (reference
  integrity surfacing) would add inbound-reference reporting to it, and
  `plans-portal-live-refresh-and-static-preflight` names it as a refresh trigger. Neither depends on
  which copy is selected.
