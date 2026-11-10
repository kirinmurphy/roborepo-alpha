---
id: h4tqm2wz
priority: medium
next_action: None. All 38 plan items are implemented and verified against live data, and the rename case that motivated a merge affordance is resolved by automatic aliasing instead — a merge was investigated and deliberately not built, because the data it would carry over turned out to be nothing anyone reads
blocked_by: []
depends_on: []
related:
  - developer-runtime-compose-project-grouping
  - developer-runtime-repository-card-merge
  - developer-runtime-metadata-suggestions
  - pljvmyh
reviewed_commit:
---

# Runtime Workspace Model: Persistent Repositories and Their Checkouts

## Summary

Make a repository a durable entity on the Runtime page rather than a view over whatever happens
to be running, and place each thing the page shows at the level it actually belongs to.

Three changes, in dependency order:

1. **Persistence.** The first time Runtime resolves a running app to a repository, record that
   repository and the checkout it ran from. The record survives every process stopping.
2. **Lifecycle.** A repository whose checkouts have gone stale stays listed and marked; one the
   ageing sweep retires is hidden from the default list and can be restored from hidden records.
3. **Container placement.** With every checkout of a repository known, a Docker Compose stack can be
   placed by what it depends on rather than by which directory `docker compose up` ran from.

The third depends on the first: classifying a stack against "every checkout of this repository"
requires knowing every checkout, which requires remembering them.

## Context

A repository open in several working directories at once — a main clone plus linked worktrees, each
called a **checkout** below — is the shape this page has to represent. A repository card already
renders one root section per checkout (`developer-runtime-repository-card-merge`).

Two things are missing from that model.

**The card is a view over live processes, not over repositories.** Nothing about the port↔repository
connection is recorded. `settings.projects` is written only when the user acts — rename, favorite,
hide, or save a link (`mutateProject`/`mutateLinks` are the only callers of `ensureProject` in
`modules/developer-runtime/settings.mjs`). Discovery itself writes nothing, so the connection is
recomputed every scan and discarded. A repository disappears from the page the moment its last
process exits, and the "Inactive saved projects" list only holds projects the user happened to
interact with.

**Compose stacks are placed by launch directory.** That answers "where was the command typed",
not "what do these containers depend on".

### Relationship to the global repository registry

`pljvmyh` (Unify Repository Discovery and Portal Scope) owns the portal-wide canonical repository
registry: global repository sources, `urlKey` allocation, shared scope, and the migration of Plans
and Tokens onto it. Its §3 already specifies Runtime as the zero-configuration discovery producer,
and its Phase 1 includes persisting resolved checkout roots.

This plan implements **that persistence step only**, and only as far as the Runtime page needs it,
so the workspace model can be settled where it is visible before global surfaces are built on it.
The division:

| Concern | Owner |
| --- | --- |
| Runtime discovery persists repository + checkout roots | This plan |
| Stale/damaged checkout lifecycle and visibility-based hiding | This plan |
| Container placement across checkouts | This plan |
| User-configured repository/folder sources | `pljvmyh` |
| `urlKey`, shared `?repository=` scope, selector | `pljvmyh` |
| Plans/Tokens migration onto the registry | `pljvmyh` |
| Home and `/repositories/<urlKey>` surfaces | `jqi1dof` |

Write through the existing `modules/repositories/` registry rather than adding a second store. The
registry already holds discovery provenance, opaque `rootId` values, visibility, and activity; what
it lacks is a `rootId -> path` mapping, which `pljvmyh` §2 specifies and this plan delivers.

A Compose stack can relate to those checkouts in four ways, and each has a different correct home:

| # | Configuration | Example | Correct placement |
| --- | --- | --- | --- |
| 1 | Shared backing services | One Postgres/Auth/Storage stack; every checkout's dev server points at it | Repository level, alongside checkouts |
| 2 | Per-checkout stack | Isolated env per branch, `COMPOSE_PROJECT_NAME` suffixed or ports offset | Inside that checkout's root section |
| 3 | Mixed | A shared database **and** a per-branch app container in one repository | Split: each by its own evidence |
| 4 | Checkout-independent tooling | Local registry, mail catcher — in the repository, tied to no checkout | Repository level |

Configuration 3 is why the classification has to be per stack rather than a repository-wide setting:
one repository can hold both kinds at once.

Today every stack is placed as though it were configuration 2. `developer-runtime-metadata-suggestions`
routes each stack into a root section using the project's `working_dir` — the directory
`docker compose up` ran from. That is correct for a per-checkout stack and wrong for the other
three, because the launch directory records where a command was typed, not what the containers
depend on.

The consequence is a misleading card rather than a missing one. A shared stack renders under
whichever checkout started it first, and a row under a "Worktrees" heading reads as belonging to
that branch. Acting on that reading — `docker compose down` from that row — stops the database
every other checkout is using.

## Goals

- Make a repository a first-class record created on first port↔repository resolution, independent of
  whether anything is currently running.
- Remember every checkout a repository has been seen at, so the set of checkouts is knowable when
  nothing is running.
- Keep an inactive repository listed rather than removing it, distinguishing "not running" from
  "not there any more".
- Age a long-unseen repository out of the normal list without ever deleting its record.
- Place a Compose stack by evidence of what it depends on, not by launch order.
- Give checkout-independent stacks their own place on the card, as peers of the checkouts.
- Never assert a checkout the evidence does not support.
- Make the blast radius of stopping a shared stack visible before it is stopped.

## Non-goals

- User-configured repository or folder sources. Discovery here is runtime-driven only; `pljvmyh`
  owns configured sources.
- `urlKey`, the shared `?repository=` scope, or the repository selector — all `pljvmyh`.
- Migrating Plans or Tokens onto the registry, and the Home/detail surfaces (`jqi1dof`).
- Filtering Runtime to a single repository. It stays an operational list of all repositories.
- Changing how containers are discovered, how ports correlate, or how stacks are grouped into
  projects. `developer-runtime-compose-project-grouping` owns that and stays as-is.
- Managing containers (start/stop/restart) from the portal.
- Classifying individual containers separately from their Compose project. A stack is one deploy
  unit — `docker compose down` stops all of it — so it is classified and placed as one unit. See
  "Open questions" for the case that strains this.
- Any network call, or any new subprocess on the common path.

## Current state

### Repository records

Nothing about a discovered repository is persisted. `buildDeveloperRuntimeSnapshot`
(`modules/developer-runtime/snapshot.mjs`) computes `repositoryId` fresh from each scan's resolved
filesystem paths and builds `repositories[]` in memory. The only durable store is
`settings.projects`, keyed by an app-slot identity string, and only user mutations write to it.

Two consequences visible on the page today:

- A repository with no running process is absent entirely, unless the user once renamed, favorited,
  hid, or saved a link on it — in which case it appears in the separate "Inactive saved projects"
  list.
- A saved identity is not necessarily a repository identity. `git:`-prefixed keys are valid
  `repositoryId` values and would rejoin a repository card directly; app-slot identities such as
  `<name>:<slot>` are not and have nothing to join on. Grouping works today only because
  `buildRepositories` keys on `project.repositoryId`, recomputed from a live path, never on the
  stored identity string.

The canonical registry under `modules/repositories/` already persists provenance, opaque `rootId`
values, visibility, and activity — but Runtime does not currently write to it, and the registry
has no `rootId -> path` mapping to write.

### Container placement

Ownership is decided in `collectGitForComposeProjects`
(`modules/developer-runtime/discovery.mjs`), in three tiers. Every tier sets `rootId` the same way:

```js
rootId: identity.projectRoot ? computeRootId(identity.projectRoot) : null,
```

| Tier | Source | `resolvedFrom` |
| --- | --- | --- |
| 1 | `settings.composeProjects[name].repoPath` (manual) | `manual` |
| 2 | `com.docker.compose.project.working_dir` label | `auto` |
| 3 | Container bind-mount paths, via `docker inspect` | `auto-bind` |

`buildRepositories` (`modules/developer-runtime/snapshot.mjs`) then routes the group into the root
section matching that `rootId`, falling back to the main slot when it does not resolve.

Mount data is already collected, but only as a fallback. `modules/developer-runtime/docker-mounts.mjs`
returns bind-mount host paths per container, and its `bindSources()` returns only `Type === "bind"`
mounts, discarding named volumes. Tier 3 consumes that data to resolve *which repository* a stack
belongs to, and refuses to answer when containers disagree — "one repository or nothing".

Mounts are never consulted to answer *which checkout*, because tier 2 resolves that from
`working_dir` whenever the label exists, and the label almost always exists.

## Proposed design

### Persisting the repository record

When a scan resolves a listener to a repository and a checkout path, write through the canonical
registry: register the repository, register the checkout as a local root, and record the
`rootId -> absolute path` mapping the registry currently lacks.

```text
repositoryId
  └── rootId
       ├── absolute local path   (server-side only, never sent to the browser)
       ├── kind: primary | worktree
       ├── firstSeenAt
       └── lastSeenAt
```

Three properties this must hold:

- **A process stopping never deletes anything.** Only `lastSeenAt` stops advancing.
- **Writes happen on change, not on every scan.** The poll runs every few seconds; writing
  unconditionally would churn the settings revision that mutation conflict-detection depends on.
  Compare against the stored record and write only when something actually differs.
- **Paths stay server-side.** Browser payloads keep exposing root counts and kinds only, matching
  the registry's existing privacy boundary.

A persisted checkout is what makes the rest of this plan possible: it is the set the container
classifier tests mount paths against, and the path the card reads git from when nothing is running.

### Repository lifecycle

A persisted repository is in exactly one state, derived on each scan.

| State | Meaning | On the page |
| --- | --- | --- |
| `active` | At least one process running now | Normal card with its members |
| `idle` | Record valid, checkouts readable, nothing running | Normal card, marked inactive; git read from disk |
| `stale` | Every checkout unreadable or unresolvable | Listed, marked, with the reason |
| `hidden` | Not seen for over 30 days | Out of the normal list, behind "Show hidden" |

**Records are never deleted, automatically or otherwise.** A record is ~1.1 KB (measured against the
live registry: 10 KB for 9 repositories), so a thousand repositories would cost about 1 MB — against
a telemetry directory already 50 MB. There is no storage argument for deletion, and a record holds
one thing rediscovery cannot rebuild: `firstSeenAt`, when the project first entered the workspace.

Aging out is therefore hiding, not removal. A hidden record you wanted back costs one click; a
deleted one is gone silently, and months later its absence reads as a bug rather than as a policy.

The distinction that matters for `stale` is between *looking and finding nothing* and *not being
able to look*. Only the former is evidence the checkout is actually gone.

| Observation | State | Why |
| --- | --- | --- |
| Checkout path readable, `.git` intact, no listener | `idle` | Simply not running |
| Checkout path gone, parent directory readable | `stale` | Looked, genuinely absent |
| `.git` missing or unreadable at an existing path | `stale` | Looked, no longer a repository |
| Parent directory unreadable (unplugged drive, unmounted share) | `idle` | Could not look — never treat as evidence of absence |
| Remote URL changed (`git remote set-url`) | `idle`, alias the old id | Same repository, new identity — must not mint a duplicate |

Hiding is measured from `lastSeenAt`, not from time spent `stale`. A repository on an unplugged
drive becomes `stale` immediately but is still one you use; ageing it out on staleness would hide it
within days of unplugging, while ageing on last-seen hides it only if you genuinely stop using it.

A record whose `lastSeenAt` is absent entirely — registered by a source that never resolved a root —
never ages out. "Never seen" is not "seen long ago", and three such records already exist in the
live registry.

### Classification

Ownership becomes a derived property with three states, computed per Compose project.

**Bind mounts decide.** A bind mount is a hard dependency on one checkout's files — the stack
cannot run without them. A named volume is persisted state that says nothing about which checkout
is in play, so it is ignored for placement (`bindSources()` already drops it).

A manual `ownership` setting, when present, wins over all of the below. Otherwise the stack's bind
mounts are resolved against every known checkout of the repository, and the result decides:

| Bind mounts resolve to | State | Evidence `kind` | Placement |
| --- | --- | --- | --- |
| Exactly one checkout | `owned` | `bind-mount` | That checkout's root section |
| Two or more checkouts | `shared` | `conflict` | Repository level, as a peer of the checkouts |
| The repository root only | `shared` | `repo-root` | Repository level, as a peer of the checkouts |
| Nothing (named volumes only, or no mounts) | `unverified` | `none` | Repository level, marked inferred |

`working_dir` is demoted rather than removed: it still resolves *which repository* a stack belongs
to (tier 2, unchanged), but it no longer decides *which checkout*.

`shared` and `unverified` render in the same place but are not the same claim. `shared` is a
positive finding ("evidence says this is not checkout-specific"); `unverified` is an absence
("nothing here supports any placement"). The card distinguishes them, matching the
correct-or-absent discipline the git badge already follows.

### Data shape

`collectGitForComposeProjects` returns two new fields per project, alongside the existing ones:

```js
{
  git, repositoryId, rootId, resolvedFrom,   // unchanged
  ownership: "owned" | "shared" | "unverified",
  ownershipEvidence: {
    kind: "bind-mount" | "repo-root" | "conflict" | "none" | "manual",
    checkoutPaths: [],   // resolved checkout roots the mounts landed in
  },
}
```

`rootId` keeps its current meaning and is **only** set when `ownership === "owned"`, so a consumer
that ignores the new fields degrades to "shared stacks have no root", not to a wrong checkout.

### Rendering

A third region joins the card, between the main checkout and the worktrees:

```
REPOSITORY  <repo>   GitHub ↗   — localhost:4321  ⓘ

  main branch                    :4321   1 member

  SHARED SERVICES                                        ← new region
    <stack>   11 containers · used by every checkout  ⓘ

  WORKTREES
    feat-x                       :4322   2 members
    feat-y                       :4323   1 member
```

- The heading is a peer of `Worktrees`, reusing `.repository-worktrees-heading`.
- It renders only when a shared or unverified stack exists — a repository with none is unchanged.
- The "used by every checkout" caption is what makes the blast radius legible before acting.
- An `unverified` stack renders in the same region with its provenance stated, joining the existing
  `REPO_PROVENANCE` vocabulary in `portal/developer-runtime/templates.js`.

### Retiring the "Inactive saved projects" list

Once repositories persist, a separate list of not-currently-running projects is a second place to
look for something the repository list already holds. Persisted repositories render in one list,
each carrying its own state.

An `idle` repository still shows everything that does not depend on a live process: name, provider
link, saved quick links, its checkouts with their branches, and copy actions. Git is read from the
persisted checkout path. Only per-instance facts — port, health, PID, process metrics — are absent,
because there is no instance.

Saved app-slot identities that never resolved to a repository (see Current state) have no repository
to join. Carry them forward under their existing identity until the first scan that resolves them,
rather than dropping saved links on entries the user deliberately configured.

### Manual override

`settings.composeProjects[name]` gains an optional `ownership` field accepting `"shared"` or a
checkout path. The evidence is good but not omniscient (a stack may depend on a checkout through a
mechanism no mount reveals — a `.env` file naming a path, a host-network service), so the escape
hatch stays. Tier 1 already reads this object for `repoPath`; this extends it rather than adding a
new settings surface, and it keeps `validateComposeProjects`
(`modules/developer-runtime/settings-schema.mjs`) as the single validation point.

## Implementation plan

### Phase 1 — Persist repositories and their checkouts

- [x] Add the private `rootId -> absolute path` index to `modules/repositories/`, per the shape in
      "Persisting the repository record". This is the `pljvmyh` §2 local-root index; build it there
      so that plan consumes it rather than a Runtime-local copy.
      Built as `registry.localRootPaths` — a top-level key in the registry file, keyed by `rootId`
      alone, with `registerLocalRootPath`/`localRootPath`/`checkoutRootsFor` in
      `modules/repositories/registry.mjs`. It lives in the registry file rather than a sibling one
      because §2 requires identity and path to commit as one logical update, and `updateRegistry` is
      already a single read-mutate-write with a revision bump; two files could not be committed
      atomically against a concurrent writer. Paths are kept out of the browser by the payload
      builders, which whitelist fields explicitly.
- [x] Write through the registry from Runtime discovery when a scan resolves a repository and
      checkout, recording provenance and advancing `lastSeenAt`.
      `recordDiscoveredRepositories` now passes `project.projectRoot` as `localRootPath`; `rootId` is
      derived from exactly that path, so the two cannot disagree.
- [x] Write only on change, and add a test that a steady-state poll performs no settings write —
      this is the guard against churning the mutation revision.
      `registerLocalRootPath` reuses the existing `LAST_SEEN_DEBOUNCE_MS` (60s) that `recordDiscovery`
      and `registerLocalRoot` already apply. Note the precise guarantee: an unchanged root writes
      nothing *within* the debounce window, and refreshes `lastSeenAt` at most once per 60s per
      repository thereafter. That periodic refresh is not churn — it is the `lastSeenAt` signal
      Phase 2's lifecycle states and the 30-day ageing rule both read. Verified live: six polls
      across ~36s produced no revision bump.
- [x] Keep browser payloads path-free; expose root counts and kinds only.
      Already true of `repositoryDetailPayload`/`repositoryListPayload`; now covered by an explicit
      regression assertion in `repositories-service-check`.

### Phase 2 — Lifecycle

- [x] Derive `active` / `idle` / `stale` per repository on each scan, using the observation table in
      "Repository lifecycle".
      `deriveLifecycle` in `modules/repositories/lifecycle.mjs`. Derived per scan, never stored: two
      of the three states depend on whether a directory is readable *right now*, so a persisted
      value would assert something true at write time and false at read time. The existing stored
      `activity` enum (`active|inactive|unknown`) is left alone — it is a different, coarser field
      and every live record sits at `unknown`.
- [x] Distinguish an unreadable parent directory from a genuinely absent checkout, and never treat
      the former as evidence of absence.
      `inspectCheckout` returns `present|absent|unreadable` rather than a boolean. A repository is
      `stale` only when every checkout was successfully looked at and none survived; a single
      unreadable checkout holds it at `idle`.
- [x] ~~Alias a changed remote URL onto the existing record instead of minting a duplicate.~~
      **Changed during implementation — automatic aliasing is not safe and is not done.**
      The plan assumed "same rootId, different git id" identifies a renamed remote. It does not: a
      deleted-and-recloned directory produces exactly the same observation, and rootId is derived
      from the path, so the stored data is identical in both cases. The live registry's own example
      (rootId `9c87d71c6406676d` under both `harness_configs` and `roborepo`) reads as a rename but
      is indistinguishable from a repurpose.
      Aliasing on a guess merges two unrelated repositories onto one card and gives the user no
      signal it happened; the duplicate it avoids is visible and fixable with one `setAlias`. So the
      checkout repoints to the newly-resolved repository, both records survive, and
      `priorRepositoryForRoot` *reports* the prior owner for a future UI affordance ("this checkout
      moved from A to B — merge them?") rather than acting on it.
      A root-commit comparison would be real evidence, but collecting it costs a `git rev-list` per
      checkout on the common path, which this plan's non-goals exclude.
      **Later correction — the "identical observation" premise above is false.** It is true of the
      *ownership index* (`localRootPaths`), which is what this note was reasoning about, but not of
      the `localRoots` arrays: a `rootId` is a hash of an absolute path, so the same one appearing on
      two records is direct evidence the same directory was seen under both remotes, and the
      most-recently-seen root distinguishes a rename from a reclone. See `renamedInto` and the
      Follow-ups section. The conclusion that automatic *merging* is unsafe still stands — what
      changed is that automatic *aliasing*, which is non-destructive and one-line reversible, is
      supportable on this evidence and now happens.
- [x] Hide records whose `lastSeenAt` is over 30 days old, and skip records that have no
      `lastSeenAt` at all. Reuse the registry's existing `visibility` rather than adding a parallel
      state.
      `ageOutCandidates` returns candidates rather than hiding them, so the caller owns the write and
      a repository the user explicitly un-hid is not re-hidden behind their back. Ageing measures
      `lastSeenAt`, never time-spent-stale.
- [x] Add a "Show hidden" affordance so a hidden repository is one click from returning.
      A "Hidden repositories" section in the settings dialog, each row a Show button. Kept separate
      from the existing "Hidden" section rather than merged into it: that one holds projects and apps
      the user hid by hand in Runtime's settings, this one holds whole repositories the ageing
      sweep retired from the registry — different store, different actor, different thing to restore.
      Two things had to be built underneath it. **The sweep had no caller**: `ageOutCandidates` was
      covered by tests but nothing ever acted on it, so no record was ever hidden and there was
      nothing for the affordance to show. `applyAgeOut` now runs it on the refresh path, which is
      also the caller the Phase 2 note anticipated when it said the function returns candidates so
      the caller owns the write.
      **Restoring had to survive the next sweep.** Ageing measures `lastSeenAt`, and restoring does
      not change it, so a restored record is still 30 days old and would have been re-hidden on the
      very next poll — forever. `hideRepository` now stamps `restoredAt` on restore and clears it on
      a deliberate re-hide, and the sweep skips records carrying it. Without that marker the
      affordance would appear to work and silently undo itself.
      Visibility is written through its own route rather than `updateDeveloperRuntimeSettings`, since it
      lives in the repository registry, not the settings file. No revision guard: it is one boolean
      per record with no cross-field invariant. The restore kicks a refresh rather than rebuilding
      from cached discovery — the persisted-repository list is assembled on the refresh path, so
      rebuilding would have dropped every idle repository from the page instead of adding one back.
      Verified live end to end: hiding took the list 9 -> 8 with the record listed under hidden;
      restoring returned it to 9 with `restoredAt` persisted; and a simulated sweep 40 days out hides
      the other 9 candidates while leaving the restored one alone.

### Phase 3 — Merge the inactive list into the repository list

- [x] Render persisted repositories in one list with their state, and read git for `idle`
      repositories from the persisted checkout path.
      `collectPersistedRepositories` reads the registry, derives lifecycle, and passes the result
      into `buildDeveloperRuntimeSnapshot` as `persistedRepositories` — injected rather than read there,
      so the builder stays a pure function of its inputs like `repositoryNames` already was. Running
      repositories sort ahead of idle/stale ones; within each group the existing comparator applies.
      Git for an idle checkout goes through `modules/repositories/idle-git-cache.mjs`, which is
      explicitly the cross-poll cache `scan-cache.mjs` refuses to be. That refusal is answered rather
      than ignored: nothing is keyed on the root alone. Every entry carries a fingerprint of the
      checkout's git directory (mtimes of the dir, `HEAD`, `index`, `packed-refs`) and a hit requires
      it to still match, so a commit, checkout, stage or fetch forces a re-read while an untouched
      checkout costs one `git` call rather than one per ~10s poll. An unreadable checkout is never
      cached — the same refusal to treat "cannot look" as evidence that `deriveLifecycle` makes.
- [x] Remove the "Inactive saved projects" section.
      Repositories now render in the main list with their own state. What is left is narrower and
      renamed "Saved apps": app slots whose identity has never resolved to a repository, which have
      no repository card to join. `inactiveProjects` entries carry a `repositoryId` so the portal can
      filter out the ones already represented above.
- [x] Carry forward saved app-slot identities that have never resolved to a repository.
      They stay listed rather than being dropped — names, quick links and health checks are
      configuration the user deliberately created, and the section empties itself as they resolve.
- [x] Fold away a repository record whose every checkout has been repointed to another repository.
      Not in the original plan, and only visible because of this phase. Phase 2 deliberately does not
      merge on a rename: the checkout repoints and both records survive. While only running
      repositories were listed the superseded record never appeared; rendering persisted ones made it
      a second card with the same name as the repository that took its roots (the live registry had
      exactly this — `local:616846d49a69fc81` beside `localhostr_web`). `deriveLifecycle` cannot
      distinguish it alone, since a fully-repointed record and a never-resolved one both have zero
      resolvable roots and both read `idle`.
      `supersededBy` reports the successor and the caller folds the card; the record is untouched and
      returns the moment any checkout resolves back to it. Deliberately conservative — null unless
      the record has roots, every one is now owned by another repository, and they all agree on
      which. `harness_configs`/`roborepo` on the live registry is correctly NOT folded: they share
      two rootIds but no path was ever recorded for them, so ownership is unprovable and inferring
      the merge would be the guess this design refuses to make.

### Phase 4 — Container ownership

- [x] Extract checkout roots per repository into a lookup keyed by `repositoryId`, so mount paths
      can be tested against every known checkout rather than only the one `working_dir` named. With
      Phase 1 landed this reads persisted roots, so it covers checkouts that are not running.
- [x] Add `classifyComposeOwnership(mountPaths, checkoutRoots)` to `modules/developer-runtime/discovery.mjs`
      returning `{ ownership, ownershipEvidence }` per the decision flow above. Pure function over
      already-collected data — unit-testable with no Docker.
      One refinement the live containers forced: unmatched mounts alongside a single matched checkout
      do NOT downgrade the verdict. `traefik_vps` binds three paths inside its checkout plus
      `/var/run/docker.sock`, `/etc/localtime` and a log dir; requiring unanimity classified it
      `shared`. Infrastructure mounts belong to no checkout and say nothing about placement, so the
      test is "exactly one checkout's files are depended on and no second checkout competes". Mounts
      that resolve to no checkout at all still yield `shared`.
- [x] Call `collectMounts` for **every** Compose project, not only those that failed repository
      resolution. This is the one cost increase: one batched `docker inspect` on any scan with
      Compose projects. Measure it; if it registers, cache by container id across polls, since
      mounts cannot change without the container being recreated.
      Runs as a second pass (`classifyComposeProjects`) after repository resolution, reusing any
      mounts the resolution pass already fetched. Supersedes the old "no `docker inspect` once
      `working_dir` resolved" test, which guarded cost; placement correctness outranks it.
      Cross-poll caching not yet added — measure before optimising.
- [x] Two placement bugs the live fixture exposed, neither of them fixture-specific.
      **Path spelling.** The registry stores realpath-resolved checkout roots (identity.mjs keeps
      rootIds reproducible for a directory however it was reached) while Docker reports the
      unresolved path. On macOS `/var`, `/tmp` and `/etc` are symlinks into `/private`, so any
      checkout under them compared as a different string than the root it actually is: every mount
      missed, and the stack was declared `shared`/`repo-root` — a positive claim of sharing produced
      by nothing but a spelling difference. A compose file interpolating `TMPDIR` (which ends in
      `/`) added doubled slashes on top. Both sides now reduce through `comparablePath` in
      `classifyComposeOwnership`; the mount side also collapses repeated slashes in
      `docker-mounts.mjs`. Evidence keeps the original root spelling. `/private` is collapsed only
      ahead of the three directories macOS actually links there — this must agree with what
      identity.mjs already stored, not discover new equivalences.
      **One checkout per repository.** `recordDiscoveredRepositories` deduped its sources on
      `repositoryId` alone, so only the first checkout of a repository was ever registered and the
      rest were silently dropped. A repository open in several worktrees could therefore never
      accumulate more than one root — which meant `conflict` was unreachable in practice, however
      many checkouts a stack demonstrably mounted. Now keyed on (repository, checkout).
      Neither bug is visible without a multi-checkout repository running a stack that mounts more
      than one of them, which is exactly the shape no real repository on this machine has.
- [x] Set `rootId` only for `owned`; leave it `null` for `shared`/`unverified`.
      Also required persisting compose-resolved checkouts: `recordDiscoveredRepositories` only walked
      listener instances, so a repository whose only presence is a container stack was registered
      with no path, leaving its own stack unplaceable.
- [x] Extend `settings.composeProjects[].ownership` and its validation in
      `modules/developer-runtime/settings-schema.mjs`.
      `safeComposeOwnership` accepts `"shared"` or an absolute checkout path. Deliberately no manual
      `"unverified"`: that value means "no evidence was found", which is an observation about the
      scan rather than a claim the user is in a position to assert.
- [x] In `buildRepositories` (`modules/developer-runtime/snapshot.mjs`), collect non-`owned` groups into a
      new `entry.sharedComposeGroups[]` instead of falling back to the main root.
      Keyed off a null `rootId`, which Phase 4 already sets only for `owned` — so the absence of a
      root *is* the verdict, and the two cannot drift apart. `entry.composeGroups` still holds every
      stack, so the card's member count and CPU aggregate are unchanged; the arrays are two views,
      not a partition.
- [x] Render the Shared Services region in `repositoryCard`
      (`portal/developer-runtime/templates.js`) plus its heading in `portal/developer-runtime/index.html` and
      `portal/developer-runtime/styles.css`.
      No `index.html` change was needed: the Worktrees heading it mirrors is created in JS, not
      declared in the template, so the new heading follows the same existing pattern and reuses
      `.repository-worktrees-heading`. Shared stacks render as full (non-member) compose cards —
      without an owning checkout there is no root section to inherit git context from.
- [x] Extend `REPO_PROVENANCE` with the ownership evidence vocabulary so the tooltip states how
      placement was decided.
      Added as a sibling map (`OWNERSHIP_EVIDENCE`) rather than extending `REPO_PROVENANCE` itself:
      the two answer different questions — which *repository* a stack resolved to, and which
      *checkout* of it the stack was placed in — and share no keys. The identity line now shows both,
      omitting placement when no classification ran.
- [x] Update the member count so a shared stack is not counted as a member of any checkout.
      Falls out of the routing change: a shared stack never enters a root's `composeGroups`, so the
      per-checkout count in `buildRootSection` drops it automatically. It still counts at repository
      level, where it is genuinely a member.

## Validation

- [x] A repository discovered once remains listed after every one of its processes stops, with its
      checkouts and their branches still shown.
      Verified live: the portal lists 9 repositories, 4 `active` and 5 `idle`, where before it showed
      only what was running. The `idle` ones with a recorded checkout path show that checkout's
      branch read from disk; the ones registered before Phase 1 have no path on record and say so
      rather than implying an empty repository. Covered by unit assertions in
      `developer-runtime-repository-merge-check`.
- [x] A steady-state poll writes nothing *within the `lastSeenAt` debounce window* — no revision bump
      when no record changed. Stated precisely because the unqualified version is not achievable and
      not desirable: `lastSeenAt` must keep advancing for a repository that is genuinely still
      running, or Phase 2's lifecycle states and the 30-day ageing rule would have no signal to read.
      The guarantee is that the ~10s poll does not write; a still-running repository refreshes at
      most once per 60s (`LAST_SEEN_DEBOUNCE_MS`).
- [x] An unreadable parent directory yields `idle`, never `stale`.
- [x] A checkout deleted while its parent stays readable yields `stale`.
- [x] ~~A changed remote URL aliases onto the existing record and produces exactly one repository, not~~
      **Superseded — see the Phase 2 note.** A changed remote produces two records and the checkout
      repoints to the new one; the prior owner is reported, not merged. Automatic aliasing was
      dropped because a rename and a repurposed directory are indistinguishable from stored data,
      and a wrong merge is worse than a visible duplicate. Covered by "new id gets its own record
      (no silent merge)" / "no alias invented automatically" in the lifecycle tests.
- [x] A record older than 30 days is hidden, returns via "Show hidden", and is never removed.
      The full round trip is covered in `repositories-lifecycle-check` and was exercised against the
      live portal. Nothing in the path deletes: hiding sets `visibility`, restoring clears it, and the
      record is untouched throughout. The load-bearing assertion is that a restored record is STILL
      technically aged — it stays an `ageOutCandidates` result — and is protected by `restoredAt`
      rather than by anything about its age, since nothing about restoring makes it younger.
- [x] A record with no `lastSeenAt` is never hidden by age.
- [x] A repository that becomes `stale` does not start ageing toward hidden — only `lastSeenAt`
      drives that, so an unplugged drive does not hide a repository still in use.
- [x] No absolute path appears in any browser payload.
- [x] `scripts/test/developer-runtime-compose-identity-check.mjs`: classification unit tests covering all
      four configurations from Context — shared-volumes-only, single-checkout bind, multi-checkout
      bind conflict, and repo-root-only bind.
- [x] Regression: a repository with exactly one checkout and one stack still renders the stack
      inside that checkout, unchanged. This is the overwhelmingly common case and must not move.
      Asserted in the classification tests, and confirmed on live containers: `menugoats` and
      `traefik_vps` each classify `owned`/`bind-mount` and stay inside their checkout.
- [x] `scripts/test/developer-runtime-repository-merge-check.mjs`: a shared group lands in
      `sharedComposeGroups` and in no root's `composeGroups`; member counts exclude it.
      Covers both directions — a rootId-less stack must reach `sharedComposeGroups`, and a stack the
      mounts *did* place must still reach its checkout's section. Mutation-tested: restoring the old
      main-root fallback fails the first, routing every stack to shared fails the second.
- [x] Manual: a repository with a shared backing stack (configuration 1) renders that stack once at
      repository level, not under any worktree.
      Verified end to end through the live portal, which required giving the fixture a published
      port: discovery correlates containers to instances only by published host port
      (`indexDockerContainersByHostPort`), so a port-less stack never enters a scan at all. The
      fixture now serves a loopback-only listener on 39117, and its stack renders with
      `ownership=shared`, `evidence=conflict`, `rootId=null`, in `sharedComposeGroups`, with no root
      claiming it.
      Getting there exposed two real product bugs, both fixed and both invisible without this
      fixture — see the Phase 4 notes above for the path-normalization one and the per-checkout
      registration one. Neither was a fixture artifact; both would misclassify real repositories.
- [x] Manual: a repository with a per-checkout stack (configuration 2) still renders it under its
      own checkout.
      Verified live: `menugoats` and `traefik_vps` each classify `owned`/`bind-mount`, carry a
      `rootId`, and render inside their own checkout's section with `sharedComposeGroups` empty.
- [x] All 11 `test:developer-runtime*` suites pass. All 16 (11 developer-runtime + 5 repositories) verified
      green after this phase.

## Risks

- **Discovery becomes a writer.** The scan is currently read-only with respect to settings, and the
  poll runs every few seconds. A background write can collide with a user mutation, since the
  settings `revision` field drives conflict detection. Writing only on genuine change keeps this to
  the rare case; the steady-state no-write test is the guard.
- **A reused directory.** If a checkout is deleted and a different repository is cloned to the same
  path, reading git from the persisted path would attribute the wrong branch to the record. Verify
  the resolved repository identity still matches before trusting a persisted path.
  **Addressed in Phase 3.** `readIdleGit` re-resolves the path through the same derivation discovery
  uses for a running checkout — `canonicalRepositoryId(resolveProjectIdentity(root))` — and returns
  no git unless the answer still matches the record. A mismatch yields absence rather than an error:
  the repository is still known, its checkout is just no longer where the record says, which is the
  same "listed, honest about what it does not know" state as a checkout with no path at all.
  Only persisted paths need this. A running repository resolves its identity from the process's own
  cwd on every scan, so it can never inherit a stale one.
- **Records accumulate permanently by design.** Nothing is ever deleted. Measured cost is ~1.1 KB
  per repository, so a thousand repositories is about 1 MB. The scaling concern is not storage but
  write amplification: the registry is one JSON file rewritten per scan, so a large registry is
  rewritten repeatedly — which is the other reason writes must happen only on genuine change.
- **A stack genuinely shared but bind-mounting one checkout's config** classifies as `owned` and
  renders under that branch — the failure this plan is fixing, in a narrower form. The manual
  override is the mitigation; the "used by every checkout" caption is deliberately absent from
  `owned` stacks so the card never makes that claim on inference alone.
- **`docker inspect` on every scan** is the one added cost. Bounded by the existing 6s timeout and
  batched into one call, and mount data is immutable for a container's lifetime, so caching is
  available if measurement warrants it.
- **Symlinked or relative mount sources** may not resolve to a checkout by prefix match. Falls into
  `unverified`, which is the safe direction — repository level, stated as inferred.
  **Partly fixed, and the original wording was wrong about the outcome.** These land in `shared`
  (`repo-root`), not `unverified` — mounts exist, they just match nothing, which is a positive claim
  of sharing rather than an absence of evidence. That distinction is the point of having both states,
  and it made the failure worse than this risk assumed.
  The macOS symlink case is now handled: `comparablePath` collapses `/private` ahead of `/var`,
  `/tmp` and `/etc` on both sides of the comparison, so a checkout under any of them matches. This
  was not hypothetical — it misclassified every stack in the live fixture.
  Still open: a relative mount source, and symlinks other than the `/private` ones. Both still yield
  `shared`. A general symlink resolver is deliberately not used — the comparison must agree with the
  realpath identity.mjs already stored, not discover new equivalences, and resolving per mount per
  checkout would put filesystem calls on the poll's hot path.

## Open questions

- **Per-container classification.** A single Compose project could legitimately contain both a
  shared database and a per-branch app container (configuration 3 within one stack rather than
  across two). Classifying per stack puts the whole project in one place. Splitting it would render
  containers of one `docker compose down` unit in two regions, which is arguably worse. Deferred
  until a real repository exhibits it — the current design classifies per project, and this is
  recorded so the constraint is a choice rather than an oversight.
- **Does `shared` deserve a distinct visual weight from a checkout row?** It is a peer in the
  hierarchy but a different kind of thing. Starting with the same row treatment under its own
  heading; revisit once it can be seen on a real card.
  **Revisited, and the answer is no — keep the peer treatment.** Seen on the live fixture, the
  heading plus position already carry it: the region sits below every checkout, which is the
  containment being described, and the stack renders as a full (non-member) compose card because
  without an owning checkout there is no root section to inherit git context from. That difference
  is legible without a second visual language for it. The one thing worth stating in words rather
  than styling is *why* it is shared, and that is in the tooltip via `OWNERSHIP_EVIDENCE` — "mounts
  span several checkouts" and "mounts resolve to no checkout" are different claims and read as such.
  Left open: whether an `unverified` stack (no bind mounts at all) should be visually distinguished
  from a genuinely `shared` one. They render identically today and are deliberately different claims
  — evidence of sharing vs absence of evidence. No real repository has produced an `unverified`
  stack yet, so there is nothing to look at.

## Follow-ups

Not blocking this plan; recorded where the work would start.

- **Cross-poll mount caching.** ~~Measure before optimising.~~ **Measured — not worth doing.**
  `collectDockerMounts` over the 11 containers running on this machine costs a median of 184ms
  (range 146–327ms across five runs) against its own 6000ms timeout, while a full refresh takes
  4.9–6.0s. The batched `docker inspect` is roughly 3% of the scan, so caching it would buy ~3% at
  the cost of a second staleness question to reason about — mounts are immutable for a container's
  lifetime, but a recreated container reusing an id would silently serve the old ones.
  The cost that would justify revisiting is container COUNT, since the call is one batched inspect
  over every container: 11 is small, and a machine running an order of magnitude more may land
  somewhere that matters. Re-measure there rather than assuming this result carries.
- **A merge prompt for a repointed checkout.** ~~Nothing offers the user the merge.~~ **Closed, and
  no merge is planned.** The rename case is detected and resolved automatically, and the duplicate
  card that motivated the prompt no longer appears.
  Merging was investigated on the live registry before being dropped, and the finding is the reason
  it is closed rather than deferred: **there is nothing worth carrying over.** Diffing the two real
  records showed empty `enrollments` on both sides, empty `aliases`, default visibility/activity, and
  a `localRoots` set the successor already held. The only unique data was five days of "first seen"
  provenance and two `rootId`s for directories that no longer exist.
  Nothing points at the old record either: plan-docs derives `repositoryId` live from the git remote
  (`modules/plan-docs/index.mjs`), as do discovery and the repository card, so after a rename they
  follow the new id on the next scan. No plans, links, or settings are ever stranded on the old
  record — which is what a merge would exist to rescue.
  **Phase 2's premise was wrong, and this is the correction.** It declined to act on a rename because
  it believed "a deleted-then-recloned directory produces exactly the same observation". It does not.
  A `rootId` is a hash of an absolute path, so the same one on two records is direct evidence the
  same DIRECTORY was seen under both remotes, and the most-recently-seen root separates the cases: a
  rename carries it across (only the remote moved), while a reclone leaves it behind (the new clone
  lives elsewhere). `renamedInto` in `modules/repositories/lifecycle.mjs` reads that, and
  `applyRenameAliases` acts on it each scan.
  Two earlier discriminators were tried and are recorded in that function's comment because both look
  correct and are not: requiring EVERY root to carry over fails on any record old enough to have
  abandoned a directory, and filtering roots by "last seen after the successor was created" can never
  match anything, because the old record stops being written the moment the remote changes.
  **The action is an alias, not a merge, and that asymmetry is what makes it safe to automate.** An
  alias leaves both records intact, renders one row, and is undone by deleting one line; a wrong one
  costs a row until removed. A merge could hide one repository's work inside another — still refused.
  Verified live: the registry was reset to its pre-alias state and the portal re-detected and
  re-aliased `harness_configs` -> `roborepo` on its first scan with no manual step, taking the list
  from 9 rows to 8. Idempotent — four polls over 40s produced no revision bump.
  **What is now closed is the manual path.** The rename decision says a visible duplicate is "fixable
  with one `setAlias`", but the repository list did not consult aliases at all, so setting one
  changed nothing on the page and the fix the design points at did not work. `collectPersistedRepositories`
  now skips any record whose id resolves elsewhere. The distinction from `supersededBy` is the point:
  that one INFERS from repointed checkouts and refuses to guess, this one acts on an explicit
  instruction, so it can resolve cases the evidence never could.
  `harness_configs`/`roborepo` was exactly such a case — three roots, none with a recorded path,
  unprovable from stored data. The user confirmed the rename, an alias was set, and the list went
  from two `roborepo` rows to one with both records intact.
  Worth recording precisely, because the plan's own framing was slightly off: the duplicate was never
  *visible as* `harness_configs`. Its `displayName` is already "roborepo", so it rendered as a second
  card with the same name — which is harder to notice than a stray unfamiliar one.
- ~~**`wireCopyBranchButton` leaves an enabled no-op button.**~~ **Fixed.** It now takes the same
  three steps `mountCopyDropdown` does — strip icons, `disabled = true`, remove `aria-label` —
  rather than only the first. Stripping the icons made the control merely *look* inert: left enabled
  it stayed focusable and clickable and kept announcing "Copy branch name" from the markup, so
  sighted users saw plain text while keyboard and screen-reader users found a button that does
  nothing. Appearance is unchanged, since `.is-static` already sets `pointer-events: none` and
  neutral colors and no `:disabled` rule targets it.
  It was also NOT unreachable, as previously recorded: `menugoats`, `traefik_vps` and
  `localhostr_web` are all on `main`, which is exactly the default-branch case that triggers it.
