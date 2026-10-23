---
id: git-exec-consolidation
priority: low
next_action: Inventory the three private wrappers and capture diff subprocess, then migrate exact read-only operations to the shared bounded Git seam.
blocked_by: []
depends_on: []
related: ["developer-runtime-git-health-history"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Git Exec Consolidation

## Summary

Migrate duplicated Git execution, including three private `git()` wrappers and capture's direct diff call, onto the shared `defaultRunGitSync` seam
introduced by `developer-runtime-git-health-history`.

## Current State

`modules/repositories/git-exec.mjs` owns Git subprocess execution for Runtime, with a read-only
subcommand allow-list, hook and lock hardening, an explicit timeout, and `maxBuffer`. It ships both
`defaultRunGit` (async) and `defaultRunGitSync` (sync), the latter existing specifically so these
call sites can migrate without restructuring.

Three private wrappers remain, each missing the shared execution bounds; capture also has a separate direct Git diff call:

- `modules/plan-suite/index.mjs` — `gitInfo` / `gitFileInfo`
- `scripts/cli/telemetry-capture.mjs` — `repoMetadata`
- `scripts/cli/telemetry-markers.mjs` — `resolveGitIdentity`
- `scripts/cli/telemetry-capture.mjs` — direct `gitDiffFingerprint` subprocess outside its private wrapper

All three use `spawnSync` with **no timeout and no `maxBuffer`**. A hung or pathologically verbose
`git` blocks the calling process indefinitely. None applies the seam's hook configuration hardening. Determine which invoked read-only Git operations can actually execute hooks before describing a hook-execution vulnerability. None passes
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
- Delete the three private helpers and migrate the separate diff-fingerprint call after allowing its exact read-only argument shape.
- Confirm the telemetry capture path stays fast — it runs on a hook, so the added argument list must
  not measurably slow it.

## Validation

- `node scripts/test/plan-suite-check.mjs`, `npm run test:telemetry`, `node scripts/test/telemetry-marker-cli-check.mjs`.
- `node --check` touched files.
- `npm run check`.
- Confirm a repository with a hostile `core.hooksPath` executes nothing during a Plans scan.
