---
id: developer-runtime-docker-process-providers
priority: high
next_action:
blocked_by: []
depends_on:
  - developer-runtime-final
related:
  - developer-runtime-git-health-history
  - developer-runtime-metadata-suggestions
  - canonical-repository-identity-plan-v2
reviewed_commit:
---

# Runtime Docker And Process Providers

## Summary

Add Docker/Compose enrichment and current process metrics to the Runtime provider model without
changing the existing settings, quick-link, or portal mutation contracts.

## Current State

`developer-runtime-final` split the provider foundation into capability, listener, origin, probe,
identity, snapshot, and API boundaries. Docker and process metrics are visible as unsupported
provider capabilities.

## Relation to Canonical Repository Identity (v2)

Not a hard blocker, but this plan should land after `canonical-repository-identity-plan-v2` so
Docker/process observations feed the shared repository registry rather than a parallel identity
path. A container or process working directory that resolves to a Git root is another local root
of a canonical repository; multiple processes and published endpoints for one repository should
associate with one `repositoryId`. Keep the "merge Docker/listener observations by normalized host
endpoint" logic Runtime-internal — that is endpoint deduplication, not repository identity.
Include `repositoryId` (and local `rootId` where relevant) on merged provider observations.

## Goals

- Inspect running Docker containers and Compose labels read-only.
- Merge Docker and listener observations that describe the same published host endpoint.
- Collect current PID, parent PID where available, executable name, working directory, elapsed
  runtime, resident memory, and sampled CPU percentage.
- Treat Docker absence, daemon shutdown, permission failures, and exited processes as partial
  provider results with capability notes.
- Keep PID, CPU, and memory as current snapshot facts only; never persist them to settings.

## Implementation Plan

- Add `modules/developer-runtime/docker.mjs` and `modules/developer-runtime/process-metrics.mjs`.
- Extend provider aggregation so Docker/process providers run on their own cadence or on demand.
- Add fixture-driven parsers for Docker JSON/label output and process command output.
- Merge Docker/listener observations by normalized host endpoint.
- Surface provider warnings and stale results in snapshots.
- Add portal display fields only for real provider data.

## Validation

- Fixture tests cover Compose labels, Docker daemon unavailable, permission failures, duplicate
  endpoint merge, exited process, missing metrics, and redaction.
- `node --check` touched JS files.
- `npm run test:developer-runtime`.
- Manual Docker validation on macOS when Docker Desktop is available; otherwise record the limit in
  this plan before completion.

## Verification

Implemented in worktree `developer-runtime-docker-process-providers` (branch of the same name), not yet
merged/committed to `main`.

- `modules/developer-runtime/docker.mjs` and `process-metrics.mjs` added, mirroring the `lsof.mjs`/
  `listeners.mjs` subprocess-orchestrator/pure-parser split.
- Docker/process collection run inside `discoverInstances`'s existing `Promise.all`, same cadence
  as git/probe — no separate on-demand trigger.
- Docker merges onto listener instances by published host port (not PID): Docker Desktop on macOS
  proxies published ports through a host-side listener owned by Docker's own process, whose PID
  never matches the container's PID. Confirmed live (see below).
- `node --check` passed on all new/touched files.
- New fixture-driven suites `test:developer-runtime-docker` and `test:developer-runtime-process` cover Compose
  labels, daemon unavailable, permission failure, malformed/duplicate port lines, exited process,
  malformed `etime`, and batched multi-PID parsing. Both pass.
- Full regression run clean: `test:developer-runtime`, `test:developer-runtime-git`, `test:developer-runtime-health`,
  `test:developer-runtime-history` (existing `discoverInstances` callers updated to pass hermetic
  `discoverDocker`/`collectProcess` no-op stubs so they don't shell out to a real `docker`/`ps`).
- Portal: read-only Docker/Compose badge and CPU/RSS/elapsed line added to the instance card,
  rendered only when the corresponding field is non-null.
- Docs: `docs/user/reference/runtime.md` updated with a "Docker and process metrics"
  section; "Current Limits" no longer lists Docker/process as uncollected.
- **Live manual validation performed** (Docker Desktop was available after a stuck-process restart):
  ran `discoverDockerRecords` and full `discoverInstances` against a real running Compose stack
  (10-container Supabase project) plus a freshly-launched labeled `nginx:alpine` container. Real
  output matched fixture shapes exactly, including dual-stack port-binding dedup. End-to-end merge
  confirmed on the real system: the container's host-side proxy listener (different PID than the
  container) merged correctly by port, with `processMetrics` populated on the same instance.
  - **Bug found and fixed during validation**: `DOCKER_DISCOVERY_TIMEOUT_MS` was 1500ms, but a real
    `docker ps` call measured ~1.77s (Docker CLI crosses Docker Desktop's VM proxy, unlike `lsof`/
    `ps`), causing intermittent SIGTERM kills. Bumped to 4000ms; re-verified fixture and regression
    tests pass after the fix.
- Not yet done: commit/PR and merge to `main`. `next_action` is cleared because no further
  implementation work remains in this plan's scope — committing the worktree is a repo-workflow
  step, not a task tracked by this document.
