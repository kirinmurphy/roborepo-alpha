# Runtime Container Support

Runtime discovers what is running on a developer's machine and presents it as a set of
repository cards. Containers complicate that in a way host processes do not: a container's host-side
process is never its real process, and the thing a reader wants to act on — a stack, a service, an
app — is rarely one container.

This document states how each kind of container is recognized, where it is placed on the page, and
which signals are trusted to decide that. It describes current behavior; proposed changes live in
`docs/plans/`.

## Definition List

| Term | Definition |
| --- | --- |
| **listener** | A process holding a TCP port, found by `lsof`. The unit discovery starts from. |
| **container** | One running Docker container, from `docker ps`. |
| **Compose project** | A set of containers sharing a `com.docker.compose.project` label. One `docker compose up`/`down` unit. |
| **service** | One container's role inside a Compose project, from `com.docker.compose.service`. |
| **instance** | A listener joined to whatever enrichment resolved for it — probe result, git, container, process metrics. |
| **repository** | A git repository, identified by `repositoryId` — portable (`git:`) when a remote exists, opaque (`local:`) otherwise. |
| **checkout** | One working directory of a repository: the main clone or a linked `git worktree`. Identified by `rootId`. |
| **member** | One instance rendered inside a repository card. |

## Why containers need their own policy

Three properties of Docker on macOS break assumptions that hold for host processes.

**The host PID is not the container's process.** Docker Desktop runs containers inside a Linux VM
and fronts every published port with `com.docker.backend`. The PID `lsof` reports is that shared
proxy, so process-derived identity, ancestry, and CPU/memory readings are all meaningless for a
container. Published host port is the only reliable correlation between a container and a listener
(`indexDockerContainersByHostPort` in `modules/developer-runtime/discovery.mjs`).

**A container's identity does not come from the filesystem.** For a host process, the working
directory resolves the project. A container has no host-side cwd worth reading, so identity comes
from Compose labels or from bind-mount paths instead.

**The actionable unit is the stack, not the container.** `docker compose down` stops every container
in a project at once. Rendering eleven Supabase containers as eleven top-level entries would list
eleven things where the reader has one decision.

## Container categories

Every container falls into exactly one of these, decided in `buildDeveloperRuntimeSnapshot`
(`modules/developer-runtime/snapshot.mjs`) by the presence of a `composeProject` label.

| Category | Recognized by | Rendered as | Identity source |
| --- | --- | --- | --- |
| Compose-labeled | `com.docker.compose.project` label | One sub-card per project, containers as rows | Compose labels, then bind mounts |
| Standalone | Container with no Compose label | An ordinary instance card, like a host process | Host-process identity, if any |
| Unattributable | Either kind, no repository resolved | "Unrecognized listeners" | None |

### Compose-labeled containers

Grouped by project name before any other classification runs. The grouping is deliberately first:
a Postgres or Traefik container usually has unusable host-process identity, and grouping by label
lands it under its real project rather than in "Unrecognized listeners".

Within a project, containers are the unit of a row — not published ports. One container publishing
three host ports (a proxy on 80/443/8080) is one operational thing, so its ports render as nested
rows beneath it rather than as three separate containers.

### Standalone containers

A container started with plain `docker run` carries no Compose label and gets no special grouping.
It is joined to a listener by published port and then follows the same path as a host process. In
practice its identity is often weak for the reasons above, so it frequently lands in "Unrecognized
listeners" unless a bind mount or an explicit association resolves it.

### Aggregation of readings

Because one PID serves every port a container publishes, metrics are read once per container rather
than once per port. Project-level CPU sums `cpuPercentOfHost`, never `cpuPercent`: `docker stats`
reports percent of a single core, so summing that across eleven containers produced figures like
161% that described neither a share of the machine nor of a core.

## Repository resolution

A Compose project is attached to a repository through three tiers, in order, in
`collectGitForComposeProjects` (`modules/developer-runtime/discovery.mjs`). The first tier that resolves
wins, and the tier used is recorded on the card as provenance.

| Tier | Source | `resolvedFrom` | Why it can fail |
| --- | --- | --- | --- |
| 1 | `settings.composeProjects[name].repoPath` | `manual` | Only set if the user set it |
| 2 | `com.docker.compose.project.working_dir` label | `auto` | Absent when the stack was not started by `docker compose` — the Supabase CLI is the motivating case |
| 3 | Container bind-mount host paths, via `docker inspect` | `auto-bind` | Named-volume-only stacks have no host path to resolve |

Tier 3 runs only for projects the first two could not resolve — repository resolution keeps its
precedence, and a `working_dir` that resolves still wins outright for *this* question.

Mounts are nonetheless collected for every Compose project, because the separate placement pass
below needs them for all stacks (see "Placement on the card"). One batched `docker inspect` covers
every Compose container on a scan. An earlier design inspected mounts only when repository
resolution had failed; that guard was about cost, and placement correctness outranks it.

### The agreement guard

Tier 3 resolves each container's bind mounts to a repository and accepts the result **only if every
container agrees on one repository**. Containers resolving to different repositories means at least
one mount points somewhere unrelated, and there is no basis for choosing between them.

This is the same correct-or-absent discipline the rest of the card follows: a stack with ambiguous
evidence gets no repository rather than a guessed one, and the manual override stays available.

## Placement on the card

Repository resolution answers *which repository*. A second question — *which checkout* — decides
where inside the card a stack renders.

**Bind mounts decide placement, and only bind mounts.** A bind mount is a hard dependency on one
checkout's files: the stack cannot run without them. A named volume is persisted state that says
nothing about which checkout is in play, so it is ignored here (`bindSources` drops it).

`working_dir` is deliberately not consulted for this question. It still resolves *which repository*
(tier 2 above), but it records where `docker compose up` was typed rather than what the containers
depend on, so it must never decide *which checkout*. Deciding by launch directory is what made a
shared database render under whichever checkout happened to start it first — and a `docker compose
down` from that row stops the database every other checkout is using.

`classifyComposeOwnership` (`modules/developer-runtime/discovery.mjs`) resolves a stack's bind mounts
against every known checkout of its repository and returns one of three verdicts:

| Bind mounts resolve to | Ownership | Evidence `kind` | Placement |
| --- | --- | --- | --- |
| Exactly one checkout | `owned` | `bind-mount` | That checkout's section |
| Two or more checkouts | `shared` | `conflict` | Repository level, peer of the checkouts |
| Bind mounts exist, none in any known checkout | `shared` | `repo-root` | Repository level |
| No bind mounts at all | `unverified` | `none` | Repository level, marked inferred |

A manual `settings.composeProjects[name].repoPath` outranks all of it (`kind: "manual"`).

Two properties worth preserving:

- **`rootId` is set only for `owned`.** A consumer that ignores the ownership fields degrades to
  "shared stacks have no checkout" rather than to a wrong checkout.
- **`shared` and `unverified` are not the same claim.** `shared` is a positive finding that the
  stack is not checkout-specific; `unverified` is an absence of evidence. They render in the same
  place, and the card distinguishes them.

Mounts that land in *no* checkout do not weaken an otherwise-single match. Real stacks routinely bind
`/var/run/docker.sock`, `/etc/localtime`, or a log directory; requiring every mount to sit inside the
checkout classified ordinary single-checkout stacks as `shared`. The test is that exactly one
checkout's files are depended on and no second checkout competes.

Because placement needs mounts for *every* stack — including ones whose repository came from
`working_dir` — `collectMounts` now runs for all Compose projects rather than only those repository
resolution could not handle. That is one batched `docker inspect` per scan with Compose projects.

The Shared services region and member counts are described in the
[Runtime reference](../user/reference/runtime.md). The implementation history is in
`docs/plans/completed/developer-runtime-workspace-model.md`.

## Trust and safety properties

These hold for every container path and are worth preserving in any change.

| Property | Enforced by |
| --- | --- |
| Read-only: nothing starts, stops, or mutates a container | The only Docker commands invoked anywhere are `docker ps`, `docker stats --no-stream`, and `docker inspect` |
| One call per scan, not per container | `discoverDockerRecords`, `collectDockerStats`, and `collectDockerMounts` each batch into a single call |
| A slow or absent Docker degrades to no containers, never a failed scan | Timeouts return empty; callers treat absence as absence |
| macOS only | Every Docker module returns empty when `platform !== "darwin"` |
| Bind sources are real host paths, never Docker Desktop's VM view | `bindSources` strips the `/host_mnt` prefix in `docker-mounts.mjs` |

### The `/host_mnt` prefix

Docker Desktop on macOS runs containers inside a Linux VM and reports bind sources through its
gateway: a container mounting `/Users/me/app` is reported by `docker inspect` as
`/host_mnt/Users/me/app`.

Every consumer of these paths compares them against real host paths — checkout roots, project
identity — so the prefix is stripped once, in `docker-mounts.mjs`, rather than at each call site.

This matters more than it looks. Forgetting it fails **silently** rather than loudly: a mount that
cannot match any checkout is indistinguishable from a stack that legitimately has no checkout-specific
dependency, so every stack on macOS classifies as `shared` and the page looks plausible while being
uniformly wrong. Any new code reading a mount source should take it from `collectDockerMounts`
rather than parsing `docker inspect` output directly.

Docker CLI calls cross into Docker Desktop's VM proxy and are measurably slower than `lsof`/`ps`,
which is why `DOCKER_DISCOVERY_TIMEOUT_MS` is 15s against a measured 2.1–4.0s cold call. A generous
ceiling costs one waiting call per scan; a tight one drops every container intermittently.

## Adding support for a new container kind

When a new runtime or orchestration tool needs recognizing, answer these in order. Each maps to a
concrete seam.

1. **What labels or metadata identify it?** Extend `parseDockerPsEntry` in
   `modules/developer-runtime/docker.mjs`, which is where `docker ps` labels become fields.
2. **What is its actionable unit** — the container, or a group? If a group, it needs grouping in
   `buildDeveloperRuntimeSnapshot` alongside `composeProject`.
3. **What resolves it to a repository?** Add a tier to `collectGitForComposeProjects`, ordered by
   confidence, and give it a `resolvedFrom` value so the card can state its provenance.
4. **What happens when the evidence is ambiguous?** The answer must be "render nothing rather than
   guess" — match the tier-3 agreement guard.
5. **Does it change per checkout, or is it repository-wide?** This decides placement, and is the
   question the ownership plan above exists to answer properly.
