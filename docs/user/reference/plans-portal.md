# Plans Portal Reference

## Purpose

The Plans portal is a built-in RoboRepo portal page for local Markdown planning documents. It is
paired with the optional plan suite: the `plan-suite` package, which installs `/plan-write`,
`/plan-promote`, `/plan-execute`, `/plan-review`, `/plan-close`, and `/plan-archive`, and the
`session-close` package, which installs `/session-close`.

## Concept Model

| Noun | Meaning | Source of truth |
| --- | --- | --- |
| Repository | A repository RoboRepo knows about, found through auto-discovery or an added folder | repository registry, managed under **Manage repositories** |
| Checkout | The main checkout, or one of its linked worktrees | Git |
| Plan | Markdown file under `docs/plans/**/*.md` | repository file |
| Lifecycle | Folder under `docs/plans` | path, not frontmatter; the folders and moves are declared in `manifests/platform/plan-lifecycle.json` |
| Structure | Whether the plan has every required section and field for its folder | parser/validator |
| Plan freshness | Relationship between `reviewed_commit` and Git HEAD | Git metadata |
| Review outcome | Open findings and the recorded approval in the plan's `## Review` section | the authoritative copy of the plan |

Lifecycle folders, in order:

```text
backlog
ready
active
review
completed
archived
```

Root-level `docs/plans/*.md` files are reported as `unclassified`. Structure and plan freshness are
not lifecycle stages, and neither is a human's approval.

## What The Portal Writes

The portal writes one file: `plans-order.json` under `docs/plans/`, when you press **Save** in Backlog's
Ordering mode. See [Backlog](#backlog). It never writes a plan file. The plan suite's commands move
plans between lifecycle folders, each with one commit in the main checkout. Which repositories Plans
reads is RoboRepo state, not a property of any repository.

## Which Repositories Plans Reads

Plans reads every visible repository RoboRepo knows about that has a recorded checkout; see
[Repository sources](repositories.md#repository-sources) for how repositories become known. A known
repository is read without a separate "include in Plans" step, and one without `docs/plans`
contributes no plans. Ignored repositories are left out.

For each repository, Plans reads `docs/plans/**/*.md` in every checkout: the main checkout, found
through Git's common directory, and each linked worktree. Copies of one plan in different checkouts
are matched by plan `id`, and Plans shows each plan's one authoritative copy.

The main checkout's copy decides which lifecycle stage a plan is in, because every lifecycle move
is committed there, on the base branch. While a plan is active or in review, the worktree its
`worktree` field names decides what the plan says: implementation and review record their progress
there, and Plans reads it there, with no copy to the main checkout. The worktree's copy counts only
while that worktree exists and its copy has the same `id`, is in `active/` or `review/`, and names
the same worktree. Whether a worktree is ahead of or behind main changes nothing.

The two copies can sit in different folders. The main copy moves first, so during review the
worktree's copy is often still in `active/`. Plans shows the plan under Review, reads its content
from the worktree, and lists the main copy's path as **primary copy** in the drawer. The next base
synchronization brings the rename into the worktree.

| Plan | Plans page shows | Finding |
| --- | --- | --- |
| Backlog, ready, completed, or archived | Main copy | None |
| Active or review, no `worktree` | Main copy | None |
| Active or review, its worktree holds a usable copy | Worktree copy, **From worktree `<name>`** in the drawer | **Edited outside worktree** when the main copy holds a version the worktree never had |
| Active or review, its worktree or the worktree's copy is not usable | Main copy | **Worktree copy unavailable**, with the reason |
| Only in a worktree | Worktree copy, labeled with the worktree name | None |

A copy in any other worktree is never shown and never produces a finding; those worktrees usually
hold an older copy of main.

The outside-edit check compares the main copy with the versions the worktree's own history already
contains: the plan where the worktree branch forked, every plan version the branch's commits
produced, and the worktree's current file. A squash or rebase merge that main has pulled matches
one of those, so it is not an outside edit; an edit made on main and not yet merged into the
worktree is. Resolve one by merging the base branch into the worktree, or by moving the edit into
the worktree's copy and reverting it on main. Plans never merges, overwrites, or picks between the
copies itself. When Git cannot answer (a detached `HEAD`, a missing branch, a timeout), the plan
shows **Outside edits not checked** instead.

Nothing records which copy is authoritative: every scan derives it from Git and the files on disk,
so portals started from different checkouts, or running different RoboRepo versions, agree. A
portal that predates this rule shows and writes the main copy, and current portals report its
writes as outside edits.

### Scan state

Each repository carries a scan state, and a repository Plans has not read is never reported as having
zero plans:

| State | Meaning |
| --- | --- |
| `scanned` | At least one checkout was read. |
| `unavailable` | The repository has recorded checkouts, but none is readable now. |
| `error` | Reading failed; the page lists the error without a filesystem path. |

Home's per-repository plan counts read the same states: a repository without a `scanned` state shows
that Plans has not scanned it.

### Onboarding

The page shows one call to action at a time:

| Step | Condition | Plans shows |
| --- | --- | --- |
| 1 | plan-suite package disabled | The plan suite banner |
| 2 | No repository has a recorded checkout | The same repository empty state as Home: **Enable auto-discovery of active repos**, then **Add a folder** |
| 3 | Repositories known, none scanned | `Not scanned yet: N repositories`, with **Manage Repos** |
| 4 | Repositories scanned, no plans | `No plans found in N repositories`, with **Manage Repos**; with a repo selected, `No plans yet found in <repo>` on the page itself (no panel) and **View All Repos**, which clears the repo filter |
| 5 | Plans found | The plan board under one sticky row that pins just below the site header: the lifecycle title with **Refresh** (an icon; rescans plan files on disk, since the board does not poll), the lifecycle tabs, and **Filters** at the far right. On narrow screens the tabs collapse into a menu on the left and Refresh moves to the right of Filters. Filters in effect show as removable tags under the row |

### Repository scope

The repo selector (labeled **Viewing**), in its own row in the pinned portal header, narrows Plans to one repo; the choice is the
URL's `?repo=` parameter and carries over to Tokens and Agents. Scoped, the header count and
the onboarding steps above describe that repository alone, and a repository Plans has never read
shows as not scanned. Search and the other filters stay as they are when the scope
changes. A link that names a repository RoboRepo no longer lists shows **Repo unavailable**
instead of any plans, with an action to show all repos.

**Filters** opens a popup (search, blocked, structure, plan freshness, health). Changes are drafted there and
applied by **Update**, which stays disabled until something differs from the filters in effect; **Cancel**,
the close button, Esc, and the backdrop discard the draft.

### Backlog

Backlog answers "what do I build next?" one namespace at a time. Every other lifecycle tab keeps its
flat list of cards across all selected repos.

| You have selected | You see |
| --- | --- |
| **All repos** | Repos with Backlog plans, each with its plan count and unprioritized count |
| A repo | Its namespaces with Backlog plans, each with counts; **No namespace** last, when any plan lands there |
| A repo and namespace | **Needs prioritization** first when it has plans, then **Ordered**, as **Details** or **Ordering** |
| A repo and **No namespace** | Each file's exact name, its findings, and **Copy Repair Prompt** |

The namespace is the URL's `?namespace=` parameter, so reload and back/forward keep your place.
Filters narrow the directory counts and the Details cards. Ordering always shows the whole namespace
and hides Filters, because moving a row among hidden rows has no defined result.

A plan's namespace is the longest approved `<namespace>-` prefix of its filename. It is derived on
every read and never stored. Backlog shows it ahead of the title, as `PORTAL · Improve plan review`;
the H1 is untouched. Approved means the keys of `docs/plans/plans-config.json` plus the universal
namespaces. A repo with no config shows one **No namespace** row with its plans as ordinary cards and
a notice pointing to `/plan-suite-init`, since it never adopted the convention. A malformed config is
reported as an error and every plan shows under **No namespace** until it is fixed.

**Details and Ordering** show the same plans in the same order. Details is always flat cards.
Ordering shows compact rows and groups linked plans:

- Plans connected by direct `depends_on` edges, both ends in this namespace's Backlog, form one block
  that moves as a unit. A join or fork is one block too; listing `B` before `C` claims nothing about
  `B` and `C`. A prerequisite in another lifecycle or namespace connects nothing, so once a shared
  prerequisite leaves Backlog its dependents become separate rows that keep their positions.
- **Ordered** controls, right side, in order: **Move to top**, **Move up**, **Move down**, **Move to
  bottom**, drag handle.
- **Needs prioritization** controls: **Move down** (to the top of Ordered), **Move to bottom**, drag
  handle.
- A namespace with a dependency cycle or a missing prerequisite shows why and locks its controls.

Moves stay in a draft. **Save** writes the namespace's whole order at once; **Cancel** discards the
draft after asking. Leaving a dirty draft by any route (the mode toggle, a lifecycle tab, the repo
selector, a header link, back or forward) first shows "Your prioritization changes have not been
saved." with **Save and continue** or **Cancel**. Closing or reloading the tab raises the browser's
own prompt. If the namespace changes underneath a draft (another tab, an edited `depends_on`, a
config edit), **Refresh** or **Save** marks it stale: nothing is overwritten, and you discard it and
start from the current order.

**The order file.** `plans-order.json`, under `docs/plans/`, holds one array of plan ids per namespace, in the
main checkout, left uncommitted like any other edit there. A missing file means every plan is
unprioritized. Priority is never compared across namespaces or repos.

```json
{ "schemaVersion": 1, "namespaces": { "portal": ["h3j4k5m6", "a1b2c3d4"] } }
```

The order you see is calculated on every read, and a read never writes:

| Change | What you see | The file |
| --- | --- | --- |
| A new independent plan | Needs prioritization | Unchanged |
| A plan connected to a ranked plan, by a new plan or a new `depends_on` | Its whole group is ranked at the earliest ranked member; Ordering says what moved | Written at the next Save or `order place` |
| A removed `depends_on` | The plans keep their positions | Unchanged |
| A plan leaves Backlog | Ignored; the others keep their relative order | Pruned at the next write |
| The file names an unknown plan | Excluded, with a finding | Preserved |
| The file has a namespace that is no longer approved | Excluded, with a finding | Preserved |
| The file cannot be parsed | Every plan unprioritized, with a finding; Save refuses | Never overwritten |

A plan with no `id`, or a duplicate one, stays in Needs prioritization with no controls.

### Limits

- maximum document size for rendering/prompt embedding: 1 MiB
- maximum plan files per repository checkout: 500

Hidden files, editor swap files, backup suffixes, and symlink escapes outside the checkout are
skipped.

## Plan Parsing

Frontmatter supports a strict YAML-compatible subset:

```yaml
key: scalar
key: []
key:
  - item
```

Supported managed fields:

- `id`
- `next_action`
- `blocked_by`
- `depends_on`
- `related`
- `reviewed_commit`
- `worktree`

Unsupported syntax produces warnings rather than guessed behavior. Duplicate keys, invalid IDs, and
non-array relationship fields are warnings. Any other key, such as a leftover `priority` line, is
ignored.

The Markdown parser extracts:

- H1 title
- headings
- Markdown checkbox tasks
- excerpt
- the `## Review` record: open and total findings under `### Findings`, and the `Decision`,
  `Reviewed implementation commit`, and `Confirmed by` lines under `### Approval`

`### Result` separately records review `Status`, its `Reviewed implementation commit`, and
`Base commit`. `roborepo plans approval <plan> --json` reports that review's freshness under
`review`, with changed implementation or base paths, independently of the human approval state.
The portal's approval indicator continues to reflect `### Approval`; a complete review awaiting
your answer is not an approval.

### Worktree association

`worktree` is optional. When set, it holds Git's administrative name for the linked worktree
implementing the plan — the `<name>` in `.git/worktrees/<name>`, not the checkout directory and not
the branch. It never holds a path. New and repaired plans get an empty `worktree:` line; older plans
without the line stay valid. `/plan-execute` records the value through `roborepo plans start`,
which commits it to the plan on the base branch and validates it before implementation moves into
the worktree.

Home uses the value to show an active or review plan as its worktree's checkout row. Anything short of one
exact match leaves the plan as its own row with a badge: **no worktree** for an empty value,
**worktree not listed** for a worktree Git has that Runtime does not list, **worktree missing** for
a name Git has no worktree for, **worktree ambiguous** for a name claimed by two plans or matching
more than one checkout, and **worktree status unknown** when Runtime is unavailable. See
[Repositories](repositories.md#repository-cards).

The plan row's worktree dropdown offers **Stop Server** and **Delete Worktree**; the deletion
confirmation names the plan that claims the worktree and warns that the plan's progress
recorded there will no longer be shown in Plans. Automatic worktree cleanup never
removes a worktree an active or review plan names. `/plan-close` removes it as its last step, once the plan is
in `completed/` and every removal guard passes. See
[Worktree states and cleanup](repositories.md#worktree-states-and-cleanup).

## Validation

A complete structure requires:

- H1 title
- frontmatter `id`
- Summary section
- Goals or desired outcome section
- Current state or Context section
- Proposed design or Implementation plan section
- Validation, Acceptance criteria, or Success criteria section
- `next_action` for backlog, ready, active, and review plans

Other warnings include:

- unclassified root-level plan file
- duplicate plan IDs in a repository
- an active or review plan's main-checkout copy edited outside its worktree
- an active or review plan whose worktree, or the worktree's copy, is not usable
- an active or review plan whose outside edits Git could not check
- missing dependencies
- self-dependency
- completed plans with unchecked tasks, blockers, or next action
- oversized documents

Warnings are surfaced in the list view and document drawer. They do not move files automatically.

Section requirements are matched by heading label against a synonym list, so `Purpose` satisfies
Summary, `Current behavior` satisfies Context, and so on.

## Lifecycle Changes

The Plans page has lifecycle tabs for browsing: Backlog, Ready, Active, and Review as tabs, with
Completed, Archived, and Unclassified behind the ⋮ menu. It does not offer a lifecycle dropdown or
move dialog. The plan suite's commands move plans, each through one `roborepo plans` transition:

| Move | Transition | Run by | Refused unless |
| --- | --- | --- | --- |
| backlog → ready | `promote` | `/plan-promote` | the plan has no findings against the Ready requirements, its filename passes the naming rules, and `plans-config.json` can be read |
| ready → active | `start` | `/plan-execute` | a linked worktree has the given name, the plan meets the Active requirements, its filename passes the naming rules, and `plans-config.json` can be read |
| active → review | `submit` | `/plan-execute` or `/plan-review` | the completion preflight passes |
| review → active | `reopen` | `/plan-review` | (none beyond the common checks) |
| review → completed | `close` | `/plan-close` | the worktree copy is integrated, the approval is fresh, the branch landed, and the plan has no findings against the Completed requirements |
| backlog, ready, active, or review → archived | `archive` | `/plan-archive` | a reason is given, and the worktree and main copies are not both edited |

Every transition runs in the main checkout on the base branch, refuses when the plan's own path has
uncommitted changes it did not make, commits only the plan's old and new paths, and approves the
result only after six checks read fresh from Git. Other work in the main checkout is never
committed. A refusal changes nothing; repeating a move that already happened commits nothing. The
page can still show validation findings for a plan that needs repair.

## Git Metadata

For Git repositories, the scanner attempts to collect:

- HEAD
- branch
- last commit date for each plan file
- file status
- plan freshness from `reviewed_commit`

Plan freshness says whether the document was checked against the code, not whether anyone
approved the work:

| Value | Shown as | Meaning |
| --- | --- | --- |
| `never-reviewed` | never checked | no `reviewed_commit` |
| `current` | checked, current | `reviewed_commit` equals HEAD |
| `possibly-stale` | possibly stale | `reviewed_commit` is an ancestor of HEAD |
| `unknown` | freshness unknown | commit is missing, unavailable, or not in current history |

Repositories without Git remain browsable.

## Package Integration

The plan suite is two optional packages: `plan-suite`, which holds the six plan skills and the
Code Outlives Plans rules fragment, and `session-close`. The Plans page gates its workflow actions
on `plan-suite`, and its onboarding banner enables both in one request through the config bulk
endpoint (`/api/config/packages/bulk`).

When `plan-suite` is disabled:

- `/plans` remains available, behind the onboarding banner
- copying the document filename and repository-aware context remains available
- workflow prompt actions stay hidden

When enabled:

- each of the six plan skills (and `/session-close`, once its own package is enabled) is a manual
  skill with Markdown command wrappers for Claude,
  Codex, and Gemini. Gemini CLI requires TOML custom commands, so its generated wrappers are not
  usable native slash commands yet
- `/plans` shows each lifecycle's actions, read from the lifecycle manifest the plans snapshot
  publishes:

  | Lifecycle | Actions |
  | --- | --- |
  | backlog | Promote, Archive |
  | ready | Start, Refine, Archive |
  | active | Continue, Review, Archive |
  | review | Review, Fix findings, Close, Archive |

- backlog cards with unfinished `depends_on` entries show the Copy menu followed by **depends on** and linked
  plan IDs instead of Promote; their card and popup menus omit Promote. IDs resolve within the
  same repository, and missing dependencies remain plain text. Dependencies in the `completed`
  lifecycle are omitted; when all dependencies are completed, Promote returns to the card and
  popup menus. The frontmatter retains the dependency history. Other backlog cards lead with
  Promote, and ready cards lead with Start. Unblocked review plans lead with Close
  when approved, or Review otherwise. Active plans keep their commands in the Copy menu until
  execution moves them to review. Close still verifies that the PR merged before completing a plan
- modified time and document warnings sit in a compact, right-aligned column on wide
  cards and a row below the description on smaller screens. Modified time uses a clock icon and
  a short age such as **2 hrs**; its tooltip gives the exact date. The bottom row keeps the primary
  action and Copy menu at the left, with blockers, open review findings, and task progress at the right
- Copy menus use compact labels with copy icons and flush hover backgrounds. Update and Portable Prompt are
  omitted. **Copy Document Filename** sits below a divider and copies only the filename; the
  popup header's separate path button still copies the repository-relative path. Shared copy
  controls confirm with a green check while keeping their original labels
- an active or review plan whose worktree has merged shows a **merged** completion badge; the same
  status is visible in the detail drawer
- every action copies a prompt; the page never runs a command or moves a plan for one

## CLI

Suite skills run these commands rather than re-deriving the rules they implement. Every
lifecycle transition (`promote`, `start`, `submit`, `reopen`, `close`, `archive`) runs from the
primary checkout, commits only the plan's paths on the base branch, never pushes, and exits 1 when
it refuses or a post-commit check fails:

| Command | What it does |
| --- | --- |
| `roborepo plans validate [<plan>] [--json]` | Reports the deterministic findings the Plans page shows, for one plan (by id or path) or every plan in the current repo. From the main checkout, an Active or Review plan is validated from its worktree's copy, as the page shows it, and the output names that copy. From a linked worktree, it validates that worktree's own copies. Exits 1 when a blocking finding remains. |
| `roborepo plans promote <plan> [--base <branch>] [--json]` | Moves a backlog plan to `ready/` with its pending edits, or commits refinements to a ready plan in place. Refuses, with the findings and a repair prompt, a plan that does not meet the Ready requirements. |
| `roborepo plans start <plan> --worktree <name> [--base <branch>] [--json]` | Records the worktree in the plan, moves a ready plan to `active/`, and validates the transition. On an active plan it records a replacement worktree in place. |
| `roborepo plans submit <plan> [--base <branch>] [--json]` | Runs the completion preflight and, when it passes, moves an active plan to `review/`. |
| `roborepo plans reopen <plan> [--base <branch>] [--json]` | Moves a review plan back to `active/` after a requirements change. |
| `roborepo plans close <plan> [--base <branch>] [--json]` | Checks that the worktree copy is integrated, the approval is fresh, and the branch landed (including squash and rebase merges), then moves a review plan with its closing edits to `completed/`. |
| `roborepo plans archive <plan> --reason <text> [--base <branch>] [--json]` | Records the reason under `## Archived`, clears `next_action`, carries an unintegrated worktree copy once, refuses conflicting copies, and moves the plan to `archived/`. Never removes a worktree or branch. |
| `roborepo plans preflight <plan> [--base <branch>] [--json]` | Reports whether implementation is complete: no task outside `## Not tested` open, no blockers, a clean worktree, a branch with its own commits, and no Review findings apart from Not tested. Exits 1 when a check fails. |
| `roborepo plans landed <plan> [--base <branch>] [--json]` | Reports whether the plan's branch landed on the base branch, including squash and rebase merges, and the commit that absorbed it. Verifies an absorbing commit recorded in the plan's `## Verification` (`- Absorbing commit: <full commit id>`) before scanning base history, and says whether it reused that evidence. Read-only. Exits 1 unless landed. |
| `roborepo plans approval <plan> [--base <branch>] [--json]` | Reports the recorded approval as `fresh`, `stale` (with the changed paths), `missing`, `not-approved`, `invalid`, or `unavailable` (the plan's worktree is gone or detached, so its branch cannot be resolved). The text output counts base changes since the review; `--json` lists them. Exits 1 unless fresh. |
| `roborepo plans sync-base [--continue] [--base <branch>] [--json]` | From a plan's linked worktree, merges the base branch into its branch; does nothing when up to date. Pauses on conflicts and exits 1; `--continue` refuses while conflicts or markers remain, then commits the merge. Refuses a dirty worktree or a base behind its upstream. Never merges into the base branch. |
| `roborepo plans stop-servers <plan> [--dry-run] [--json]` | Sends `SIGTERM` to the processes listening on a port from inside the plan's linked worktree, then reports each as `stopped`, `still-running`, `gone`, `changed` (PID reused), or `failed`. A plan without a worktree stops nothing. Exits 1 when a server survives or cannot be signalled. macOS only, like Runtime discovery. |
| `roborepo plans order place <plan> [--top\|--bottom] [--json]` | Records a Backlog plan's position in its namespace's order. A plan connected to a ranked plan but not yet in the file joins its group, and any flag is ignored. `--top` or `--bottom` otherwise moves the plan with its group. With neither, a plan that is not ranked stays in Needs prioritization and nothing is written. Lists automatic moves. Exits 1 when the plan has no approved namespace or the order file cannot be read. |
| `roborepo plans repair <root> [--dry-run]` | Scaffolds frontmatter (a fresh opaque `id` and a placeholder `next_action`) for plan docs missing it in every repo under `<root>`, so the portal can read them. `--dry-run` lists them without writing. Exits 1 when a repo cannot be read. |
| `roborepo package status <id> [--json]` | Prints one package's `available`, `enabled`, and live `status`, so a suite skill can tell a disabled helper skill from a drifted one. |

## Not Tested Entries

A plan's `## Not tested` section lists built work that no test covers, one checkbox per entry.
Unchecked entries on an active, review, or completed plan produce the `UNCONFIRMED_NOT_TESTED`
finding. They never block the move to review, and `/plan-close` refuses to close a plan while any
remain. Headings and checkboxes inside fenced code
blocks never count as plan structure.

The Plans page uses the normalized package catalog state. It does not inspect skill symlinks directly.

## Security And Privacy

- The portal binds to loopback only.
- The browser never sends file paths; the server reads only plans it discovered itself.
- Repository sources scope repository discovery; their paths appear only in the Manage repositories
  dialog.
- Plan records and `/api/plans` responses, including scan errors, do not expose absolute paths.
- Portable prompts requested through the API use repository name, relative path, metadata,
  warnings, and bounded excerpts; the portal's Copy menus offer repository-aware prompts only.
- The browser does not execute document scripts, and writes only the changes described in
  [What The Portal Writes](#what-the-portal-writes).

## Landed review recovery and cleanup

After verified landing, committed evidence-only recovery can select the primary plan with
`authority.source: primary` and reason `verified-landed-recovery`. Result and Approval remain
separate records. The shared verifier checks repository/worktree identity, integrated precursor
blobs, exact implementation, and historical absorption. Conflicting records or missing/detached
worktrees do not qualify. Primary recovery selection supplies evidence only.

`roborepo plans merge-readiness <plan> --json` reports pre-merge readiness with repair instructions.
After durable closure, cleanup uses the shared preservation assessment. Remaining or uncertain
work keeps the checkout and offers explicit Archive and remove; closure stays committed even if
cleanup fails. See [the recovery commands](repositories.md#worktree-states-and-cleanup).
