---
id: gy8ncs9u
next_action: Ready to build once the Claude sandbox plan (9njvfh5z) merges; start it with /plan-execute.
blocked_by: []
depends_on: ["9njvfh5z"]
related: ["9njvfh5z", "n8kw3rp2", "wu7h7gdp"]
reviewed_commit: 26dad21f
worktree:
---

# Give agents two places for temporary files, cleaned up automatically

## Summary

Agents write throwaway files to a different place each time: the system temp folder, Claude's
per-session scratchpad, `/tmp`, ad hoc `mktemp` folders, and log files dropped next to them. Nothing
removes most of it. On the machine surveyed for this plan, temporary leftovers came to about 620 MB
across three temp folders, the oldest from two weeks earlier.

This plan gives agents two places to write and nothing else: Claude's session scratchpad for
throwaway files, and a new roborepo scratch folder for everything else. The scratch folder joins
the existing retention registry, so it is pruned by age the same way roborepo's other stores are,
without the user doing anything. Roborepo's own temp helpers and test runner clean up after
themselves.

## Goals

- An agent can tell from one short rule where to write, in Claude and in Codex alike.
- Temporary content disappears on its own: no user command, no reminder.
- Content that must outlive a session never sits where the operating system may clear it.
- A dry run shows what cleanup would remove before anything is removed.
- Cleanup deletes only inside the scratch folder roborepo owns.

## Non-goals

- Other stores under `~/.roborepo/` (telemetry, runtime history, logs). The retention registry in
  `modules/retention/registry.mjs` already bounds them, and Generated State Stores (n8kw3rp2) owns
  the open gaps, including the telemetry collector cursors.
- Cleaning folders the harnesses own: Claude's session folders and scratchpads, `~/.claude/`,
  `~/.codex/`.
- Worktree removal, which the existing worktree cleanup owns.
- Committed folders at the repo root (`scratch/`, `sketches/`, `rename/`). They are tracked source.

## Current state

### Where temporary content goes today

Measured on 2026-11-14 with `du` on one macOS machine. A temp root is a system temp folder; Claude's
shell sandbox sets `$TMPDIR` to `/tmp/claude-<uid>`, so one machine has several.

| Location | What lands there | Who writes it | Cleaned up | Size |
| --- | --- | --- | --- | --- |
| User temp root (`/var/folders/.../T`) | 5,532 roborepo-named folders: test fixtures (`roborepo-app-*`, `cli-test.*`, `portal-ui-*`) and 3,090 `roborepo-disposable-*` folders | Roborepo's tests; `withTemporaryStorage` in `modules/repositories/temporary-storage.mjs` | No. Oldest from 2026-11-03 | 384 MB |
| Claude sandbox temp root (`/tmp/claude-<uid>/`) | 46 per-session folders holding scratchpads; 112 loose entries: 29 `*-check.log` / `*-check.err` files, agent `mktemp` folders, probe scripts | Claude Code; agents | No cleanup seen. Oldest from 2026-10-31 | 222 MB (93 MB session folders, 130 MB loose) |
| `/tmp` outside the sandbox folder | About 70 agent probe folders and files: `roborepo-validator-*`, `roborepo-protected-push-*`, `rm-ask-probe` | Agents running outside the sandbox | No | About 15 MB |
| `~/.roborepo/browser/evidence/` | Screenshots, recordings, traces | `roborepo browser run` | Yes: 14 days or 250 MB, through the retention registry | 696 KB |
| `~/.roborepo/telemetry/collector/` | 4,081 per-session cursors | Telemetry capture | No; owned by n8kw3rp2 | 16 MB |

Not measured: the temp root Codex sets inside its own sandbox, and whether macOS clears the user
temp root at boot on this machine. Folders 11 days old survive there, so it is not cleared daily.

### What the instructions tell agents

The sources below send the same kinds of file to different places, and none says which place fits
which purpose:

| Source | Says |
| --- | --- |
| `globals/packages/tool-call-optimization/rules.md` | Scratch work goes under `$TMPDIR`/`/tmp` with `mktemp -d`, removed by a `trap` in a script file |
| `globals/packages/test-harness/skills/test-harness/SKILL.md` | Large test output: use `roborepo run` or redirect to `/tmp` |
| `globals/packages/plan-suite/rules.md` and plan-write's `plan-schema.md` | Plan edits go in "a copy outside the code checkout" |
| Claude Code's own system prompt | Use the session scratchpad for all temporary files |
| `docs/user/reference/roborepo-cli.md` (`delivery pr-body`) | The pull request body must be a file under `/tmp`, `/var/tmp`, or `/var/folders` |

Evidence and durable results are already settled: `roborepo browser` stores screenshots and
recordings, and the plan-suite skills require evidence to be written into the plan itself.

### What already exists to build on

- The retention registry (`modules/retention/`) lists every bounded store under `~/.roborepo/` with
  an age or size bound. Each store is pruned on its own write path; `roborepo maintenance stores`
  lists and resets them; doctor reports any store over its byte cap.
- `withTemporaryStorage` creates a temp folder and removes it after use. When the shell sandbox
  denies removing a folder, it leaves the empty folder behind with a warning. That is the source of
  the 3,090 `roborepo-disposable-*` folders.
- Registry stores today come in two shapes, a log and a file set. `measureFileSet` in
  `modules/retention/file-set-store.mjs` judges each top-level file by its own modification time and
  never removes the last remaining file. `roborepo maintenance stores reset <id>` applies a store's
  policy; `--all` clears it. Neither form can preview what it would remove.
- `roborepo delivery pr-body` (`scripts/cli/delivery.mjs`) reads the body only from fixed system
  temp folders (`/tmp`, `/var/tmp`, and `/var/folders` on macOS), never from `$TMPDIR`, and refuses
  any file the `read-secrets` denylist names.
- Production code that makes temp folders (`scripts/cli/plans.mjs`, `modules/plan-suite/plan-store.mjs`,
  the two Playwright runners under `scripts/cli/browser/`) removes them in a `finally` block.

### Sandbox constraint

Cut Claude permission prompts by running shell commands in the native sandbox (9njvfh5z) lets
sandboxed shell commands write only to temp roots, the checkout, and a short list of extra folders.
That plan is in review and not merged into `main`; its branch adds the list as
`CLAUDE_SANDBOX_WRITABLE_PATHS` in `scripts/harnesses/claude/sandbox-settings.mjs`, holding `~/.npm`
today. A sandboxed shell cannot write to `~/.roborepo/`; `roborepo` commands are excluded from the
sandbox and can.

The shared `write-scope` path list in `manifests/inventory/agent-permissions.json` is not a place to
add the scratch folder: `scripts/test/permission-rule-home-path-check.mjs` refuses any allow rule
anchored to a home folder, and that plan put `~/.npm` in the provider list for the same reason.
Codex's sandbox is expected to allow temp roots and the workspace in the same way; that was not
checked for this plan.

## Proposed design

### Two places to write

| What the agent is writing | Where | Removed |
| --- | --- | --- |
| A throwaway file in Claude | The session scratchpad Claude provides | By Claude; roborepo never touches it |
| Anything else temporary: throwaway files in Codex, notes handed between sessions, a long investigation's intermediate results | `~/.roborepo/scratch/<name>/`, from `roborepo scratch <name>` | 14 days after its last change |

The rule fragment says only this, plus: never write temporary files into the checkout or `/tmp`
directly. Screenshots and durable results keep the homes they already have.

### `roborepo scratch <name>`

The command creates `~/.roborepo/scratch/<name>/` if needed, updates its modification time, prints
its path, and prunes scratch folders past the age limit. Because it touches the named folder before
pruning, a call never removes the folder it is about to hand back. Running it is the store's write
path, so cleanup happens whenever agents use scratch space, the same way browser evidence is pruned when a browser run starts. No
hook, schedule, or `roborepo update` step is needed. `<name>` is a plan id or a short topic; the
command rejects anything that is not a single path segment.

### Scratch as a retention store

The scratch folder becomes one more entry in `modules/retention/registry.mjs`: 14 days since last
change, with a byte cap as a backstop. The registry's file-set shape counts files; scratch holds
folders, so the entry needs a folder-set shape that measures and removes whole folders. A folder's
age is the newest modification time of the folder or anything inside it. The folder's own time
alone does not change when a file deep inside is edited. Its size is the total of the files inside it. It keeps
the file set's rule of never removing the last remaining entry. Through the
registry, scratch shows up in `roborepo maintenance stores`, in doctor, and in the portal's
Monitoring row with no further work.

`roborepo maintenance stores reset` gains `--dry-run`, which lists what the reset would remove, with
sizes and ages, and removes nothing. Every store gets it, not only scratch. With `--all` it lists
the whole store.

The folder-set removal never follows a link: it removes links as links and refuses any entry whose
resolved path leaves the scratch folder, as `withTemporaryStorage` already does.

### Sandbox access and pull request bodies

`~/.roborepo/scratch/` becomes a writable path for sandboxed shells in both harnesses. In Claude it
joins `CLAUDE_SANDBOX_WRITABLE_PATHS` beside `~/.npm`. In Codex it goes through the provider's own
writable-path mechanism, chosen by the first implementation task. It is never added to the shared
`write-scope` list. Writes to it through Claude's file tools (`Write`, `Edit`) may still prompt;
agents reach it through the shell. `delivery pr-body` accepts a file under `~/.roborepo/scratch/` as well
as the system temp folders, so a Codex agent can write its pull request body there.

### Roborepo's own leftovers

- **Test runs.** `scripts/test/run-checks.mjs` and `scripts/test/test-cli.sh` set `TMPDIR` to a
  fresh `roborepo-tests/run-<id>/` folder in the temp root and remove it when the run ends. At start
  they remove earlier runs' folders, which catches a crashed run. The roughly 120 test files that
  call `mkdtemp` need no change.
- **`withTemporaryStorage`.** Each call removes earlier `roborepo-disposable-*` folders that its own
  check confirms are empty shells. That also clears the existing 3,090 folders on every machine that
  runs it, with no separate sweep.
- **Existing test leftovers.** Only machines that ran roborepo's tests have them. The implementing
  agent removes them once on this machine after a dry-run listing; no shipped code does this.

## Related plans

| Plan | State | Relationship |
| --- | --- | --- |
| Cut Claude permission prompts by running shell commands in the native sandbox (9njvfh5z) | Active, in review; branch not merged into `main` | Unlanded dependency. This plan adds the scratch folder to the writable-path list that plan introduces. Start after it merges |
| Bound Every Local Store With One Staleness Policy (wu7h7gdp) | Completed; the retention registry is in `main` | Landed dependency. This plan adds a store and a shape to that registry |
| Generated State Stores: Inventory, Retention, and Visibility (n8kw3rp2) | Backlog | No conflict. It owns the other stores under `~/.roborepo/`; this plan touches only scratch and the shared `--dry-run` flag |

## Implementation plan

- [ ] Confirm which paths Codex's sandbox lets a shell command write and how its provider adds a
      writable folder outside the workspace; record the result in this plan.
- [ ] Add a folder-set shape to the retention module (`modules/retention/`), measured as described
      under "Scratch as a retention store", and register the scratch store in `registry.mjs`.
      Teach `scripts/cli/maintenance-stores.mjs` to trim and clear it.
- [ ] Add `--dry-run` to `roborepo maintenance stores reset`, for every shape and with `--all`.
- [ ] Add `roborepo scratch <name>`, pruning the scratch store on each call, and register it in
      the CLI command list.
- [ ] Add `~/.roborepo/scratch` to `CLAUDE_SANDBOX_WRITABLE_PATHS`, and to Codex through the
      mechanism the first task found.
- [ ] Let `delivery pr-body` accept a file under `~/.roborepo/scratch/`, keeping the symlink,
      regular-file, and `read-secrets` checks it applies to temp folders.
- [ ] Add the shared rule fragment under `globals/system/rules/shared/` and update the instruction
      sources listed under "What the instructions tell agents" to point at it.
- [ ] Give the test runners a per-run `TMPDIR` that they remove at the end and sweep at start.
- [ ] Make `withTemporaryStorage` remove its own earlier empty shells.
- [ ] Remove this machine's existing test leftovers once, after a dry-run listing.

## Validation

- A check fills a scratch store with an old folder, a recent folder, a folder whose own time is
  old but which holds a recently edited file, and a link pointing outside the store. `stores reset --dry-run` lists only the old folder and removes nothing; the reset removes
  exactly that folder, and the link target survives. `--all --dry-run` lists every entry and removes
  nothing.
- A check runs `roborepo scratch <name>` against a store holding an old folder and asserts the old
  folder is gone and the new one exists; a second check runs it with the name of an old folder and
  asserts that folder survives; a name containing `/` or `..` is refused.
- A check runs the test runner and asserts its per-run folder is gone afterwards.
- A check calls `withTemporaryStorage` with an earlier empty shell present and asserts the shell is
  removed while a non-empty folder with the same prefix survives.
- A check asserts `delivery pr-body` accepts a file under the scratch folder and still refuses one
  elsewhere in `~/.roborepo/`.
- The rendered Claude sandbox settings and the rendered Codex config both list the scratch folder
  as writable, and no allow rule in the shared permissions names it.
- The rendered Claude and Codex rules both contain the fragment.
- The existing retention, maintenance-stores, delivery, and permission home-path checks still pass.

## Risks

- **Removing something an agent still uses.** A scratch folder untouched for 14 days is removed.
  Work that must last longer belongs in the plan or the repo.
- **The sandbox may block the empty-shell sweep too.** The 3,090 shells exist because removing
  them was denied once. If the same denial recurs, `withTemporaryStorage` warns and leaves them;
  the one-time manual removal still clears this machine.
- **A store nobody writes is never pruned.** If agents stop running `roborepo scratch`, old folders
  stay until the next call. The store has stopped growing by then, and doctor reports it if it is
  over its byte cap.

## Decision Log

- **2026-11-14 — Claude keeps its own scratchpad.** It needs no permission and Claude's own prompt
  already directs agents there. Roborepo cannot clean it and does not try.
- **2026-11-14 — A shared scratch folder exists.** Codex and terminal sessions have no other place
  to share notes between sessions.
- **2026-11-14 — Cleanup runs on the scratch command, not a hook.** A session-start hook and a
  `roborepo update` step were proposed first. Pruning on the store's write path gives the same
  result with no hook, and matches how the registry already prunes browser evidence.
- **2026-11-14 — No shipped sweep for old leftovers.** `withTemporaryStorage` clears its own old
  shells on every machine; the remaining test leftovers exist only on machines that run the test
  suite and are removed once by hand.
- **2026-11-14 — No plan-close removal.** Removing a plan's scratch folder at close was proposed
  first. The 14-day age limit reaches the same end state without touching the plan skills.

- **2026-11-16 — The scratch folder joins the Claude provider's writable-path list, not
  `write-scope`.** A home-anchored allow rule fails the permission home-path check, and the Claude
  sandbox plan already put `~/.npm` in that list for the same reason. Cost: Claude's file tools may
  prompt for writes there.
- **2026-11-16 — Folder age is the newest change inside it.** The folder's own time does not move
  when a nested file is edited, so it would expire folders still in use.

## Documentation impact

- `docs/user/reference/roborepo-cli.md`: add `roborepo scratch`, `stores reset --dry-run`, and the
  wider `delivery pr-body` location.
- `docs/internal/testing.md`: the per-run test `TMPDIR`.
- `docs/user/reference/config-control-panel.md`: if it lists the sandbox's writable folders by the
  time this lands, add the scratch folder there.
- The rule fragment is the reader-facing doc for agents; `globals/packages/test-harness` and
  `tool-call-optimization` text changes with it.
