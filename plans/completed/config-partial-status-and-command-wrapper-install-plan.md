---
id: config-partial-status-and-command-wrapper-install
priority: medium
next_action:
blocked_by: []
depends_on: []
related: [config-context-token-cost]
reviewed_commit: 0083710
---

# Config Partial Status and Command-Wrapper Install Gap

## Resolution

Both problems resolved (commit `0083710`).

**Problem 1 (command-wrapper probe) — no code change needed.** Investigation found the probe path
(`~/.<harness>/commands/<name>.md`, `package-probes.mjs:206`) and the live-install path
(`installPackageCommands` → `liveDir: "commands"`, `slash-commands.mjs`) already agree, using
identical `${name}.md` naming (`commandTarget`). The `loadConfigSource` popup path reads the
`generated/packages/<pkg>/<harness>/commands/<name>.md` repo *source* — a deliberately different
path serving display, not the live-install status check. The original "every skill-command package
reports partial" symptom was a **stale install**: the packages were enabled before their wrappers
were rendered/installed, and a later `roborepo update` populated `~/.claude/commands` and
`~/.codex/commands`. Live-verified all five (`case-study-pack`, `frontend-design`, `plan-docs`,
`tighten`, `wrap-up`) now report `enabled` with the wrappers present in both harness dirs. No probe
path bug remained.

**Problem 2 (telemetry status) — fixed.** A desired service with a present state file reading
`enabled:false` (capture administratively off) now folds to component state `inactive` and package
status `configured` instead of `missing`/`partial`. A *missing* state file still reports
`partial` (never set up). Portal badges are class-mapped so `configured` reads calm (`badge-info`)
rather than sharing the `partial` warning styling (`badge-warn`). The telemetry `roborepo serve`
hint now also shows in the `configured` state. Covered by a new `test-roborepo.sh` assertion
(302 passed, 0 failed) and documented in `config-control-panel.md`.

## Follow-up (not blocking)

`probeSkill` still folds a *genuinely* missing command wrapper (skill cache present, wrapper gone)
to `blocked`→`partial` with a detail message but offers no self-heal or actionable hint. Low
priority — only reachable if an enable runs before render, which `roborepo update` repairs. Left as
a possible future hardening.

## Summary

The Config page's package status computation (`scripts/cli/package-probes.mjs`) reports
`partial` for every skill-backed-command package on at least one real machine, and reports
`missing`/`partial` for the `telemetry` service package in a way that gives the user no
actionable next step. Both need a real fix, not a UI workaround. Discovered while building
token-cost estimation (`config-context-token-cost` plan); out of scope for that feature, so
logged here.

## Problem 1: skill command-wrapper check reads a location that isn't populated

`probeSkill()` (`package-probes.mjs:193-224`) treats a skill-backed package as `blocked` (which
folds into package status `partial`, `package-probes.mjs:242-248`) whenever any of its
slash-command wrappers are missing from:

```
~/.claude/commands/<name>.md
~/.codex/commands/<name>.md
```

(`skillCommandNamesByHarness` + the check at `package-probes.mjs:206`.)

On a real machine with `case-study-pack`, `frontend-design`, `plan-docs`, `tighten`, and
`wrap-up` all enabled, every one of them reports `blocked` → `partial`, because
`~/.claude/commands/` contains exactly one file total across all packages. Verified live:

```
case-study-pack: skill case-study — cache managed, "command wrapper(s) missing"
frontend-design: skill frontend-design — same
plan-docs: skill plan-docs — same
tighten: skill tighten — same
wrap-up: skill wrap-up — same
```

This needs investigation before deciding the fix:

- Is `~/.claude/commands/<name>.md` the correct live-install target for skill-backed slash
  commands, and the *install path* (`installPackageCommands` / `slash-commands.mjs`) isn't
  writing there? If so, fix the installer.
- Or does roborepo intentionally NOT install skill-backed command wrappers to that harness
  location (e.g. skill-backed commands are invoked differently, or wrappers only live in
  `generated/packages/<pkg>/<harness>/commands/` and get pointed to by the harness through
  another mechanism)? If so, `probeSkill`'s check is stale/wrong and should stop gating
  package status on that path.

Related, already fixed as part of `config-context-token-cost`: the Config source-inspect popup
(`loadConfigSource`, `kind: "command"` / `"command-skill"` in `scripts/cli/config.mjs`) was
reading command source from `globals/<harness>/commands/<id>.md`, a path that doesn't exist in
the repo tree at all — real wrapper content lives at
`generated/packages/<packageId>/<harness>/commands/<name>.md`
(`SLASH_COMMAND_HARNESSES.genDir`, `scripts/cli/skill-command-config.mjs:16,21`). That fix
resolved the popup crash but did NOT touch `probeSkill`'s separate live-install check, which is
a different path serving a different purpose (status computation vs. source display). Both
should be reconciled against the same understanding of where wrappers are supposed to live.

## Problem 2: telemetry package status gives no actionable signal

`telemetry` desired=true but its `service` component reads `observed: false` because
`~/.roborepo/telemetry/state.json` has `"enabled": false` — the telemetry *service* is
administratively off, independent of whether the package is "installed." Live-verified:

```json
{ "enabled": false, "updatedAt": "..." }
```

This produces a `missing`/`partial`-flavored status for a package that is arguably working as
configured (user hasn't started `roborepo serve` / enabled telemetry capture). The Config item
already has a `hint: "roborepo serve"` for telemetry (`config.mjs`, `packagePresentationItem`)
which is the right idea, but the status badge itself doesn't distinguish "not yet started" from
"broken."

## What NOT to do

Do not silently reinterpret `partial`/`missing` in the portal as if they mean something
different than what `package-probes.mjs` computes — that hides real signal for other packages
that may have genuinely broken installs. The fix belongs in the probe logic, or in giving the
UI a clearer state (e.g. distinguish "administratively disabled" from "broken install") — not
a display-only patch.

## Suggested approach

1. Audit `installPackageCommands` (`slash-commands.mjs`) and confirm what live-install path it
   actually writes skill-backed command wrappers to, across both harnesses, on a fresh enable.
2. Reconcile `probeSkill`'s wrapper check in `package-probes.mjs` against that real path.
3. If wrappers are genuinely supposed to be at `~/.claude/commands/` /
   `~/.codex/commands/` and aren't landing there, fix the installer (this is the more likely
   bug — command wrapper generation targets `generated/packages/...` per
   `skill-command-config.mjs`, and something in the enable/install pipeline may not be copying
   from there into the harness's live commands directory).
4. For telemetry (and any other `service`-type component), consider a distinct status value
   (e.g. `configured` vs `partial`) so "package is fully installed, service just isn't running"
   doesn't read the same as "installation is broken."
5. Re-verify Config portal status badges across a machine with Claude only, Codex only, and
   both, plus a machine with telemetry both on and off.

## Acceptance criteria

- No correctly-installed skill-backed-command package reports `partial` due to a wrapper-path
  mismatch that was never a real problem.
- `telemetry` disabled-but-installed reads as a distinct, actionable status rather than
  `partial`/`missing`.
- `probeSkill`'s command-wrapper check and `loadConfigSource`'s command-source path agree on
  where wrappers actually live.
