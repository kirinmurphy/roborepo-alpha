---
id: gy8ncs9u
next_action: "Implementation is committed and validated on branch local-data-agent-temp-locations; run /plan-review to review it."
blocked_by: []
depends_on: ["9njvfh5z"]
related: ["9njvfh5z", "n8kw3rp2", "wu7h7gdp"]
reviewed_commit: 26dad21f
worktree: local-data-agent-temp-locations
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
That plan merged into `main` (#66); it adds the list as `CLAUDE_SANDBOX_WRITABLE_PATHS` in
`scripts/harnesses/claude/sandbox-settings.mjs`, holding `~/.npm` before this plan. A sandboxed shell cannot write to `~/.roborepo/`; `roborepo` commands are excluded from the
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
| Cut Claude permission prompts by running shell commands in the native sandbox (9njvfh5z) | Completed; merged into `main` (#66) | Landed dependency. This plan adds the scratch folder to the writable-path list that plan introduces |
| Bound Every Local Store With One Staleness Policy (wu7h7gdp) | Completed; the retention registry is in `main` | Landed dependency. This plan adds a store and a shape to that registry |
| Generated State Stores: Inventory, Retention, and Visibility (n8kw3rp2) | Backlog | No conflict. It owns the other stores under `~/.roborepo/`; this plan touches only scratch and the shared `--dry-run` flag |

## Implementation plan

- [x] Confirm which paths Codex's sandbox lets a shell command write and how its provider adds a
      writable folder outside the workspace; record the result in this plan. Measured 2026-11-22
      with `codex sandbox -P managed-workspace` (codex-cli 0.166.0) and a fake home outside every
      temp root: the `:workspace` profile lets a shell write the workspace, `$TMPDIR`, and `/tmp`,
      and refuses everything under the home folder. A `[permissions.managed-workspace.filesystem]`
      entry `"~/.roborepo/scratch/**" = "write"` opens exactly that folder, including creating it
      when absent; `~/.roborepo/other` stays refused. The provider's `writablePaths` option is the
      mechanism; see the Decision Log for where the entry is added.
- [x] Add a folder-set shape to the retention module (`modules/retention/`), measured as described
      under "Scratch as a retention store", and register the scratch store in `registry.mjs`.
      Teach `scripts/cli/maintenance-stores.mjs` to trim and clear it.
- [x] Add `--dry-run` to `roborepo maintenance stores reset`, for every shape and with `--all`.
- [x] Add `roborepo scratch <name>`, pruning the scratch store on each call, and register it in
      the CLI command list.
- [x] Add `~/.roborepo/scratch` to `CLAUDE_SANDBOX_WRITABLE_PATHS`, and to Codex through the
      mechanism the first task found.
- [x] Let `delivery pr-body` accept a file under `~/.roborepo/scratch/`, keeping the symlink,
      regular-file, and `read-secrets` checks it applies to temp folders.
- [x] Add the shared rule fragment under `globals/system/rules/shared/` and update the instruction
      sources listed under "What the instructions tell agents" to point at it.
- [x] Give the test runners a per-run `TMPDIR` that they remove at the end and sweep at start.
- [x] Make `withTemporaryStorage` remove its own earlier empty shells.
- [x] Remove this machine's existing test leftovers once, after a dry-run listing. On 2026-11-22
      the listing found none of the surveyed two-week-old leftovers: the user temp root held about
      50 entries, all from that day. Only the files this run itself created were removed; see the
      Decision Log.

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
- **2026-11-22 — Codex gets the scratch folder from a provider constant, not per-repository
  `writablePaths`.** `CODEX_SANDBOX_WRITABLE_PATHS` in `scripts/harnesses/codex/index.mjs` is
  merged into every render, so the tracked `generated/codex/config.toml` carries it too, mirroring
  Claude's `CLAUDE_SANDBOX_WRITABLE_PATHS`. Alternative: add it inside
  `codexPlansStoreWritablePaths`, which returns nothing outside a repository with a plans store,
  so the folder would be writable only in some sessions.
- **2026-11-22 — The scratch byte cap is 500 MB.** Twice browser evidence's 250 MB, since scratch
  holds investigation output as well as notes; it is a backstop behind the 14-day age limit.
- **2026-11-22 — Scratch names are `[A-Za-z0-9][A-Za-z0-9._-]{0,99}`.** Narrower than "one path
  segment": it also refuses leading dots (hidden folders) and spaces. Plan ids and short topics fit.
- **2026-11-22 — Folder-set removal lives in the retention module.** The log and file-set shapes
  leave the commit to each store because their readers differ; a folder set has no reader, and
  both callers (the scratch command and `stores reset`) need the same link-safe removal.
- **2026-11-22 — `delivery pr-body` trusts `~/.roborepo/scratch` under the account's own home
  only.** `$HOME` and `ROBOREPO_STATE_ROOT` are environment variables, and the command already
  refuses to let `$TMPDIR` widen what it reads. The first version also read `$HOME`, as the denylist
  does; the validator showed a fake `$HOME` whose scratch folder links elsewhere let any file pass,
  so only the home the account database names (`os.userInfo()`) counts, and a scratch folder
  replaced by a link is ignored. An account with no database entry gets no scratch root. A state
  root moved elsewhere still has temp folders available.
- **2026-11-22 — `maintenance stores reset --dry-run` on a log reports a record count.** Log
  records have no per-record listing worth printing; file and folder sets list each entry with size
  and age. `--all --dry-run` lists every entry in the directory, since `--all` removes the whole
  target, not only what the store's filter counts.
- **2026-11-22 — Test runs name their folder by pid and sweep only runs whose pid is gone.**
  Alternative: sweep by age, which would remove a long-running concurrent run's folder. A pid the
  sandbox hides (EPERM) counts as alive.
- **2026-11-22 — `withTemporaryStorage` sweeps shells unchanged for an hour, with rmdir only.** A
  concurrent call's folder is empty until its assessment writes, so a fresh empty folder is not
  proof of a leftover; rmdir can never remove a file, so a shell that gained content is left.
- **2026-11-22 — The one-time leftover removal touched only this run's own files.** The surveyed
  leftovers (oldest 2026-10-31 to 2026-11-03) were already gone. The remaining test-named entries
  were all created that day, several by other sessions' test runs that may still be live; the
  automatic sweeps this plan adds reach those once their runs end.

## Open Questions

- **Should `roborepo scratch` run without a permission prompt?** The full gate's
  `agent-run-coverage-check` requires every `roborepo` command to be classified in
  `manifests/inventory/agent-permissions.json`, and `scratch` is not. Options:
  - Allow it, as a new allow behavior like `guarded-delivery` and `plan-store-commands`. For: the
    rule tells agents to call it routinely, and it writes only inside its own store with a
    validated name. Against: it deletes (prunes old scratch folders) without asking.
  - Ask-bucket it with `mutate-harness-config`. For: every prune is approved. Against: a prompt on
    every call in Claude, where `roborepo` runs outside the sandbox under ordinary rules, which
    works against "temporary content disappears on its own".
  - Leave it unclassified (`INTENTIONALLY_UNCLASSIFIED`), which prompts the same as ask.
  Recommendation: allow. Blocked because it changes agent permissions, which the run may not decide.
  Blocks: the CI gate (agent-run-coverage-check fails until it is classified) and submission.
- **Should the byte cap spare folders changed recently?** The cap removes the oldest folders with
  no minimum age, so when the store passes 500 MB a folder another session touched minutes ago can
  go. The command never removes the folder it prints. Options:
  - Exempt folders changed within the last hour from the byte cap. For: never deletes work in use.
    Against: a runaway writer is by definition recent, so the cap stops nothing during that hour.
  - Make the cap report-only: doctor already flags a store over its cap. For: no surprise deletes.
    Against: nothing bounds the store between age expiries.
  - Keep it as designed ("byte cap as a backstop"). For: a hard bound. Against: the risk above.
  Recommendation: exempt folders changed within the last hour. Blocked because each option has a
  real argument and the plan specified the cap without a floor. Blocks: submission only.

## Not tested

- [x] The rendered Claude sandbox lets a sandboxed shell write `~/.roborepo/scratch` while still
      refusing the rest of the home folder — Verified by agent 2026-11-22 at d6f38f1c: `node
      scripts/test/claude-sandbox-enforcement-check.mjs` (signed-in `claude -p` with freshly rendered
      settings) → passed, `scratch-write=ok`, `home-write=refused`.
- [x] The rendered Codex profile lets `roborepo scratch` create and hand out a folder, and a shell
      write into it, inside Codex's sandbox, while `~/.roborepo` elsewhere stays refused — Verified
      by agent 2026-11-22 at d6f38f1c: `codex sandbox --include-managed-config -P managed-workspace`
      (codex-cli 0.166.0) running `node scripts/cli/main.mjs scratch e2e-topic` and `sh -c` writes,
      with a fake home outside every temp root, scratch root absent and present → exit 0, path
      printed, `wrote-in-scratch`, `elsewhere-denied`.

## Review

### Findings

- [x] `delivery pr-body` accepted a scratch folder under an overridden `$HOME`, so a fake home
      whose scratch folder links elsewhere let any undenied file pass — fixed (afdf7853)
- [x] `roborepo scratch` could prune the folder it prints when the byte cap picked it first —
      fixed (afdf7853)
- [x] Comments in `scripts/cli/delivery.mjs` and its test gave the wrong reason scratch is a body
      location — fixed (afdf7853)
- [x] `plan-execute/references/handoff.md` still told agents to write the PR body in the system
      temp directory — fixed (afdf7853)
- [x] `roborepo scratch` and `stores reset scratch` followed a scratch store replaced by a link,
      handing out and pruning folders in the link's target — fixed (fac86228)
- [x] The test-run sweep chmodded the target tree of a dead run entry that is a link — fixed
      (fac86228)
- [x] `pr-body` still took its home from `USERPROFILE` on Windows and from `$HOME` in the container
      fallback — fixed (fac86228)
- [x] No test read a scratch-folder body end to end or refused a body elsewhere in `~/.roborepo/`
      — fixed (fac86228)
- [x] The new Scratch Folders section in `docs/user/reference/roborepo-cli.md` split the
      dev-checkout note from Command Output — fixed (82718950)
- [x] `docs/user/reference/architecture.md`'s store table and reset commands lacked the scratch
      store and `--dry-run` — fixed (49972bde)
- [x] `docs/internal/harness-provider-interface.md` said Codex writable paths come only from the
      plans-store adapter and that the tracked Codex config has none — fixed (49972bde)
- [x] `docs/user/reference/config-control-panel.md`'s Codex paragraph omitted the scratch folder —
      fixed (49972bde); `cli-internals.md` and `config-panel-internals.md` updated alongside
- [x] `stores reset scratch --dry-run` read through a scratch root replaced by a link and listed
      folders the real reset refuses to remove — fixed (6c327a8d)
- [ ] Byte cap can remove a folder another session is using — escalated, see Open Questions
- [ ] `roborepo scratch` is not classified in the agent permission manifest, failing
      `agent-run-coverage-check` — escalated, see Open Questions

### Verification

- Validation pass 1 at d6f38f1c (fresh-context subagent): 3 `fix`, 2 `escalate`; the `$HOME`
  finding, filed as `escalate`, was fixed as its remedy was clear.
- Validation pass 2 at afdf7853 (fresh-context subagent): 4 `fix`, 0 `escalate`.
- Validation pass 3 at fac86228 (fresh-context subagent): 1 `fix`, 0 `escalate`.
- Validation pass 4 at 82718950 (fresh-context subagent): 3 `fix` (docs), 0 `escalate`.
- Validation pass 5 at 49972bde (fresh-context subagent): 1 `fix`, 0 `escalate`.
- Full local gate (`npm run check`) at d6f38f1c: 424 passed, 3 failed. `agent-run-coverage-check`
  is the open question above. The `generated/` guard and the add-skill
  `git diff --quiet -- globals/packages/plan-suite` check failed because the run started with
  uncommitted work that was committed mid-run, not from the change.
- Base failure: `cli-surface-integration-check.mjs` fails intermittently on `main` too (1 of 5
  direct runs at 46f37fbc, "single-repo refresh should leave other cached ahead repos in the main
  list"), a PTY timing race in the remote-sync menu.

## Documentation impact

Also updated, as the implementation newly affected them: `docs/user/reference/architecture.md`,
`docs/internal/harness-provider-interface.md`, `docs/internal/cli-internals.md`,
`docs/internal/config-panel-internals.md`, and `plan-execute/references/handoff.md`.

- `docs/user/reference/roborepo-cli.md`: add `roborepo scratch`, `stores reset --dry-run`, and the
  wider `delivery pr-body` location.
- `docs/internal/testing.md`: the per-run test `TMPDIR`.
- `docs/user/reference/config-control-panel.md`: if it lists the sandbox's writable folders by the
  time this lands, add the scratch folder there.
- The rule fragment is the reader-facing doc for agents; `globals/packages/test-harness` and
  `tool-call-optimization` text changes with it.
