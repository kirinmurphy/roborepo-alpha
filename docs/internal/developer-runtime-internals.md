# Runtime Internals

How Runtime is built, for people changing it. User-facing behavior is in
[Runtime](../user/reference/runtime.md).

## Modules

Discovery is split across provider boundaries:

- `capabilities.mjs` reports aggregate platform support plus per-provider states.
- `listeners.mjs` owns macOS listener and working-directory collection.
- `origin.mjs` owns loopback-compatible origin candidates and hostname preference ordering.
- `http-probe.mjs` is the public HTTP probe boundary; `probe.mjs` remains the bounded probe
  implementation.
- `discovery.mjs` coordinates provider records, identity, aliases, probing, and browser-safe
  instance shaping.
- `instance-shape.mjs` owns the instance record's structure and the association-key derivation.
- `git.mjs` and `git-refs.mjs` collect Git context; `health.mjs` and `health-policy.mjs` normalize
  probe results into health states; `history.mjs` and `history-diff.mjs` derive and persist
  transition events.
- `docker.mjs` collects running-container/Compose data; `process-metrics.mjs` collects live
  CPU/memory/elapsed for discovered PIDs. See [Docker and process metrics](../user/reference/runtime.md#docker-and-process-metrics).
- `stop.mjs` is the one module that acts on processes: it sends `SIGTERM` to the listeners whose
  working directory's Git top level is a given checkout. `roborepo plans stop-servers` (and so
  `/plan-close`) is its only caller; the portal never stops anything.

## Git Collection

Six Git subcommands may run, all read-only and none touching the network:

```text
git status       --porcelain=v1 --untracked-files=normal -z
git rev-list     --left-right --count <upstream>...HEAD
git symbolic-ref --quiet refs/remotes/origin/HEAD
git rev-parse    --verify --quiet <candidate-base>
git merge-base   HEAD <base>
git log          -1 --format=%ct <rev>
```

The last four support base-branch drift: resolving which branch is the base (`origin/HEAD`, else
`main`/`master`), finding where the current branch left it, and reading commit timestamps so drift
can be reported in elapsed time rather than only in commit counts.

`modules/repositories/git-exec.mjs` enforces that with an allow-list, so adding a network subcommand
has to be a deliberate edit rather than an accident. Every invocation is hardened:

- `--no-optional-locks` and `GIT_OPTIONAL_LOCKS=0` stop `git status` from refreshing and rewriting
  `.git/index`. Without them a background scan would race your own `git add`/`git commit` for
  `index.lock`.
- `core.hooksPath=/dev/null` guarantees no repository-local hook executes, since discovery walks
  arbitrary repositories on the machine.
- `core.fsmonitor=false` avoids spawning or attaching to a filesystem-monitor daemon.
- `GIT_TERMINAL_PROMPT=0`, empty askpass variables, and a closed stdin ensure nothing can block
  waiting for credentials.
- A timeout and `maxBuffer` are always set, so a slow or hung repository degrades one field rather
  than stalling the scan.

Git results are cached per scan, keyed by repository root realpath
(`modules/repositories/scan-cache.mjs`), so N apps running out of one repository cost one collection.
The cache is created per `discoverInstances` call and discarded when it returns; a process-lifetime
cache would pin the first reading a long-lived portal ever took.

## Docker And Process Gating

Both providers are gated on the same darwin-only `coreState` as the rest of discovery in
`capabilities.mjs` — `ps`/`docker` are subprocess calls that assume the same platform boundary as
`lsof`.

## Health Classification

`classifyHealth` is pure: it takes the previous health record and returns the next one, so the
failure count travels with the snapshot rather than living in module state. The record carries
`state`, `reason`, `consecutiveFailures`, `since` (when the current state began), `firstSeenAt`, and
`lastProbeAt`. Defaults live in `modules/developer-runtime/health-policy.mjs`.

## Settings Modules

`modules/developer-runtime/settings.mjs` keeps the public persistence API (`loadSettings`,
`updateSettings`, `writeSettings`) and mutation orchestration. Strict V2 validation, route
normalization, identity alias checks, and field normalizers live in
`modules/developer-runtime/settings-schema.mjs` so migrations and mutations share one schema boundary.

## API

Read-only:

- `GET /api/developer-runtime` returns the cached/current snapshot.
- `GET /api/developer-runtime/history?key=<opaque-key>` accepts only a key emitted by the current
  snapshot and returns that app's recorded events, newest first, capped at 200.
- `GET /api/developer-runtime/metadata?key=<opaque-key>` accepts only a key emitted by the current
  snapshot and returns discovered same-origin route suggestions for that app. See
  [Metadata suggestions](../user/reference/runtime.md#metadata-suggestions).

Mutating routes are POST-only and inherit the portal's loopback origin check and mutation-token
check:

- `POST /api/developer-runtime/refresh`
- `POST /api/developer-runtime/links`
- `POST /api/developer-runtime/association`
- `POST /api/developer-runtime/project`
- `POST /api/developer-runtime/alias`
- `POST /api/developer-runtime/repository-visibility` — hides or restores a whole repository. Unlike the
  routes above it writes the repository registry, not Runtime's settings, so it carries no
  settings revision: visibility is one boolean per record with no cross-field invariant to protect.
- `POST /api/developer-runtime/repository-pinned` — pins or unpins a whole repository in the repository
  registry so its order is stable across running and idle snapshots.

Revision conflicts return `409` with the current snapshot.

Metadata suggestions: `discoverMetadataSuggestions` also accepts an explicit `openApiUrl` override
for a nonstandard path, but nothing in settings/CLI/UI currently supplies one — only the
conventional-path guessing runs in production today.

## Opaque Keys

History reads resolve in two steps, and the order matters. The opaque key is first matched against
the *current* snapshot; an unrecognized key returns `404`. Only then is the resolved instance's
`associationKey` used to filter events. Because the opaque key is minted by the server from the
snapshot it just produced, a browser can never hand the server a key for an app it cannot already
see — that is the enumeration guard on this tokenless `GET` route.

The opaque key includes the origin, so it changes when an app's port changes. A page holding a stale
key receives `404` and reloads rather than erroring.

## Verification Status

- **HTTPS self-signed and authenticated-page metadata discovery is fixture-tested only.** It has not
  been exercised against a real app serving those conditions.
- **The Suggested routes dialog and add-as-quick-link prefill flow have not been visually verified in
  a browser.** Discovery itself was verified against a real local app over a real socket; the portal
  UI built on top of it (`portal/developer-runtime/suggestions-view.js`, the card action menu entry) has
  only been reviewed by reading the code and checking `node --check`.
