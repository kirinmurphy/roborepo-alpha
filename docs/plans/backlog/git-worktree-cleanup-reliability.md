---
id: z3j2x3x1
priority: high
next_action: Run /plan-promote to refine the performance approach and decide whether timeout-only cleanup should retry automatically.
blocked_by: []
depends_on: []
related: ["4xc0gjuw", "b2sgiejd", "git-exec-consolidation"]
reviewed_commit: 5dd8e66c5b53cab7baebd347f90837b69d39165e
worktree:
---

# Finish safe worktree cleanup reliably

## Summary

Make post-merge worktree cleanup finish reliably for ordinary repositories, and explain clearly
when preservation assessment runs out of time. Remove test residue, reduce repeated Git processes,
and preserve the distinction between a durably closed plan and its unfinished checkout cleanup.
Keep all preservation, snapshot, approval, landing, and removal safeguards.

## Context

Closing [[4xc0gjuw]] committed completion successfully, but automatic cleanup retained its worktree
after reporting a generic `git mktree -z` failure. A diagnostic retry proved preservation in about
18 seconds. With an intentionally reduced 14-second assessment budget, the same code reproduced
the exact failure text: the final Git command received a one-millisecond timeout, returned no
stderr or exit code, and assessment reported `unknown`.

That controlled reproduction establishes a timeout mechanism matching the incident. The original
run did not retain timeout metadata, so its historical cause is strongly supported rather than
conclusively established. The later canonical cleanup succeeded, verified a recovery snapshot,
and removed both checkout and branch. The predecessor remains completed.

The worktree had no Git-reported changes, but inventory found the empty directory
`generated/packages/__char_test_pkg__/claude`. The slash-command characterization test creates a
fixture below that directory and removes only its `commands` child. Empty directories count as
local content, so the residue triggered the full local-preservation comparison. Removing only
that directory from a diagnostic inventory selected the clean-content path; no real files were
deleted by that experiment.

| Current owner | Relevant behavior |
| --- | --- |
| `scripts/test/slash-commands-characterization-check.mjs` | Creates fixture output inside the repository and leaves empty parent directories |
| `modules/repositories/worktree-preservation.mjs` | Shares a 30-second assessment deadline; hashes each filesystem file with a separate Git process |
| `modules/repositories/worktree-snapshot.mjs` | Reads raw inventory, rebuilds trees, preserves empty directories, and verifies snapshots |
| `modules/repositories/git-exec.mjs` | Bounds Git execution but returns generic errors without explicit timeout classification |
| `scripts/cli/worktree-cleanup.mjs` | Retains the checkout unless preservation is proven; coordinates capture and final removal guards |
| Canonical plan-close skill | Commits completion before cleanup and supports resuming cleanup for already closed plans |

The successful diagnostic issued 1,282 file-hashing calls, 541 blob-reading calls, and 759
tree-building calls. These are measurements from this repository, not portable timing targets.
They explain why tiny disposable fixtures alone do not establish adequate assessment performance.

## Goals

- Finish preservation assessment within its existing budget on a representative repository fixture.
- Prevent characterization tests from leaving repository-local fixture content or empty parents.
- Distinguish assessment timeout, Git command failure, remaining work, and unsupported content.
- Report closure and cleanup outcomes independently, with a concrete retry action when needed.
- Preserve local content, including empty directories, through the existing verified snapshot path.

## Scope and related work

This plan extends the shared cleanup behavior delivered by [[4xc0gjuw]], which has landed and
closed. There is no unresolved implementation dependency on that plan.

[[b2sgiejd]] owns cleanup settings, hooks, and repository exceptions. Leave those controls there.
[[git-exec-consolidation]] owns migration of private Git wrappers to the shared execution seam.
This plan owns the timeout metadata and performance needed by preservation assessment; it does
not migrate unrelated callers. Coordinate any shared return-shape changes with existing consumers.

The implementation does not broaden deletion consent, disposable-directory exclusions, or archive
policy. A retry cannot substitute for fresh proof, and a timeout cannot authorize deletion.
Native Windows coverage remains owned by its existing platform plans; this work must retain the
portable Git and filesystem behavior of the shared modules.

## Proposed design

### Reduce work before adding retries

Keep preservation decisions in the shared repository modules and cleanup orchestration in its
existing coordinator. CLI, portal, and plan-close consumers must receive the same assessment.

Use a disposable test app root or fully owned fixture subtree for slash-command characterization,
and clean the whole fixture in its finalizer. Assert that pre-existing repository content survives.
Preserve meaningful empty directories in real worktrees; removing test residue is not permission
to ignore all empty directories during assessment.

Profile a representative repository fixture, then reduce process count through content-addressed
hashing, batched blob reads, reuse of unchanged tree objects, or another measured approach that
fits the existing Git seam. Select the concrete approach during promotion. Keep temporary proof
objects outside persistent repository storage, avoid filters and hooks, and retain distinct
staged and filesystem comparisons. Reused results must remain valid for the assessed state.

### Make interruption actionable

Preserve timeout and termination information at the Git execution seam. Assessment should identify
whether a command timed out within the remaining overall budget or failed for another reason.
Include the failed operation and elapsed/budget information without exposing file contents or
configuration secrets. Retain existing output fields; assess downstream compatibility before
adding structured diagnostics.

| Result | Required behavior |
| --- | --- |
| Preservation proven; guards pass | Complete the existing snapshot/removal transaction |
| Assessment budget exhausted | Keep checkout; report timeout and a scoped retry action |
| Unique work or unsupported content | Keep checkout; report the existing remaining-work or blocker details |
| Plan closed; cleanup unfinished | Report durable closure separately from retained checkout and branch |
| Cleanup succeeds on retry | Verify removal and report any recovery reference |

An already-closed retry resumes guarded cleanup using the committed completion evidence. It does
not repeat closure tests, request renewed approval, or make another completion commit solely to
retry cleanup. Update canonical workflow guidance and its generated command projections when
the selected recovery behavior changes those instructions.

### Decide a bounded timeout retry

Evaluate at most one automatic retry for a classified assessment timeout. Compare its completion
benefit with additional wait and repeated resource use after performance improvements.

| Policy | Completion benefit | Cost | User action |
| --- | --- | --- | --- |
| One automatic timeout retry | May finish after transient contention | Another bounded assessment and added wait | Intervene only if the retry fails |
| Explicit scoped retry | User chooses when to try again | Cleanup stays unfinished until rerun | Run the reported scoped command |

A retry, if selected, starts a fresh bounded assessment and repeats identity, content, base evidence,
configuration, server, and removal checks. It cannot reuse an expired positive result or retry
an explicit guard refusal as though it were transient.

## Implementation plan

- [ ] Add representative cleanup and timeout regressions, plus a characterization fixture-leak assertion.
- [ ] Isolate slash-command fixture output and remove its owned directory tree without touching pre-existing content.
- [ ] Measure assessment operation counts and elapsed time; implement and compare a bounded approach that reduces repeated Git processes.
- [ ] Preserve timeout diagnostics through the Git seam, assessment, and cleanup output; check callers of any extended result fields.
- [ ] Decide and record the timeout-only automatic retry policy; implement it only if selected, with fresh checks and a strict attempt bound.
- [ ] Update CLI/portal reporting and canonical plan-close guidance so closure and cleanup outcomes remain distinct and retries remain actionable.
- [ ] Run focused regression suites and the full local parity gate; record measured results and any platform limits.

## Validation

Use disposable real repositories and raw filesystem/index round trips. Assert outcomes and
refusals; use deterministic injected timing for deadline tests rather than machine-speed races.

| Scenario | Acceptance criterion |
| --- | --- |
| Slash-command characterization | No owned fixture files or empty parents remain; pre-existing content is unchanged |
| Repository with at least 1,282 tracked files and nested paths | Preservation succeeds within the existing budget on the measured verification host; repeated Git process count is materially lower than the baseline |
| Empty directory in an otherwise clean landed worktree | Directory survives verified snapshot restoration; cleanup succeeds without discarding it |
| Assessment expires during a Git operation | Stable timeout classification, elapsed/budget context, and retained checkout/branch |
| Git fails without a timeout | Ordinary failure remains distinguishable from budget exhaustion |
| Already closed plan with retained worktree | Scoped retry finishes cleanup without another closure commit or renewed approval |
| Files, index, base, configuration, or branch change | Existing fresh-state guards retain the target or report the protected partial outcome |
| Retry policy, if enabled | One retry maximum; fresh assessment; no retry of unique-work or safety refusals |
| CLI and portal consumers | Consistent assessment reason and separate closure/cleanup presentation where applicable |

Start with the existing focused suites, including Git seam coverage:

```sh
node scripts/test/slash-commands-characterization-check.mjs
node scripts/test/worktree-snapshot-check.mjs
node scripts/test/worktree-lifecycle-check.mjs
node scripts/test/plan-close-integration-check.mjs
node scripts/test/developer-runtime-git-check.mjs
```

Add checks for affected consumer contracts and browser behavior only where presentation changes.
Register new suites through existing orchestration rather than adding an independent runner.
Run `npm run check` before implementation handoff because the work crosses shared repository
behavior and test fixtures. Run command rendering and trigger checks if canonical skill or
command content changes. Plan creation itself needs only plan validation, documentation-reference
checks, and whitespace checks.

## Documentation impact

- `docs/user/reference/repositories.md`: assessment timeouts, retained-worktree outcomes, and retry behavior.
- `docs/user/reference/roborepo-cli.md`: cleanup diagnostics and any selected retry contract.
- `docs/user/reference/plans-portal.md` and `docs/user/guides/plan/lifecycle/plan-suite.md`: closed-plan cleanup recovery.
- `docs/internal/cli-internals.md`: measured preservation approach, deadline classification, and shared callers.
- Canonical `globals/packages/plan-suite/skills/plan-close/` guidance and generated command projections: actionable timeout recovery without repeating durable closure.

## Open questions

- After reducing assessment cost, does one automatic timeout retry justify its extra latency,
  or should cleanup provide an explicit scoped retry only? Resolve during promotion.
- Which batching or object-reuse approach gives the best measured improvement while preserving
  raw-byte, temporary-storage, and fresh-state guarantees? Resolve during promotion.
