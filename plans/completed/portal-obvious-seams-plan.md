---
id: portal-obvious-seams-plan
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Portal Obvious Seams Cleanup Plan

## Status

Completed. All checklist items landed (manifest single-sourced, shared API helpers adopted by
every page including the config source-inspect fetch, server routes split by domain,
`showError()` added to config/telemetry to match the `plans` page convention, maintainer guide
at `docs/user/reference/portal.md`). Verified via `npm test` (285/285 passing) and manual
code cross-check against every checklist item.

## Purpose

The portal is now a top-level RoboRepo surface with Config, Plans, and Telemetry pages. It is
still served as static browser files by `scripts/cli/portal-server.mjs`, which is a good fit for a
local loopback tool. The problem is that page growth has started to duplicate routing, navigation,
API calls, DOM helpers, and mutation-token handling.

This plan keeps the current no-build portal architecture and fixes the seams that will make the next
page harder to add safely.

## Current Behavior

- Server page metadata is defined in `scripts/cli/portal-server.mjs` as `PAGES`.
- Browser navigation metadata is separately defined in `portal/shared/theme.js` as `PORTAL_PAGES`.
- Each page owns its own app script, stylesheet, and HTML entry point under `portal/<page>/`.
- `portal/shared/base.css` owns shared palette and chrome styles.
- `portal/shared/theme.js` injects the shared header, nav, footer, and theme toggle.
- Mutating server routes require `X-Roborepo-Portal-Token`.
- Config and Plans already attach that token through page-local helper code.
- Telemetry has at least one mutating fetch path that does not use the shared token contract.
- `route()` in `scripts/cli/portal-server.mjs` mixes page serving, static assets, Config APIs,
  Plans APIs, and Telemetry APIs in one long conditional chain.
- Several page-local helper shapes overlap: JSON fetches, copy-to-clipboard, status updates,
  element creation, modal/table/drawer affordances, and error handling.

## Proposed Behavior

Keep the portal as static HTML, CSS, and browser JavaScript served by the existing Node CLI, but add
a small shared layer:

- one server-owned portal manifest exposed to every page
- one shared browser API helper for JSON GET/POST and mutation-token headers
- one shared page chrome/bootstrap contract
- one server route dispatcher split by API domain
- one documented convention for adding pages

The goal is not to invent a framework. The goal is to make the current architecture explicit enough
that adding a fourth page does not copy hidden page-local behavior.

## Happy Path

1. A developer adds a page entry to the server portal manifest.
2. The server injects the portal manifest and mutation token into that page's HTML.
3. `portal/shared/theme.js` renders navigation from the injected manifest.
4. The page app imports or uses `portal/shared/api.js` for reads, mutations, and clipboard/status
   helpers.
5. The page registers its server API routes in the relevant route-domain module.
6. The developer runs the portal smoke checks and opens `roborepo serve` to confirm navigation,
   page load, and mutations.

## Implementation Checklist

### 1. Single-source the portal manifest

- Keep page metadata in `scripts/cli/portal-server.mjs` or a nearby server module.
- Include `id`, `path`, `title`, `dir`, and optional aliases such as `/config`.
- Inject a browser-safe global before `</head>`:

  ```html
  <script>
    window.ROBOREPO_PORTAL = {
      token: "...",
      pages: [...]
    };
  </script>
  ```

- Remove the hard-coded `PORTAL_PAGES` list from `portal/shared/theme.js`.
- Keep `/config` as a stable alias for saved links and docs.

### 2. Add shared browser API helpers

Create `portal/shared/api.js` with focused functions:

- `portalConfig()` reads `window.ROBOREPO_PORTAL`.
- `portalGetJson(path)` wraps `fetch`, JSON parsing, and error extraction.
- `portalPostJson(path, body)` adds `Content-Type` and `X-Roborepo-Portal-Token`.
- `portalCopyText(text, onCopied)` wraps `navigator.clipboard.writeText`.
- `portalSetUpdatedAt(date)` replaces or backs `window.roborepoSetUpdatedAt`.
- `portalEl(tag, attrs, ...children)` provides one DOM-builder shape if pages still need it.

Convert current page-local fetch helpers to this shared API:

- Config package/skill/permission mutations.
- Plans refresh/settings/prompt mutations.
- Telemetry package-enable mutation.

### 3. Split server route domains

Keep one HTTP server, but move route handling into small functions:

- `handlePortalPage(req, res, context)`
- `handlePortalAsset(req, res, context)`
- `handleConfigApi(req, res, handlers, context)`
- `handlePlansApi(req, res, handlers, context)`
- `handleTelemetryApi(req, res, handlers, context)`
- `handlePortalStatus(req, res, context)`

Each handler should return `true` when it sent a response and `false` when it did not match. The
top-level `route()` remains responsible for:

- parsing URL and query string
- enforcing POST origin and mutation-token checks
- calling handlers in a clear order
- returning the final 404

### 4. Standardize page lifecycle shape

Do not force all pages into one controller. Add a light convention:

- each page script initializes event handlers near the top
- each page has `load()`, `render(...)`, and `showError(...)`
- repeated polling, when present, uses named constants for intervals
- page scripts avoid direct mutating `fetch`; use `portalPostJson`
- page scripts call `portalSetUpdatedAt` after successful fresh data

### 5. Add a short portal maintainer guide

Add or update a reference doc that explains:

- page directory layout
- how page metadata reaches the browser
- how to add a page
- how to add a read API
- how to add a mutating API
- how mutation-token protection works
- which checks to run after portal changes

## Edge Cases

### Browser page without injected manifest

Shared helpers should fail with a clear message such as `portal manifest missing`. This catches
accidental direct file opening or incomplete server injection.

### Existing `/config` links

The manifest should model aliases without making the browser nav duplicate Config. `/` and `/config`
should both mark Config active.

### Read-only curl/debug workflows

Read-only routes should remain tokenless for local debugging. Mutating routes should continue to
require loopback origin checks and the mutation token.

### Page-specific rendering needs

Telemetry canvas/chart logic, Plans drawer behavior, and Config source-inspect modal behavior can
stay page-local until there is a second consumer. Only shared primitives should move now.

## Validation

- `roborepo serve` opens the default page and every nav item loads.
- `/api/portal/status` returns the same page list the browser nav uses.
- Config toggles still mutate package, skill, and permission state.
- Plans refresh and discovery-root changes still mutate state.
- Telemetry "turn on telemetry" succeeds with token-protected POST.
- A forged POST without `X-Roborepo-Portal-Token` still returns 403.
- A cross-origin POST still returns 403.
- Existing tests that cover `serve`, Config API, Plans API, and Telemetry API continue to pass.

## Open Decisions

- Should shared browser helpers be loaded as classic scripts on `window.roborepoPortal`, or as ES
  modules with `type="module"`?
- Should route-domain handlers live beside `portal-server.mjs` or in a new `scripts/cli/portal/`
  directory?
- Should the portal maintainer guide live under `docs/user/reference/portal.md` or be folded
  into the existing `docs/user/reference/roborepo.md`?

## Success Criteria

- Adding a page requires one manifest entry, one page directory, and optional route-domain changes.
- Browser nav and server status cannot drift.
- Every mutating browser request uses the same token helper.
- `route()` becomes short enough that a new API domain does not require editing a long conditional
  chain.
- The portal remains dependency-light and works through the existing `roborepo serve` command.
