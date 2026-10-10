# Runtime

Runtime is the `/runtime` page in the local RoboRepo portal. It discovers active local HTTP
apps, associates them with a stable project/app identity, and stores machine-local quick links such
as `/admin` or `/resume`.

Settings is the durable place to change the repository auto-discovery consent used by Runtime.
That one switch controls both active-process observation and automatic enrollment of the
repositories those apps use; explicit repository or folder sources remain available separately.

## Commands

```sh
roborepo runtime
roborepo runtime --json
roborepo runtime --open
```

- Default output prints a compact project/app/origin/status table.
- `--json` prints the same browser-safe snapshot used by the portal.
- `--open` starts or reuses the portal and opens `/runtime`.

## Discovery

Runtime observes processes only while **auto-discovery** is on, and it is off until you turn it on.
While it is off, the page leads with **Enable auto-discovery of active repos**, no process or
container is observed, and nothing new is registered. Repositories already known — for example from
a folder added under **Manage repositories** — still appear with their checkouts and Git state, read
from disk. Turning auto-discovery on starts the first scan immediately; turning it off stops the
scans and removes the evidence they recorded. See [Repository sources](repositories.md#repository-sources)
and [Manage repositories](repositories.md#manage-repositories).

Automatic discovery currently supports macOS. Other platforms return an explicit capability state
so the page can say discovery is unsupported instead of implying that no apps are running.

On macOS, RoboRepo:

- collects TCP listeners with `lsof` field output
- resolves each PID's working directory with `lsof -a -p <pid> -d cwd`
- walks to the nearest Git boundary
- normalizes SSH/HTTPS Git remotes into `git:<host>/<owner>/<repo>`
- falls back to `path:<realpath>` or low-confidence `process:<cwd>:<command>`
- probes only loopback-compatible origins and excludes non-HTTP listeners from the default snapshot

HTTP probes are bounded to 8 active instance probes at a time. Each instance still tries its
compatible host candidates in order so hostname preference remains deterministic while large local
listener sets cannot stall the portal.

The portal process is represented as built-in identity `builtin:portal` and is never probed
recursively.

A listener's "shape" is its page title plus its working directory within the project. How many
shapes a project has decides where its listeners appear:

| Project has | Result |
| --- | --- |
| One shape, even across several listeners | Moves to Active apps automatically (at high or medium identity confidence). Extra listeners are treated as redundant processes serving the same app, and the card names their ports. |
| Two or more shapes (different titles) | Stays in Unrecognized listeners until you associate it, because there is no reliable way to pick "the" app. |

Runtime can also suggest routes from an app's manifest, sitemap, robots, and OpenAPI files
without saving them as quick links. See [Metadata suggestions](#metadata-suggestions).

## Git context

Each discovered app's repository root reports its branch, commit, dirty state, and ahead/behind
position. Collection is deliberately split by what can be read correctly:

- **Filesystem reads** supply branch, detached HEAD, commit sha, and the configured upstream. These
  parse `.git/HEAD`, loose refs, `packed-refs`, and the config file directly, so they work even when
  the `git` binary is missing. A linked worktree reads its own HEAD and refs while sharing
  `packed-refs` and config through `commondir`, which is why a worktree reports its own branch but
  the same canonical repository as its primary clone. A linked worktree also reports its Git
  administrative name — the `<name>` in `.git/worktrees/<name>` — which is what a plan's `worktree`
  field matches on Home. A main checkout reports none.
- **A subprocess** supplies dirty state, ahead/behind, and base-branch drift. These need work no
  filesystem read can do correctly: dirty state requires parsing the binary index and
  stat-comparing the worktree against it, and the commit-graph questions require walking loose
  objects and packfiles.

Every Git read is local and read-only: RoboRepo never runs repository hooks, never takes the
`.git/index` lock, never waits for credentials, and times out rather than stalling the scan.

RoboRepo never fetches, so the portal shows a Git figure only when it can back it up:

| Value | Shown as | Why |
| --- | --- | --- |
| Ahead/behind and base drift | A `+` suffix ("at least this much") when your last fetch is older than the drift shown | They reflect remote-tracking refs as of your last fetch (`.git/FETCH_HEAD`) |
| `dirty`, `ahead`, `behind` | Nothing, when the `git` subprocess could not answer | These are `null`, never `false` or `0`, so a failed check never reads as "clean" |
| `baseBranch`, `baseBehind`, `baseMergeBaseAt` | No drift badge, when the base branch can't be resolved, the branch has no upstream, or you are on the base branch | A figure measured against a guessed base would be worse than none |

## Docker and process metrics

Docker/Compose enrichment and live process metrics run on macOS as part of the same scan that
collects listeners and Git context: one `docker ps` call and one batched `ps` call per refresh.

**Docker**: RoboRepo runs `docker ps --format '{{json .}}'`, one
call for the whole scan rather than one per container. Each line is parsed independently, so a
single malformed line is skipped rather than invalidating the scan. Compose project/service come
from the `com.docker.compose.project` / `com.docker.compose.service` labels Compose already attaches
to every container it creates. A container is matched to a discovered instance by its
published host port. That is the only reliable link: Docker Desktop on macOS runs containers inside
a Linux VM, so container PIDs never match host-side `lsof` PIDs. A container with no published ports, or whose port matches no
discovered listener, never appears. Docker not installed, the daemon not running, and permission
failures are all reported as a scan warning with zero containers — never a thrown error.

**Process metrics**: RoboRepo runs `ps
-o pid=,ppid=,pcpu=,rss=,etime=,comm= -p <pid1>,<pid2>,...`, one call for every PID discovered in the
scan rather than one call per PID. A PID that exits between listener discovery and this `ps` call is
simply absent from the result — never backfilled with a stale or fabricated reading. `cpuPercent`,
`residentMemoryKb`, and `elapsedSeconds` are current-snapshot facts only; like Git's `dirty` field,
they are never persisted to settings.

## Health states

Every probed instance is normalized into one of six states:

| State | Meaning |
| --- | --- |
| `healthy` | Reachable and the status is accepted |
| `degraded` | Reachable but wrong: an untrusted certificate, or a status the app's configuration rejects |
| `unhealthy` | Sustained failure — the failure count reached the threshold |
| `starting` | Not yet reachable, but still inside the grace window after first sight |
| `unknown` | Not probed, or answering in a way we have no expectation for |
| `inactive` | No listener |

Two rules keep the dashboard from raising false alarms:

**An unconfigured 4xx is `unknown`, not a fault.** Many listeners on a dev machine are gRPC
endpoints, IPC servers, or daemons that legitimately answer 403 or 404 to a browser `GET`. Flagging
those as degraded would fill the page with alarms about software working correctly. Once an app
declares `acceptedStatuses`, a mismatch *is* meaningful and is treated as a failure. Without that
configuration, 2xx and 3xx count as healthy — a redirect to a login page is the common localhost
case.

**A single failure is not a verdict.** Failures must repeat `FAILURE_THRESHOLD` times (default 2)
before a state reaches `unhealthy`, so an app alternating pass/fail never gets there. A connection
failure within `STARTING_GRACE_MS` (default 30s) of first sight reads as `starting`, covering the
window where a dev server has bound its port but is still compiling.

The failure threshold and grace window are global defaults, not per-app settings.

## History

Transition events are appended to a single machine-local file:

```text
<stateRoot>/developer-runtime/history.jsonl
```

Events are written only when something changes, never once per scan, so volume stays small. Six
event types are recorded: `firstSeen`, `originChange`, `healthTransition`, `exposureChange`,
`duplicateChange`, and `inactive`.

Each event carries the app's `associationKey` plus `repositoryId` and `rootId`, which join it to the
shared repository registry. `associationKey` is port-free and PID-free, so an app that restarts on a
different port keeps its history and produces an `originChange` rather than looking like a new app.
No absolute path is ever written — `rootId` is the opaque stand-in for on-disk location.

The store is bounded three ways:

- **Retention** drops events older than `preferences.historyRetentionDays` (default 14).
- **A size cap** trims the oldest events if the file still exceeds 2 MB, so a pathologically flapping
  app cannot grow it without limit.
- **Compaction is atomic** — a sibling temp file is renamed into place, never rewritten in place.

Reads tolerate a truncated final line: an event that was only partially flushed fails to parse and
is skipped until its newline lands. The same tolerance covers hand-editing damage and unknown event
types.

History writes are best-effort. A full disk or unwritable state directory can never break discovery.

## Settings

Settings are machine-local:

```text
<stateRoot>/developer-runtime/settings.json
```

They use a strict versioned schema with optimistic `revision` checks. V1 settings migrate in place
to schema version 2 on first load, after writing `settings.v1.backup.json` beside the settings
file. Migration is idempotent: a version 2 file is validated without making another backup.

Writes are atomic: RoboRepo writes a sibling temporary file and renames it into place. Quick links
belong to `<project identity>#<app id>` and store only route paths, never a port or origin.

Version 2 adds:

- `aliases`: explicit project identity redirects, such as a path identity that has been confirmed
  to be the same project as a Git remote identity. Alias mutations require confirmation, reject
  self-aliases, and validate the full alias graph for cycles.
- project and app `favorite` / `hidden` flags for reversible local curation.
- app `health` path/status configuration and explainable `match` hints.
- `preferences`: currently `showNonHttp` and `historyRetentionDays`.

One alias case is applied automatically: a repository whose Git remote was renamed. Two
records sharing a `rootId` is direct evidence the same directory was seen under both remotes (a
`rootId` is a hash of an absolute path), and the most-recently-seen root separates a rename from a
deleted-and-recloned directory. That case is aliased on sight rather than prompted, because an alias
leaves both records intact and is undone by removing one entry. Merging records — which would
rewrite checkout ownership — is still never done automatically.

## Curating Apps

From the portal you can:

- The app dialog can edit project/app names, project/app favorite and hidden flags, hostname
  preference, health path/status policy, and match hints.
- The action menu can favorite an app or **Hide from Runtime** without deleting saved links. Hiding
  from Runtime only affects this page.
- A repository's menu offers **Ignore repository**, which hides the repository everywhere (Home,
  Plans, and Runtime's normal list), and **Hide from Runtime**, which hides only its running apps
  and Compose stacks here.
- The settings dialog lists hidden items, manual associations, and aliases so local decisions can
  be restored or removed. It also lists hidden *repositories* separately: those are whole
  repositories you ignored or the 30-day ageing sweep retired from the list, which live in the
  repository registry rather than in Runtime's settings, and each row restores one.
- Removing an association deletes only the association entry. Saved project/app settings and quick
  links remain in settings.
- Alias creation requires an explicit confirmation checkbox and uses the cycle-safe server-side
  alias mutation.

## Metadata suggestions

Runtime inspects an app's own same-origin conventions and
suggests candidate routes as suggestions — never as automatic quick links. A suggestion only becomes
a saved link when the user opens it from an app's Links panel. A checkout row's Links panel belongs
to the app that row links to; a Compose container's panel lists discovered routes only, since
Compose containers have no saved links yet.

Sources inspected, each same-origin and loopback-only:

- **`/manifest.json`** — `start_url`, labeled with `name`/`short_name` when present. Only the
  conventional path is checked; a page that links its manifest via `<link rel=manifest>` at a
  non-conventional path is not currently discovered.
- **`/robots.txt`** — `Sitemap:` declarations, each fetched and parsed for `<loc>` entries.
- **`/sitemap.xml`** — checked directly as a fallback even when `robots.txt` declares none.
- **An OpenAPI/Swagger document, in JSON** — every key under the document's `paths` object. There
  is no single conventional path, so common framework paths are tried in order: `/openapi.json`,
  `/swagger.json`, `/v3/api-docs`, `/v2/api-docs`, `/api-docs`. The first response that parses as a
  valid document (has a `paths` object) wins. Only JSON bodies are parsed; a YAML-only document is
  not discovered. A 200 response that isn't a real document — e.g. a dev server's catch-all route
  serving its HTML shell for any path — is skipped, not treated as a hit.


Every discovered path is validated like a hand-typed quick link: loopback host, no credentials, no
protocol-relative URLs. When sources overlap, a path keeps the highest-confidence label, in this
order: OpenAPI, sitemap, manifest, robots.

Paths that look authenticated or administrative (`/admin`, `/login`, `/dashboard`, `/account`, and
similar) are dropped unless an OpenAPI document or sitemap lists them explicitly. Those sources are
the app declaring its own routes, so they override the heuristic.

Discovery never throws: a source that is absent, unreachable, or malformed simply contributes no
suggestions, so one broken source never blocks suggestions from the others.

## Security

- **Probe targets come only from local listeners**, never from a URL the browser supplies.
- **Probes stay local:** no cookies or credentials, no redirects away from loopback, and capped body
  size and time. Titles and favicons are treated as untrusted display data.
- **[Metadata suggestions](#metadata-suggestions) use the same fetch guard**, so every limit above
  applies to them too.
- **Exposed listeners are flagged:** listeners bound to wildcard or non-loopback interfaces stay
  visible with a warning.
- **Git reads are local and read-only** and never contact a remote — see [Git context](#git-context).
- **Unsupported platforms** keep your saved settings and say that automatic discovery is unavailable;
  that notice links back to this document.

## Current Limits

Aliases are confirmed by hand in the portal. Runtime does not yet suggest that a
`path:<realpath>` project and a Git remote identity are the same project.

See [Docker and process metrics](#docker-and-process-metrics) for what Docker/Compose and process
collection cover today, including the host-port merge limitation on Docker Desktop for macOS.

- **Metadata suggestions only check the conventional `/manifest.json` path**, not an HTML page's
  `<link rel=manifest>` tag at a non-conventional location. See [Metadata
  suggestions](#metadata-suggestions).
- **OpenAPI-document discovery relies on guessing a conventional path**, since no single convention
  covers every framework the way `/manifest.json`/`/sitemap.xml` do. An app serving its document at a
  genuinely nonstandard path is not discovered.

Known limits in the Git, health, and history behavior described above:

- **`health.path` is stored but not probed.** The setting validates and persists, but probes still
  hit the origin root.
- **History is unreachable for stopped apps.** Events remain on disk, but the portal can only open
  history for apps that are currently running.
- **Grace window and failure threshold are global defaults**, not per-app settings.
- **`dirty`, `ahead`, and `behind` are `null` when `git` is unavailable** or a repository is too slow
  to answer within the timeout. Branch and commit still resolve from the filesystem.
- **Git polls on every refresh** while the portal is open. Reads are lock-free and run once per
  repository root, but this is recurring subprocess activity.
