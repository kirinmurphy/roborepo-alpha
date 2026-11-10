---
id: web-portal-security
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Web Portal Security

> Status: completed. The local portal security baseline shipped: loopback binding,
> strict/fallback port behavior, whitelisted source reads, escaped markdown rendering,
> and narrow JSON mutation endpoints.

## Purpose

The roborepo web portal is intentionally local. It runs on the user's machine, reads
local config and rules files, and lets the user mutate live harness state. That makes it
simple to use, but it also creates a real security surface:

- local browser access to a mutable web UI
- loopback-bound HTTP routes
- markdown rendered from repository and home-directory content
- file reads for tool and rules inspection
- port selection and server lifecycle management

This plan defines the threat model and the controls roborepo should keep in place as the
portal evolves.

## Current Behavior

The current portal is a loopback-only Node HTTP server started by `roborepo serve` and
`roborepo web`.

Important code paths:

- `scripts/cli/main.mjs` dispatches `web` to `serve --detach`.
- `scripts/cli/telemetry.mjs` owns detached server lifecycle, PID tracking, and port use.
- `scripts/cli/portal-server.mjs` binds the HTTP server to `127.0.0.1`.
- `scripts/cli/config.mjs` builds the config snapshot and resolves read-only source views.
- `scripts/cli/config-dashboard.mjs` renders the `/config` page and opens source popups.

Current data flow:

1. The server exposes `/config`, `/api/config`, and write endpoints for config toggles.
2. The browser fetches the snapshot, then posts mutations immediately when a toggle changes.
3. The portal shows live rules content, skill content, and inspected source files as markdown.
4. Source reads are catalog/manifest-whitelisted rather than path-derived from the request.
5. Detached `roborepo web` starts a single managed portal process and writes a PID file.

Current binding behavior:

- `roborepo serve --port <n>` is strict and should stay strict.
- `roborepo web` can select another port if the requested one is occupied.
- The server still binds to `127.0.0.1`, not a public interface.

## Threat Model

Treat the portal as local, not trusted.

The relevant adversaries are:

- another process on the same machine
- a browser page the user visits while the portal is open
- a local process that can send loopback HTTP requests
- a malicious or malformed markdown file in the user's own config/rules surface
- a stale or conflicting local process already listening on the configured port

The portal is not exposed to the internet by design, but that does not make it safe to
omit checks. Loopback only reduces exposure; it does not grant trust.

## Security Goals

1. Keep the portal local-only by default.
2. Keep `roborepo serve --port <n>` predictable and fail-fast.
3. Let `roborepo web` find a free port instead of failing when the preferred port is busy.
4. Never read arbitrary files based on request input.
5. Never treat raw markdown as trusted HTML.
6. Preserve user-authored config content and markers when rendering live files.
7. Keep mutating routes narrow and explicit.
8. Make future widening of network exposure a deliberate, audited decision.

## Attack Surface

### HTTP routes

The server currently serves:

- `/config` for the portal UI
- `/api/config` for snapshots
- `/api/config/packages` and `/api/config/skills` for immediate toggles
- `/api/config/permissions` for profile changes
- `/api/config/source` for read-only inspection popups

Mutating endpoints are the highest-value targets because they change live harness state.

### File reads

The portal reads:

- live `CLAUDE.md` / `AGENTS.md`
- generated rules fragments
- package rules fragments
- shared skill markdown
- command wrappers

These reads are currently catalog/manifest-driven. That is the right shape and should stay
that way.

### Markdown rendering

The portal now renders markdown content instead of showing raw syntax. That improves
usability, but it also means HTML injection must be handled deliberately.

### Port selection

If the preferred port is busy, the portal can either fail or select another port. The
selection logic itself is part of the security model because it determines whether the UI
stays reachable and whether an unrelated process can block the workflow.

## Proposed Controls

### Loopback binding

Keep the server bound to `127.0.0.1`.

Why:

- browsers can reach localhost easily, but the exposure stays local
- remote network scans cannot reach the portal directly
- the behavior is simple and predictable

Future widening to `0.0.0.0` or a public interface should require a separate design and
explicit authentication.

### Strict vs forgiving port behavior

Preserve two modes:

- `roborepo serve --port <n>`: strict, no fallback, fail if the port is unavailable
- `roborepo web`: forgiving, pick another free local port if the preferred one is occupied

Why:

- scripts, bookmarks, and manual debugging benefit from a predictable fixed port
- the user-facing `web` shortcut should prefer completion over failure
- the strict mode keeps automated flows explicit and easy to reason about

### Managed lifecycle

Keep a single managed detached portal for `roborepo web` by using the existing PID file.

Why:

- a stale managed server should be replaced, not left to drift
- a detached portal should not multiply across repeated launches
- shutdown and restart behavior stays understandable

The PID file should remain an ownership hint, not a trust boundary.

### Markdown sanitization

Render markdown safely:

- escape raw HTML
- support a small allowed markdown subset
- render links with explicit `rel="noopener noreferrer"` and target handling
- never execute script content from markdown

Why:

- skill files, rules files, and live config files may contain user-authored text
- the portal should display content, not interpret it as executable page markup

### Whitelisted source resolution

Keep `loadConfigSource()` strict:

- source kind must be one of the known categories
- ids must match catalog entries
- paths must be resolved from repo-owned manifests or fixed harness locations
- request input must never become a filesystem path directly

Why:

- this blocks traversal and arbitrary file exposure
- the portal only needs a fixed set of inspectable sources

### Minimal mutation surface

Keep mutation endpoints narrow and shape-checked:

- package toggles accept `{ id, enabled }`
- skill toggles accept `{ id, enabled }`
- profile changes accept a validated profile and scope

Why:

- narrow request shapes are easier to validate
- the server can reject malformed or surprising input early
- the browser UI and the server contract stay aligned

### No secret-bearing query strings

Keep secrets out of URLs and query strings.

Why:

- URLs are more likely to end up in logs, browser history, and copy-paste
- the portal currently does not need user secrets for any route

## Browser and Local-Process Risks

### Same-machine browsers

Even with localhost-only binding, a browser tab can still issue requests to local services.
If the portal ever exposes anything sensitive or dangerous, the request origin must be
considered hostile unless proven otherwise.

### Same-user local processes

Any local process with network access can usually reach loopback services. Do not assume
the portal is hidden from malware or from other software running under the same account.

### Cross-origin assumptions

If the portal is ever reachable from a non-localhost origin, CSRF-style protections become
mandatory. Even now, if a change makes the portal available on a wider interface, origin
checks and a session token should be introduced together.

## Markdown-Specific Risks

Rendered markdown introduces a few specific concerns:

- raw HTML injection from markdown source
- unexpected link targets or unsafe protocols
- overly permissive inline formatting that obscures intent
- accidental trust in user-authored content copied from the live rules file

The portal should treat markdown as presentation markup, not as a trusted document format.

## Port Namespacing Options

If the port is occupied, there are a few standard patterns:

| Option | Description | Tradeoff |
| --- | --- | --- |
| Fixed strict port | Always use one port and fail if it is busy | predictable, but brittle |
| Fixed port with fallback | Try the preferred port, then search for the next free one | user-friendly, but the URL changes |
| Ephemeral port | Let the OS assign a free port | robust, but the URL is discovered dynamically |
| Unix socket + proxy | Bind locally over a socket and proxy to a browser-facing endpoint | strong IPC shape, but more moving parts |

For this repo, the current best fit is:

- strict fixed port for `serve`
- fallback port search for `web`
- single local loopback HTTP server

That keeps the UI simple while still recovering from a busy port in the common interactive
path.

## Future Hardening Options

If the portal ever exposes more sensitive actions, the next controls to consider are:

1. A per-session nonce carried in a cookie or header.
2. Origin/referrer validation for mutating requests.
3. An explicit `--host` option that defaults to `127.0.0.1` but refuses unsafe widening
   unless the user opts in.
4. A lockfile or socket-claim mechanism to make managed portal ownership explicit.
5. Separate read-only and mutating endpoints, with the mutating server only started on demand.

These are not required today for a local-only portal, but they become relevant if the UI
gains broader state or a wider bind target.

## Validation And Monitoring

The portal security baseline should be checked with:

- syntax checks on the CLI server files
- a small smoke test for port fallback
- a source-resolution smoke test that confirms whitelisted file access only
- markdown rendering checks that ensure raw HTML is escaped

Operationally, the portal should continue to:

- log the chosen local URL
- keep `serve` failures obvious when strict mode is requested
- keep `web` resilient when the preferred port is unavailable

## Edge Cases

- A stale PID file should not block startup forever.
- A managed detached server should be cleaned up before starting another managed detached server.
- A port can become occupied between the availability probe and actual bind; that race should
  still fail safely.
- A live rules file may contain user edits, boundary markers, or empty content; the renderer
  should display all of it without dropping user content.
- A malformed markdown file should degrade to readable text, not executable HTML.
- A future network-exposed mode should be treated as a separate product decision, not a flag
  flip on the current portal.

## Implementation Checklist

1. Keep `roborepo serve --port <n>` strict.
2. Keep `roborepo web` on a fallback-port path when the preferred port is busy.
3. Keep the server bound to loopback only.
4. Keep all request-to-file resolution catalog-driven.
5. Keep markdown rendering escaped and bounded.
6. Add or retain tests for detached startup, fallback ports, and source resolution.
7. Revisit authentication only if the bind scope or data sensitivity grows.

## Open Decisions

- Whether fallback port search should try a short contiguous range or immediately use an
  ephemeral OS-assigned port.
- Whether the chosen fallback port should be persisted to a portal state file for later reuse.
- Whether future auth should be cookie-based, header-based, or origin-gated first.
