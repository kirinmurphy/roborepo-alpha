---
id: developer-runtime-compose-project-grouping
priority: high
next_action: Review for completion — the grouping and the project-card rollup have both landed (composeProjectCard renders standalone and as a repository-card sub-group; covered by developer-runtime-repository-merge-check). Confirm the Validation bullets, then move to completed with a Verification section.
blocked_by: []
depends_on:
  - developer-runtime-docker-process-providers
related:
  - developer-runtime-metadata-suggestions
  - developer-runtime-git-health-history
  - canonical-repository-identity-plan-v2
reviewed_commit:
---

# Runtime Compose-Project Grouping

## Summary

Group Runtime instances that belong to the same Docker Compose project under one project
card, instead of one card per listener/port. A Compose stack (app, db, nginx, mailhog, etc.) is
one logical project with several supporting containers, not several unrelated projects.

## Current State

`developer-runtime-docker-process-providers` added Docker/Compose enrichment
(`modules/developer-runtime/docker.mjs`) that merges container data onto a listener by matching
published host port, and process-metrics (CPU/RSS/elapsed) per PID. Each enriched listener still
renders as its own independent card, keyed by `instance.associationKey`
(`modules/developer-runtime/instance-shape.mjs`), with no relationship surfaced between sibling
containers in the same Compose project.

Two related gaps found during manual smoke testing surfaced the need for this plan:

- Non-HTTP containers (e.g. Postgres on a published host port) were previously dropped entirely
  by `discoverInstances`'s HTTP-probe-required filter (`modules/developer-runtime/discovery.mjs`).
  Fixed ahead of this plan: a listener with matched Docker container data now survives even
  without a successful HTTP probe, since the container observation is independent confirmation
  the listener is a real service (see `discovery.mjs`, the `!probe && !docker` skip condition).
- Docker-enriched cards with no resolvable project identity (`cwd` lookup fails for
  `com.docker.backend`, the actual host-side listening process on macOS) land in the collapsed
  "Unrecognized listeners" section alongside real noise (ControlCenter, Dropbox), making them easy
  to miss even though `docker.mjs` already captures `composeProject`/`composeService` per
  container.

## Goals

- Instances sharing a `docker.composeProject` value are presented as one project entry, showing
  "N associated ports/instances" rather than N separate top-level cards.
- A non-HTTP container (Postgres, etc.) that belongs to a Compose project with at least one
  HTTP-probed sibling is shown as an associated instance under that project, not filtered out and
  not required to pass its own HTTP probe.
- A Compose project with no git/HTTP-resolvable identity of its own still groups by
  `composeProject`, independent of the existing repo-identity/`associationKey` logic.
- Existing non-Docker instances (plain HTTP dev servers with no container) are unaffected —
  current one-card-per-listener behavior stays for anything without `instance.docker`.
- Grouped project cards remain linkable/aliasable to a repo the same way a single instance is
  today, so "attach this Compose project to my repo" stays one action.

## Non-Goals

- No change to non-Docker listener discovery or grouping.
- No attempt to group by anything other than `composeProject` (e.g. no shared-network inference,
  no heuristic grouping for containers without Compose labels).
- No UI for editing/renaming a Compose project's display name in this pass.

## Implementation Plan

- `modules/developer-runtime/discovery.mjs`: after building `instances`, compute a
  `composeProject -> instance[]` index from `instance.docker.composeProject` and attach it to the
  snapshot (or a sibling structure) rather than folding it into `associationKey`, so existing
  identity/dedup logic is untouched.
- `modules/developer-runtime/instance-shape.mjs`: no change to `associationKey` itself; add whatever
  minimal shape is needed for the portal to look up an instance's Compose siblings.
- `portal/developer-runtime/app.js`: new render path — instances with a shared `composeProject` render
  as one project card (reuse or extend `tpl-card`) with a rollup of associated ports/instances,
  instead of each appearing independently in "Running now" or "Unrecognized listeners".
- `portal/developer-runtime/templates.js`: add a rollup detail renderer (associated instance list: name,
  port, health) inside the project card, likely reusing the tooltip/detail pattern already used
  for git/docker/process-metrics badges.
- Confirm interaction with the existing "Unrecognized listeners" bucket: a grouped project with at
  least one Compose-labeled container should never render into that collapsed section, since group
  membership itself is the resolvable identity.

## Validation

- Fixture tests: multiple containers sharing one `composeProject` merge into one project entry;
  a Compose project with only non-HTTP containers still renders (using the discovery fix already
  landed); a container with no Compose labels keeps today's single-card behavior; mixed
  HTTP+non-HTTP siblings in one project all appear as associated instances.
- `node --check` touched JS files.
- `npm run test:developer-runtime`, `npm run test:developer-runtime-docker`.
- Manual validation against a real multi-container Compose stack (app + db + supporting services)
  to confirm the rollup count and associated-instance list match `docker ps` for that project.

## Landed: Per-Container Metrics via `docker stats`

Docker CPU/RSS were fundamentally wrong on macOS. `modules/developer-runtime/process-metrics.mjs` runs
host-side `ps` against the PID that owns the listening socket, but every Docker-proxied container
port on macOS is fronted by the single shared `com.docker.backend` VM-proxy process — so every
container across every Compose project reported identical, meaningless CPU/RSS/uptime. Confirmed
directly: two unrelated Compose projects showed the same PID and CPU%.

Fixed by `modules/developer-runtime/docker-stats.mjs`: one
`docker stats --no-stream --format '{{json .}}'` call per scan (same "N things, one call"
discipline as `docker ps`), parsed into a `containerId -> {cpuPercent, residentMemoryKb}` map.
`discovery.mjs` runs it in the existing concurrent provider batch and prefers it for any instance
carrying a Docker match, falling back to the `ps` reading only for native (non-Docker) listeners.

Chosen over the Docker API/socket route deliberately: every other Docker touchpoint in this module
goes through the CLI, and a socket transport would add a second way of talking to Docker for no
benefit the current feature set needs. Revisit only if live-streaming stats are wanted, which the
API supports naturally and repeated CLI calls do not.

Uptime is not carried by `docker stats`, so `elapsedSeconds` is null for Docker instances rather
than reusing the host-proxy `ps` value, which would silently reintroduce the same bug. Both portal
call sites already guard `!= null`, so the segment is simply omitted. Sourcing real container
uptime from `docker ps`'s `Status` field remains unbuilt.

## Landed: One Card Shape for Docker and Non-Docker Projects

`tpl-card` and `tpl-compose-project-card` were structurally unrelated — the Compose card laid its
title, meta, git badge, and action menu out as one flat flex row inside `<summary>`, with no
`card-head`/`card-title` split and its own `h3` inheriting a larger size. Git context therefore
rendered in a visibly different place and weight on the two card kinds even though the underlying
data shapes had already converged.

Both templates now emit the same persistent skeleton:

```
.card-head
  .card-main            column one
    .card-title         h3 + type-specific trailing content
    .card-git-row       shared git row (empty => display:none)
  .action-menu          column two
```

Only the title row's trailing content differs by kind — a URL for a plain listener, the
`N containers · N ports · N% CPU` rollup plus the expand chevron for a Compose project — which is
the intended axis of variation. The git row markup itself was extracted to a single `tpl-git-row`
template that `applyGitBadge` clones into whichever card asked for it, so the two copies that had
already drifted cannot drift again. The Compose card's `<summary>` is now layout-neutral
(`display: block`) and exists only as the click target; `.card-head` inside it owns the layout.

## Landed: Fixed Icon Size Scale

There was no icon-size system: `<portal-icon>` defaulted to 15px and call sites passed arbitrary
`width`/`height`, while page CSS shrank icons further with bare `svg { width }` rules — the git
repo-link and copy-branch icons were forced to 10px, small enough to be unreadable.

`portal/shared/icon.js` now exposes a fixed scale (`sm` 14 / `md` 16 / `lg` 20 / `xl` 24) selected
via `size="…"`, with `md` the default; the `width`/`height` attribute escape hatch is gone and all
19 existing call sites across developer-runtime/plans/config/widget-templates were migrated onto steps.
`base.css` mirrors the same numbers as `--icon-sm|md|lg|xl` for elements sized by CSS rather than
by the component (`.info-icon` is a text button, not an svg), and the sub-scale overrides in
developer-runtime and plans now reference those tokens. `sm` is the floor — nothing should size an icon
below it.

## Follow-up: Resource Threshold Alerting

Not scoped into this plan's implementation — captured here during manual smoke testing as a
distinct next feature, to be scoped and possibly branched separately. Unblocked now that the
per-container CPU/RSS numbers above are real rather than a shared VM-proxy artifact.

Every quantifiable per-port/per-container stat currently surfaced is purely informational, with no
threshold classification: health state, latency, CPU%, RSS, elapsed uptime. None of these get
flagged when they indicate a real capacity/performance problem.

Proposed shape:

- Define qualifiers per metric: within acceptable levels / approaching overload (warn) / overload
  (alert), plus spike detection (a sudden jump relative to recent samples, not just an absolute
  threshold crossing) since a spike can matter even under a static threshold.
- Surface the qualifier visually on the specific item that crossed it — orange for approaching
  overload, red for overload — at whatever level the metric lives (port-level for latency/health,
  container-level for CPU/RSS/uptime, matching the project/container/port split this plan
  established).
- Add a warning panel at the top of the Runtime page (parallel to the existing
  `renderWarnings`/`#warnings` mechanism in `portal/developer-runtime/app.js`) that aggregates and
  highlights every item currently in warn or alert state, so a problem doesn't require expanding
  every card to notice.
- Needs a decision on where thresholds come from: fixed defaults, per-project override via
  `settings.composeProjects[name]` (same settings surface this plan added), or both.
- Spike detection needs a short rolling history of samples per metric — process-metrics collection
  is currently a single point-in-time snapshot per scan (`modules/developer-runtime/process-metrics.mjs`),
  so this would need its own small ring-buffer/history mechanism, separate from the existing
  instance-history feature (`modules/developer-runtime/history-diff.mjs`), which tracks discrete
  transition events, not continuous numeric series.

## Follow-up: Detect Stale Git Remote (repo renamed upstream)

Not scoped into this plan's implementation — surfaced during manual smoke testing when this
repo's own `origin` remote was found still pointing at `github.com/kirinmurphy/harness_configs`
(the project's old name) after the GitHub repo itself had been renamed to `roborepo`. Git never
auto-syncs a local remote URL on a GitHub-side rename; GitHub keeps the old URL working via
redirect, so `fetch`/`push` silently kept succeeding through the redirect and the mismatch went
unnoticed. In Runtime specifically, this caused the same running server/repo to resolve to two
different identities depending on when discovery ran, appearing as a separate "harness_configs"
entry that would show up and disappear.

Proposed shape:

- A check (candidate home: `roborepo doctor`, or a small standalone utility reusable from there)
  that compares a repo's configured remote URL against GitHub's canonical current name for that
  same repo, and flags a mismatch.
- Two viable detection methods, either sufficient alone: (1) HTTP redirect check —
  `curl -sI https://github.com/<org>/<name>` and read the `Location` header when GitHub 301/302s
  to the renamed path; (2) GitHub API — `gh repo view <org>/<name> --json nameWithOwner` (or the
  REST `/repos/{owner}/{repo}` equivalent) and compare its `nameWithOwner`/`full_name` against the
  locally configured remote.
- Natural fit for the canonical-repository-registry work already planned in
  `docs/plans/backlog/portal-homepage-repository-section.md` — `repositoryId`/`urlKey` resolution
  is exactly the layer that should catch and normalize a renamed remote, rather than building a
  parallel one-off check inside Runtime.
- Not scoped or prioritized yet — revisit when picking up either `roborepo doctor` work or the
  repository-registry plan.

## Verification

Confirmed against the code at completion, not against checkbox state — this plan uses prose
bullets and has none.

- **Grouping landed.** Containers sharing a `composeProject` label merge into one project entry
  in `modules/developer-runtime/snapshot.mjs`, which groups Compose-labeled instances before the
  identity pass so a container with low-confidence process identity still lands under its real
  project instead of "Unrecognized listeners".
- **The project-card rollup landed.** `composeProjectCard` renders in both required positions:
  standalone as a top-level card (`portal/developer-runtime/app.js:139`) and as a sub-group inside a
  repository card (`portal/developer-runtime/templates.js:358`). A Compose stack stays one named
  sub-group rather than flattening its containers into the member list.
- **One row per container, not per published port** — `groupByContainer` in `snapshot.mjs`, so a
  proxy publishing several host ports reads as one operational unit.
- **Covered by tests.** `scripts/test/developer-runtime-repository-merge-check.mjs` exercises the
  Compose sub-group path directly. Full suite: 389 passed, 0 failed.

Not verified: none of this has been looked at in a browser. The evidence above is structural —
code paths and tests, not rendered output. See the branch-level note on unverified UI work.
