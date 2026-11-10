---
id: developer-runtime-v1
priority: high
next_action:
blocked_by: []
depends_on: []
related:
  - developer-runtime-final
reviewed_commit:
---

# Runtime: First Iteration Implementation Plan

## Summary

Add a **Runtime** page to RoboRepo's existing loopback portal. It automatically discovers active HTTP applications on macOS, associates each application with a stable local project identity, and lets the user save project-specific jump links such as `/resume` or `/admin`.

The first iteration intentionally does not require configuration inside project repositories. Runtime discovery supplies the current port; machine-local RoboRepo settings supply curated names and routes. When an app restarts on another port, saved routes follow it because they are attached to the project identity rather than the port.

## Review Status

Reviewed after implementation work and macOS validation on 2026-07-20. The plan is **complete**.

Implemented and verified:

- [x] Core macOS discovery pipeline with injectable `lsof` and HTTP probe fixtures.
- [x] Stable project identity resolution for Git remotes, Git worktrees, path identities, and low-confidence process identities.
- [x] Versioned machine-local settings with atomic writes and optimistic revision checks.
- [x] Strict link path normalization that rejects credentials, protocol-relative URLs, non-loopback hosts, and malformed paths.
- [x] Snapshot grouping for active identified projects, unmatched instances, and inactive saved projects.
- [x] Portal route module, `/runtime` page registration, CLI command, docs, and smoke tests.
- [x] `npm run test:developer-runtime` and `npm test` passed.
- [x] Link management supports individual edit/update/remove/reorder through the existing ordered links mutation.
- [x] Project friendly-name editing is separate from app naming and association changes.
- [x] Unsupported discovery notice links to the Runtime docs served by the portal.
- [x] Path-to-Git alias migration is deliberately deferred to the final V2 alias workflow, where confirmation and cycle-safe storage exist.
- [x] Stale/refreshing/failed UI paths retain the last successful snapshot; failed-refresh retention has fixture coverage.
- [x] Active discovery uses documented bounded probe concurrency.
- [x] HTTP/TLS/redirect/body/network fixture coverage was expanded for TLS trust-error classification, oversized bodies, same-origin redirects, external redirects, and network-exposure warning rendering.
- [x] Saved Git-backed project/app associations now use stable project, relative working directory, and command evidence by default, so title changes during a restart do not strand saved links on the old port. Duplicate same-signature listeners are still title-disambiguated to avoid arbitrary attachment.
- [x] Restart regression coverage proves a saved Git-backed app returns active on a new port and quick links rebuild against the new origin while a sibling same-repository app remains unmatched until associated.

Completion evidence:

- 2026-07-20 macOS manual validation was rerun with isolated `ROBOREPO_STATE_ROOT`, temp Git-backed Node apps, and the real portal API.
- Passed: multiple real Node apps were discovered, project friendly-name mutation worked, app name/origin mutation worked, link add/edit/delete/reorder worked through `/api/developer-runtime/links`, a wildcard-bound app produced `bind.scope: "wildcard"` with `bind.warning: "Listener is exposed beyond loopback."`, `/docs/user/reference/runtime.md` was served by the portal, and cached refresh state remained `idle`/`refreshing` on ordinary polling.
- Passed: after stopping and restarting a saved Git-backed app on a new port, explicit `/api/developer-runtime/refresh` returned the project as active and rebuilt the saved `resume` quick link against the new origin.
- Not exercised manually: the unsupported-platform docs link, because the unsupported notice is browser-rendered and no unsupported-platform fixture was active in the macOS portal run.
- Verified: `npm run test:developer-runtime`, `npm test`, and `git diff --check` passed.

No open V1 acceptance items remain.

## Goals

- Show active localhost web applications without requiring the user to remember their ports.
- Associate a process with a Git repository or project directory when possible.
- Preserve useful route shortcuts independently of changing ports.
- Add `/runtime` using the same portal structure, security contract, and browser patterns as Config, Plans, and Telemetry.
- Keep the implementation dependency-free and loopback-only.
- Make uncertainty visible instead of silently assigning an instance to the wrong project.
- Establish the project/app/instance model in V1 so the final iteration extends the schema instead of replacing it.

## Non-goals

- Discover every route in an application.
- Crawl application pages or parse framework route manifests.
- Add configuration files to managed project repositories.
- Start, stop, or restart project processes.
- Store long-term CPU, memory, or availability history.
- Implement Linux or Windows discovery in this iteration. Unsupported platforms must return an explicit capability state and user-facing explanation rather than an empty dashboard or generic failure.
- Treat non-HTTP listeners such as databases as project web applications.

## Current RoboRepo Structure

The portal has no framework, bundler, or build step. `roborepo serve` starts the Node standard-library HTTP server in `scripts/cli/portal-server.mjs`, bound to `127.0.0.1`. Page metadata comes from the exported `PAGES` array. The server injects that manifest and a per-process mutation token into every page.

Shared browser behavior lives under `portal/shared/`:

- `base.css` provides the palette, typography, header, navigation, footer, loading state, and light/dark themes.
- `theme.js` builds navigation from the injected page manifest and marks the active page.
- `api.js` provides GET, protected POST, clipboard, template, timestamp, and loading helpers.

Domain behavior is kept out of `portal-server.mjs`. The server receives functions through its `handlers` object and dispatches each API namespace through a small `handle<Domain>Api` function. The Plans implementation is the closest model: domain logic under `modules/` and `scripts/cli/`, a thin API namespace in the server, and page-specific HTML/CSS/JS under `portal/plans/`.

## User Experience

Add a navigation item named **Runtime** at `/runtime`.

The page contains:

1. A compact status row showing the number of active HTTP apps, identified projects, and unmatched instances.
2. A search field and a manual Refresh button.
3. Project groups containing one or more active instances.
4. An **Other instances** group for HTTP listeners that cannot be associated confidently.
5. An **Inactive saved projects** group for known projects whose app is not currently running.

The page must distinguish **loading**, **refreshing**, **stale**, **empty**, **partially supported**, **unsupported**, and **failed** states. Refreshing preserves existing cards with a small progress indicator. A failed refresh retains the last successful snapshot and says when it was generated.

On Windows or another unsupported platform, replace the normal empty state with a capability notice:

```text
Automatic localhost discovery is not yet supported on Windows.
Saved projects and links remain available, but RoboRepo cannot currently detect their active ports.
```

The notice should identify the detected platform, link to the Runtime documentation, and avoid suggesting that no applications are running. The API should remain functional so saved configuration can still be viewed and edited. If a future platform adapter provides partial results, the notice should say **Limited discovery** and enumerate unavailable capabilities.

An identified instance card should display:

- Friendly project name, falling back to repository or directory name.
- Current clickable origin, such as `http://127.0.0.1:5173`.
- HTTP status and probe latency.
- Process name and PID.
- Repository-relative identity explanation, such as `Git remote` or `project directory`.
- A warning when the listener is bound beyond loopback.
- Saved route buttons.
- **Add link**, **Edit links**, **Copy URL**, and **Open** actions.

Open actions use a new browser tab and preserve keyboard focus. Status cannot be communicated by color alone: cards require text labels and accessible names, dialogs require focus trapping and Escape-to-close behavior, and link management must be usable with the keyboard.

Adding a link accepts a label and either a path or a loopback URL. A full URL is normalized to its pathname, query, and hash before storage. Reject credentials, protocol-relative URLs, control characters, and non-loopback hosts. The port and origin are never saved as part of a route shortcut.

When one project exposes multiple HTTP listeners, do not attach links to an arbitrary listener. Ask which app an instance represents, such as **Web**, **API**, or **Storybook**, and save the association without its PID or port. A project with one listener may receive a provisional `web` app, but the UI must expose **Rename app** and **Change association**.

## Data Model

Persist machine-local settings at:

```text
path.join(stateRoot, "developer-runtime", "settings.json")
```

Use a versioned schema:

```json
{
  "version": 1,
  "revision": 1,
  "projects": {
    "git:github.com/kirinmurphy/visa_planner": {
      "name": "Visa Planner",
      "apps": {
        "web": {
          "name": "Web",
          "originPreference": "localhost",
          "links": [
            { "id": "admin", "label": "Admin", "path": "/admin" }
          ]
        }
      }
    }
  },
  "associations": {}
}
```

Rules:

- Write atomically through a temporary sibling file followed by rename.
- Require the browser's last-seen `revision` on mutation and return `409` with the current snapshot when another tab changed settings first.
- Reject malformed JSON, unsupported versions, duplicate link IDs, non-local absolute URLs, and paths not beginning with `/`.
- Preserve unknown top-level fields only if RoboRepo already has a general convention for forward-compatible settings; otherwise validate strictly.
- Do not place this data in the RoboRepo checkout or in project repositories.

Model three identities from the beginning:

- **Project identity**: stable repository or project boundary.
- **App ID**: user-meaningful role within a project, such as `web`, `api`, or `storybook`.
- **Active instance**: current PID/container and origin, which may change on every launch.

Quick links belong to `<project identity>#<app id>`, never directly to a PID or port. Manual associations store a bounded match signature such as project identity, relative working directory, safe executable name, and optional page title. Port and PID may be current evidence but are never durable matching fields.

## Stable Identity Resolution

Identity resolution is ordered and evidence-based:

1. Resolve the listening PID's current working directory.
2. Walk upward to the nearest `.git` boundary.
3. If a Git remote exists, normalize it into `git:<host>/<owner>/<repo>`.
4. Otherwise use `path:<realpath-of-project-root>`.
5. When no repository boundary exists, use `process:<realpath-cwd>:<command-name>` as a low-confidence runtime identity.

Normalize Git remotes consistently:

- Support SSH and HTTPS forms.
- Remove credentials, query strings, fragments, trailing slashes, and `.git`.
- Lowercase the hostname while preserving repository path casing unless existing RoboRepo conventions require otherwise.
- Never execute repository-controlled hooks or commands.
- Support `.git` directories and `.git` files used by Git worktrees.

If a path-only identity later gains a Git remote, or a project moves, retain an alias from the old identity after the user confirms the match. Do not silently duplicate saved links under a second project card.

Return `identity`, `identityKind`, `confidence`, and `evidence` separately. The UI must show low-confidence results as unmatched until the user explicitly associates them.

## Discovery Pipeline

Create `modules/developer-runtime/index.mjs` as the pure/domain boundary. Keep child-process execution injectable so tests can use fixtures.

Before invoking any platform command, resolve a capability descriptor:

```json
{
  "platform": "win32",
  "discovery": "unsupported",
  "available": [],
  "unavailable": ["listeners", "processWorkingDirectory", "automaticProjectMatching"],
  "message": "Automatic localhost discovery is not yet supported on Windows."
}
```

Use `process.platform` values (`darwin`, `linux`, `win32`) internally and map them to readable labels in the browser. Only the `darwin` adapter should execute in V1. Do not attempt to run `lsof` on Windows and translate its failure into an empty result.

### Listener collection

On macOS, call `lsof` with machine-readable field output rather than parsing aligned columns. Collect TCP listeners with PID, command, address, and port. Deduplicate multiple file descriptors belonging to the same PID/address/port.

Requirements:

- Include IPv4 and IPv6 loopback listeners.
- Record listeners bound to wildcard or LAN interfaces, preserve the actual bind host, and separately compute safe loopback origin candidates. Do not blindly rewrite every listener to `127.0.0.1`.
- Exclude port `0`, invalid records, and the same endpoint repeated by dual-stack reporting.
- Bound command duration and return partial warnings when discovery tools fail.

### Process and project enrichment

For each unique PID:

- Resolve its working directory using `lsof -a -p <pid> -d cwd` machine-readable output.
- Resolve the nearest project root and stable identity.
- Record only bounded, display-safe command information; do not expose complete environment variables or command lines that may contain secrets.

### HTTP probing

Probe every candidate locally with strict controls:

- Try HTTP first; support HTTPS only when clearly detected or HTTP fails with a TLS-shaped error.
- Use a short connection timeout and total timeout.
- Limit concurrency.
- Request at most a bounded response body sufficient to read the HTML title and favicon link.
- Do not follow redirects away from loopback.
- Treat any valid HTTP response, including `401`, `403`, and `404`, as an HTTP application instance.
- Exclude listeners that do not speak HTTP from the default snapshot.
- Send no cookies, authorization headers, or project credentials.

Probe `localhost`, `127.0.0.1`, and `::1` only when each is compatible with the listener. Preserve the successful hostname as the current origin. Browser cookies, allowed origins, and development TLS certificates may distinguish `localhost` from `127.0.0.1`. A saved `originPreference` may select hostname or protocol, but never a durable port.

For self-signed HTTPS, report `tls-untrusted` separately from unreachable. Do not disable certificate verification globally. The Open action may still use the HTTPS origin so the browser can present its normal certificate flow.

Return status code, latency, protocol, title, and favicon URL when safely available. Never fetch favicon URLs outside the discovered loopback origin.

## Server and CLI Integration

Add `scripts/cli/developer-runtime.mjs` to bridge state paths, discovery, settings, and portal-facing snapshots. It should export functions matching the handler style used by Plans:

- `loadDeveloperRuntimeSnapshot()`
- `refreshDeveloperRuntimeSnapshot()`
- `updateDeveloperRuntimeSettings(input)`

Maintain an in-process snapshot manager with a short freshness window. Discovery and HTTP probing must be asynchronous and must never block the Node HTTP server. `GET /api/developer-runtime` returns the current snapshot immediately and may schedule a background refresh. The explicit refresh endpoint awaits or reports one shared in-flight refresh; concurrent callers must not start duplicate scans.

This matters for RoboRepo's own listener: a synchronous probe back into the same portal process can deadlock. Represent the running portal as a built-in instance using its known PID and bound port rather than probing recursively. Give it stable identity `roborepo:portal` and built-in links for Config, Runtime, Plans, and Telemetry.

Add a read-only CLI view backed by the same snapshot formatter:

```text
roborepo runtime
roborepo runtime --json
roborepo runtime --open
```

The default prints a compact project/app/origin/status table, `--json` prints the browser-safe snapshot, and `--open` starts or reuses the portal and opens `/runtime`. Register the command in `manifests/platform/cli-commands.json` and dispatch it from `scripts/cli/main.mjs` without duplicating discovery logic.

Wire these functions into the `handlers` object passed by the existing `serveCommand()` implementation. Keep `portal-server.mjs` free of discovery and filesystem logic.

## Add the Portal Page in the Existing Structure

Follow `docs/user/reference/portal.md` exactly:

1. Add `{ path: "/runtime", id: "developer-runtime", title: "Runtime", dir: "developer-runtime" }` to `PAGES` in `scripts/cli/portal-server.mjs`.
2. Do not manually edit navigation. `portal/shared/theme.js` will render the new page from the injected manifest.
3. Create:

```text
portal/developer-runtime/index.html
portal/developer-runtime/styles.css
portal/developer-runtime/app.js
portal/developer-runtime/api.js
portal/developer-runtime/state.js
portal/developer-runtime/templates.js
```

4. In `index.html`, use `{{HEAD}}`, page-local `<template>` elements, `/portal/shared/theme.js`, and `/portal/developer-runtime/app.js` as an ES module. Do not duplicate the header or footer.
5. In `api.js`, wrap shared `portalGetJson()` and `portalPostJson()` rather than using raw `fetch`.
6. Keep filtering, grouping, URL construction, and sorting pure in `state.js`.
7. Keep dynamic markup in HTML templates and `templates.js`; use `portalTpl()` and `portalEl()` rather than string-built HTML in `app.js`.
8. Let `app.js` own DOM references, events, polling, snapshot application, and `portalHideLoading()` after the first request settles.
9. Reuse variables and common chrome from `portal/shared/base.css`; keep only Runtime-specific layout in `styles.css`.

Add `handleDeveloperRuntimeApi(req, res, urlPath, qs, handlers)` to the flat dispatch chain in `portal-server.mjs`.

Endpoints:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/developer-runtime` | GET | Return the cached/current portal snapshot |
| `/api/developer-runtime/refresh` | POST | Force listener discovery and probing |
| `/api/developer-runtime/links` | POST | Add, update, remove, or reorder one app's quick links |
| `/api/developer-runtime/association` | POST | Create, change, or remove an instance-to-app association |
| `/api/developer-runtime/project` | POST | Rename a project/app or change origin preference |

All mutations remain POST-only and automatically inherit RoboRepo's existing origin and per-server token checks. Browser code must use `portalPostJson()`.

## Snapshot Contract

Return a browser-safe structure:

```json
{
  "generatedAt": "2026-07-18T18:00:00.000Z",
  "refresh": { "state": "idle", "startedAt": null, "error": null },
  "settingsRevision": 1,
  "capabilities": {
    "platform": "darwin",
    "platformLabel": "macOS",
    "discovery": "supported",
    "available": ["listeners", "httpProbe", "projectIdentity"],
    "unavailable": [],
    "message": null
  },
  "warnings": [],
  "projects": [],
  "unmatchedInstances": [],
  "inactiveProjects": []
}
```

Each instance should have an opaque server-issued key, current origin plus alternate loopback origins, bind scope, status, latency, title, process summary, resolved project identity, app association, confidence, and evidence summary. Avoid accepting arbitrary PIDs, paths, or origins back from the browser. Mutations address server-issued keys, stable project/app identities, existing link IDs, and the caller's settings revision.

## Sorting and Refresh Behavior

- Sort active identified projects first by saved name, then inferred name.
- Sort instances within a project by saved app name, then port.
- Keep unmatched instances separate.
- Poll the cached snapshot every 10 seconds, consistent with Config.
- Pause browser polling while the tab is hidden and refresh immediately when it becomes visible again.
- Run expensive rediscovery only after the cache expires or the user presses Refresh.
- Preserve the last successful snapshot if a later scan fails, while displaying the new warning and timestamp.
- Use a stable snapshot hash so unchanged polls update the timestamp without rebuilding every card.

## Security and Privacy

- Keep the portal bound to `127.0.0.1`.
- Probe only addresses derived from local listeners.
- Never accept a browser-supplied target URL for server-side probing.
- Never follow redirects to non-loopback destinations.
- Bound subprocess duration, probe concurrency, body size, and response time.
- Avoid returning environment variables, full commands, credentials in Git remotes, or arbitrary file contents.
- Warn when an instance binds to `0.0.0.0`, `::`, or a non-loopback interface.
- Escape all discovered labels and titles by assigning `textContent` or using safe DOM helpers.
- Prevent DNS rebinding by deriving targets from numeric listener records and resolving permitted hostnames back to loopback before connecting.
- Treat HTTP content, titles, manifests, and command output as untrusted data, never instructions.

## Testing Plan

Add `scripts/test/developer-runtime-check.mjs` with injected command and HTTP fixtures covering:

- Machine-readable `lsof` parsing, duplicate descriptors, IPv4, IPv6, and wildcard listeners.
- Capability snapshots for `darwin`, `linux`, `win32`, and an unknown platform.
- Verification that unsupported platforms execute no discovery commands and return the explanatory state.
- Working-directory lookup and nearest repository root.
- SSH/HTTPS Git remote normalization and credential removal.
- Stable identity across port changes.
- Project/app association with two listeners in one repository and no arbitrary primary selection.
- Git worktrees, path-to-remote identity aliasing, and moved repositories.
- `localhost` versus `127.0.0.1` origin selection, IPv6 fallback, and saved origin preference.
- Self-signed HTTPS classification without globally disabling TLS verification.
- HTTP success, redirect, authentication response, timeout, non-HTTP listener, and oversized body.
- Same-origin redirect acceptance and external redirect rejection.
- Settings validation, atomic writes, saved-link CRUD, and migration/version rejection.
- Optimistic revision conflicts from two simulated browser tabs.
- Manual association of a low-confidence instance.
- Snapshot grouping into active, unmatched, and inactive collections.
- Network-exposure warning classification.
- Shared in-flight refresh behavior, stale snapshot preservation, and portal self-registration without recursive probing.

Extend the portal smoke checks in `scripts/test/test-roborepo.sh` to verify:

- `/api/portal/status` includes Runtime.
- `/runtime` serves the injected manifest and token.
- `/portal/developer-runtime/app.js` parses.
- GET snapshot works without a token.
- Refresh and all mutation POSTs reject missing tokens and cross-origin requests.
- Valid link, association, and project mutations return a fresh snapshot and increment the revision.
- A Windows capability snapshot renders the unsupported notice rather than the ordinary zero-instances state.

## Documentation Updates

- Update `docs/user/reference/portal.md` page list, directory layout, dispatch list, and manual checks.
- Add `docs/user/reference/runtime.md` describing discovery, identity resolution, settings, API, security, limits, and key files.
- Update `README.md` and `docs/user/reference/roborepo-cli.md` so `roborepo serve` lists `/runtime`.
- Document `roborepo runtime`, `--json`, and `--open` in the CLI catalog and reference.
- Add `scripts/test/developer-runtime-check.mjs` to `package.json` as `test:developer-runtime` and include it in the broad test runner.

## Implementation Sequence

1. Implement and fixture-test listener parsing, origin-safe HTTP probing, project-root resolution, and identity normalization.
2. Implement the project/app/instance model, versioned settings, revision-safe mutations, and snapshot composition.
3. Add the asynchronous snapshot manager, CLI formatter, and portal-facing bridge; wire handlers into `serveCommand()`.
4. Add Runtime API dispatch to `portal-server.mjs`.
5. Register `/runtime` in `PAGES` and build the page with shared portal modules.
6. Add saved-link and manual-association interactions.
7. Extend smoke and security tests.
8. Update reference and user documentation.
9. Run targeted and broad validation, then perform a manual macOS test using several Node/Vite applications on changing ports.

## Acceptance Criteria

- Opening `roborepo serve` exposes a Runtime navigation item and `/runtime` page.
- Active localhost HTTP applications appear without project-level configuration.
- Known Git projects and app roles retain their names and saved links after PID or port changes.
- `/resume`, `/dev`, `/admin`, and other curated paths are stored without origins and rebuild against the matching app's current origin.
- A repository with multiple listeners never receives an arbitrary primary app association.
- Apps that require `localhost` rather than `127.0.0.1` open with the correct hostname.
- Refresh and probing never block the portal, duplicate concurrent scans, or recursively probe the portal itself.
- Unknown instances remain visible without being incorrectly assigned.
- Windows and other unsupported platforms receive explicit messaging that automatic discovery is unavailable; the page never misrepresents this as zero running services.
- Non-HTTP listeners are excluded from the default view.
- Network-exposed listeners receive a visible warning.
- Settings survive a RoboRepo restart under `stateRoot/developer-runtime/settings.json`.
- All mutation routes enforce the existing portal origin and token contract.
- Concurrent settings edits return an explicit revision conflict instead of silently overwriting changes.
- `roborepo runtime`, `--json`, and `--open` use the same discovery and presentation contracts as the page.
- `npm run test:developer-runtime`, the portal smoke checks, and `npm test` pass.
