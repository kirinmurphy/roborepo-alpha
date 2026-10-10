---
id: git-exec-consolidation
priority: low
next_action: Migrate the three private git() helpers onto defaultRunGitSync from modules/repositories/git-exec.mjs
blocked_by: []
depends_on:
  - developer-runtime-git-health-history
related: []
reviewed_commit:
---

# Git Exec Consolidation

## Summary

Migrate three duplicated, unhardened `git()` helpers onto the shared `defaultRunGitSync` seam
introduced by `developer-runtime-git-health-history`.

## Current State

`modules/repositories/git-exec.mjs` owns Git subprocess execution for Runtime, with a read-only
subcommand allow-list, hook and lock hardening, an explicit timeout, and `maxBuffer`. It ships both
`defaultRunGit` (async) and `defaultRunGitSync` (sync), the latter existing specifically so these
call sites can migrate without restructuring.

Three private copies predate it, each byte-similar and each missing protections:

- `modules/plan-suite/index.mjs` — `gitInfo` / `gitFileInfo`
- `scripts/cli/telemetry-capture.mjs` — `repoMetadata`
- `scripts/cli/telemetry-markers.mjs` — `resolveGitIdentity`

All three use `spawnSync` with **no timeout and no `maxBuffer`**. A hung or pathologically verbose
`git` blocks the calling process indefinitely. None disables hooks, so a repository-local
`core.hooksPath` could execute code during a Plans scan or a telemetry capture. None passes
`--no-optional-locks`, so `git status`-style calls can contend for `index.lock` with the user's own
commands.

## Why This Was Deferred

The duplicates are synchronous and sit on synchronous call paths. Consolidating them during the
Runtime work would have mixed an unrelated regression surface (Plans scanning, telemetry
capture) into that plan's diff. `defaultRunGitSync` was shipped ready so this becomes mechanical.

## Goals

- Every Git subprocess in the repository runs through one hardened seam.
- No call site can invoke a network or hook-invoking subcommand.
- Every invocation has a timeout and a buffer bound.

## Implementation Plan

- Extend `GIT_READONLY_COMMANDS` to cover the subcommands these callers need: `rev-parse`,
  `branch`, `log`, `merge-base`, `remote`. Note that `remote get-url` reads local config and does
  not touch the network, unlike `remote update`; either match on the full argument pair or keep
  `remote` out and read the URL from config as `modules/repositories/identity.mjs` already does.
- Replace each private `git()` with `defaultRunGitSync`, mapping the existing return shapes
  (`{ ok, stdout }` and bare-string variants) onto `{ ok, stdout, code, error }`.
- Delete the three private helpers.
- Confirm the telemetry capture path stays fast — it runs on a hook, so the added argument list must
  not measurably slow it.

## Validation

- `npm run test:plans`, `npm run test:telemetry`, `npm run test:telemetry-marker-cli`.
- `node --check` touched files.
- `bash scripts/test/test-roborepo.sh --quiet`.
- Confirm a repository with a hostile `core.hooksPath` executes nothing during a Plans scan.
