---
id: developer-runtime-metadata-suggestions
priority: high
next_action:
blocked_by: []
depends_on:
  - developer-runtime-final
related:
  - developer-runtime-docker-process-providers
  - developer-runtime-git-health-history
  - canonical-repository-identity-plan-v2
reviewed_commit: e07f832
---

# Runtime Metadata Suggestions

## Summary

Fetch safe conventional same-origin metadata for current Runtime apps and present discovered
routes as suggestions, never as automatic quick links.

## Current State

- `/api/developer-runtime/metadata?key=<opaque-key>` is already routed
  (`scripts/cli/portal-routes-developer-runtime.mjs:24`) to `loadDeveloperRuntimeMetadata`
  (`scripts/cli/developer-runtime.mjs:122`), which resolves the opaque key via
  `findCurrentInstanceByOpaqueKey` (same SSRF/enumeration guard `loadDeveloperRuntimeHistory` uses) and
  returns `{ ok: true, origin, suggestions: [], deferred: "..." }` — an explicitly deferred empty
  result, not a stub route.
- `modules/developer-runtime/probe.mjs`'s `probeHttpCandidate` already does same-origin HTTP
  GET with an 800ms timeout, a 64KB body cap, `<title>` and `<link rel=icon>` extraction, and
  redirect-target loopback classification (`redirectExternal`). It is not wired into the metadata
  loader yet and does not touch `/sitemap.xml`, `robots.txt`, manifest, or OpenAPI documents — this
  plan extends discovery to those sources, not just title/favicon.
- No `modules/developer-runtime/metadata.mjs` exists yet.
- Portal has an existing pattern to mirror: `portal/developer-runtime/history-view.js` is a self-contained
  view module opened via an `onHistory` callback wired in `portal/developer-runtime/app.js`, fetching
  through `portal/developer-runtime/api.js`'s `portalGetJson`. Suggestions follow the same shape
  (`createSuggestionsView`, `onSuggestions` callback, `fetchMetadata`).
- "Add as quick link" cannot silently append to the existing `links` mutation
  (`modules/developer-runtime/settings.mjs` `mutateLinks`, POST `/api/developer-runtime/links`) — that mutation
  **replaces** the app's whole `links` array rather than merging, so the portal action instead opens
  the existing add-link dialog prefilled with the suggestion.
- `normalizeRoutePath` lives in `modules/developer-runtime/settings-schema.mjs` (re-exported via
  `settings.mjs` and `index.mjs`) — not `discovery.mjs`. Already rejects cross-origin,
  protocol-relative, and credentialed paths — reused for validating discovered suggestion paths.

## Relation to Canonical Repository Identity (v2)

No dependency. This plan does same-origin HTTP metadata discovery and touches no repository
identity or Git-root resolution, so it is unaffected by `canonical-repository-identity-plan-v2` and
can ship before or after it. Listed as `related` only for sibling-plan awareness.

## Worktree/Root Hierarchy (built)

**Built.** `entry.roots[]` grouping ships in `modules/developer-runtime/snapshot.mjs`, with the portal
rendering one collapsible section per checkout (`tpl-repository-root`) under a `Worktrees` heading.
Two root causes were found and fixed along the way: `instanceShapeKey()` grouped listeners by
`title + relativeCwd` with no `rootId`, so two worktrees' main listeners collapsed into one
"duplicate ports" warning; and `ensureRoot()` declared a `projectRoot` parameter that none of its
three call sites passed, leaving every root's path `null`.

Follow-on scope now tracked separately: container-to-checkout ownership, in
`docs/plans/active/developer-runtime-workspace-model.md`. That plan supersedes the
"whether compose groups need their own root association" question left open below — the answer is
that `working_dir` resolves the repository but must not decide the checkout.

The original problem statement follows, kept for context.

Surfaced from real usage: running `roborepo web` from a worktree makes the worktree's branch name
the repository card's title, because `buildRepositories()` (`modules/developer-runtime/snapshot.mjs:196`)
picks one arbitrary member's `git` for the whole repository-level badge and flattens every member
from every root (main checkout and every worktree) into one `entry.members` list with no grouping
by root. There is no visual signal today for which member belongs to which checkout, and the
canonical (main, non-worktree) checkout has no special standing — whichever root's listener started
first, or was discovered first, wins the title.

### Current data model (confirmed, not proposed)

Every `member.instance.project` already carries what a root-grouped hierarchy needs — this is a
grouping and rendering gap, not a missing-data problem:

| Field | Source | Meaning |
| --- | --- | --- |
| `repositoryId` | `modules/repositories/identity.mjs` | Canonical, shared across every worktree of one repo |
| `rootId` | `modules/repositories/identity.mjs` (`rootId()`) | One per checkout path; distinct per worktree even though `repositoryId` is shared |
| `project.git.isWorktree` | `modules/repositories/identity.mjs` (`commonDir !== gitDir`) | `false` for the main/primary checkout, `true` for every linked worktree |
| `project.git.branch` | `modules/developer-runtime/git.mjs` | Per-root, already correct today |
| `project.git.ahead` / `.behind` | `modules/developer-runtime/git.mjs:74` (`collectGit` → `branchFact`) | Per-root, gated on the branch having a tracked upstream; `null` when untracked, never a stale repo-level aggregate |

### Target hierarchy (agreed with user)

```
Repository (repositoryId)                — canonical name + GitHub link, never depends on which root is running
├─ Main worktree (isWorktree: false)      — always shown as its own section, even with no active listener
│   ├─ branch name, ahead/behind
│   └─ members (this root's listeners only)
└─ Additional worktrees[] (isWorktree: true, one section per rootId)
    ├─ worktree name (title), branch name, ahead/behind
    └─ members (this root's listeners only)
```

Resolved open question: if the main checkout has no running listener (only a feature worktree is
active), the repository header still shows only the canonical name + GitHub link — no URL promoted
into the header from a running worktree. The main-worktree section renders with no members/URL; the
active worktree gets its own full section below with its own URL. Canonical identity never depends
on what happens to be running.

### Scope

This needs two layers, in order:

1. **Server**: `buildRepositories()` groups `entry.members` by `rootId` into a new intermediate
   level (e.g. `entry.roots[]`, each `{ rootId, isWorktree, git, members[] }`), instead of one flat
   `entry.members` array. `entry.git` (today: one arbitrary root's git, used for the whole
   repository) is replaced by per-root git on each `roots[]` entry; the repository-level `name`/
   `providerUrl` stay as they are today (already root-independent). Existing consumers of
   `entry.members`/`entry.git` (`portal/developer-runtime/templates.js`, and this session's `memberProject`
   git-badge-suppression fix in `modules/developer-runtime/snapshot.mjs`) need updating for the new shape —
   the git-badge-suppression comparison this session added becomes unnecessary once each root
   renders its own section with its own git context; that per-member suppression logic can likely be
   deleted rather than kept alongside the new grouping.
2. **Portal**: `repositoryCard()` (`templates.js:285`) renders a main-worktree section followed by an
   additional-worktrees list, each using the existing member/instance card for its own members,
   rather than one flat `[data-slot=members]` list.

Not yet scoped: exact visual treatment (font sizing, collapsible sections per your sketch), whether
compose groups need their own root association, and whether this touches
`docs/plans/backlog/portal-repository-home-and-detail.md`'s repository-first IA. That plan's
`repositoryDetailPayload()` already exposes a `localRoots[]` concept
(`modules/repositories/summary.mjs:45`), but only `{ kind, firstSeenAt, lastSeenAt }` — no `rootId`,
branch, git, or members. Same underlying concept (multiple roots per repository), not directly
reusable data; check before building a second parallel grouping, but expect to extend that shape
rather than import it as-is.

## Suggestions UX Redesign (built, not yet browser-verified)

User feedback on the shipped direct-add flow: the "add" step's premise is unclear when discovery is
already live/re-run on every dialog open — nothing is persisted server-side from a suggestions call,
so why ask the user to explicitly promote a route into `app.links` at all, rather than just showing
discovered routes as directly-clickable links and capturing one into `app.links` automatically the
first time it's actually used?

**Built.** Replaced the "Suggested routes" three-dot-menu entry + modal dialog with a standalone
`<portal-menu-button>` (`portal/shared/menu-button.js` — existing shared trigger+popover component,
not a new one) mounted into a reserved `[data-slot=routes-trigger]` slot next to the three-dot menu
(`index.html`'s `tpl-card`; not present on `tpl-compose-project-card` — "Suggested routes" was
already instance-cards-only before this session, unchanged). Opening it shows discovered routes as
plain clickable `<a>` rows (`tpl-route-link-row`), no dedicated "Add" button, no dialog. Clicking an
unsaved link both opens it (default anchor behavior) and captures it into `app.links` via the
existing `updateLinks` mutation (`captureRouteLink` in `app.js`, evolved from the direct-add flow's
`addSuggestedLink`) — a route becomes a permanent quick link only once actually used, never from
merely opening the dropdown. `suggestions-view.js` changed from a dialog controller
(`createSuggestionsView`) to a dropdown-content builder (`buildRoutesDropdown`).

Resolved with user:
- **Capture trigger**: only fire the `updateLinks` mutation if the path is not already in
  `app.links` — check first, skip the write entirely for an already-saved link, so re-clicking a
  saved link is a pure navigation with no mutation traffic.
- **Dropdown contents**: show the full discovered set every time (not shrinking as routes get
  saved), with a visual indicator (checkmark/dim) on entries already present in `app.links` — a
  stable, predictable view rather than one whose contents change as a side effect of use.
- **Auth-path safeguard**: the existing `AUTH_LOOKING_SEGMENTS` filter (excludes admin/login-looking
  paths unless sitemap/OpenAPI evidence overrides it) is the only gate. No extra confirm step for
  admin-looking routes that already passed that filter — consistent one-click behavior for every
  route the dropdown shows.

Verified: the underlying `updateLinks` mutation (`captureRouteLink`'s exact call shape — revision,
projectIdentity, appId, full links array) was exercised via `curl` against a live running portal,
confirmed it persists correctly and that `isRouteSaved`'s "already in `app.links`" check would
correctly recognize a just-saved path. `node --check` on every touched file, and each served `.js`
file parsed with `node --input-type=module --check` against its actual served bytes. **Not
verified**: the dropdown's visual rendering, the menu-button mount/toggle interaction, and the
checkmark indicator have never been seen in a browser — no Chrome automation was available this
session, same caveat as the rest of this plan's UI work.

## OpenAPI Discovery: Generate From The Route Registry Instead Of Hand-Writing (done for this portal)

User question: is OpenAPI/Swagger still the right way to discover an app's API routes, and could the
route-table registry (`scripts/cli/portal-router.mjs`, built earlier this session) answer this
directly instead? Answer: only for *this portal itself* — `API_ROUTE_TABLES` is in-process JS data,
invisible to `discoverMetadataSuggestions`'s same-origin HTTP-only discovery of *other* apps (which
may be a different process, language, or machine on loopback). For arbitrary other apps, OpenAPI/
Swagger convention-path discovery remains the only non-invasive HTTP-only option — kept as-is.

For this portal specifically, `buildOpenApiDocument()` (`portal-router.mjs`) now generates a real
minimal-but-valid OpenAPI document (`paths` + `methods` only, no schemas — nothing in the registry
has types to generate schemas from) straight from `API_ROUTE_TABLES`, served at `/openapi.json`
(first entry in `metadata.mjs`'s `CONVENTIONAL_OPENAPI_PATHS` guess list, so existing discovery finds
it with no changes). Same drift-free guarantee as `/manifest.json`/`/sitemap.xml`: a route added to
any table appears here on the next request. Verified live: 35 real paths generated and correctly
picked up as `source: "openapi"` suggestions.

## All-Sources Test Visibility (done, with one caveat)

User asked to see all 4 metadata sources (manifest, sitemap, robots, openapi) rendering at once for
UI testing. Per-source unit test coverage already existed and is independent
(`scripts/test/developer-runtime-metadata-check.mjs`'s manifest/robots/sitemap/openapi blocks can be
commented out individually without affecting the others). Live/end-to-end visibility: openapi and
sitemap now both surface distinctly (verified: 35 openapi + 4 sitemap suggestions in one call).
Manifest could not be made to surface as a 5th distinct source without either pointing `start_url` at
a fake, non-real path (rejected — would look broken if clicked) or a real page not already in the
sitemap (none exist, since `PAGES` — this portal's real page list — is also its sitemap source).
Manifest colliding with sitemap here is dedup working correctly, not a bug: to see it in isolation,
temporarily comment out the `/sitemap.xml` branch in `portal-routes-metadata.mjs`. Robots never
surfaces as a *visually distinct* source by design — it only re-declares sitemap URLs, so its
contribution is definitionally the same paths sitemap already found.

## Goals

- Inspect manifest, favicon, robots sitemap declarations, conventional `/sitemap.xml`, and
  explicitly linked/configured OpenAPI documents.
- Never send cookies or credentials.
- Enforce loopback-only same-origin fetches, strict body-size limits, redirect limits, and safe URL
  sanitization.
- Deduplicate suggestions by normalized path and label each source.
- Exclude authenticated/admin-looking paths unless they came from explicit OpenAPI or sitemap
  evidence.
- Keep curated links authoritative; suggestions require user action.

## Implementation Plan

- [x] Add `modules/developer-runtime/metadata.mjs`:
  - [x] Export `discoverMetadataSuggestions(origin, { fetchText, openApiUrl })`, with an injectable
        text-fetch client so tests never hit real sockets.
  - [x] Reuse a shared loopback-fetch guard for every fetch this module makes (manifest, robots.txt,
        `/sitemap.xml`, OpenAPI doc) rather than re-implementing timeout/body-cap/redirect safety.
        Implemented as a new export, `fetchLoopbackText`, extracted from `probeHttpCandidate`'s
        low-level mechanics in `modules/developer-runtime/probe.mjs` (`probeOrigin` itself is unchanged;
        the two share the same timeout/body-cap constants and loopback check, not a duplicated copy).
  - [x] Parse `manifest.json` for `start_url`/`name`. **Deviation:** only the conventional
        `/manifest.json` path is checked; `<link rel=manifest>` HTML scanning was dropped as
        redundant with the conventional-path fallback for this iteration (most dev servers serve
        `/manifest.json` regardless of whether the page also links it). Documented as a known limit
        in `docs/user/reference/runtime.md`.
  - [x] Parse `robots.txt` for `Sitemap:` declarations; fetch and parse discovered sitemap URLs and
        the conventional `/sitemap.xml` fallback for `<loc>` paths.
  - [x] Discover an OpenAPI/Swagger document by trying a short list of conventional paths in order
        (`/openapi.json`, `/swagger.json`, `/v3/api-docs`, `/v2/api-docs`, `/api-docs`), keeping the
        first response that actually parses as a valid document (has a `paths` object) rather than
        the first 200 — a dev server's catch-all route can return 200 with an HTML shell for any
        guessed path. Only JSON bodies are parsed; **a second review pass caught `/openapi.yaml`
        originally included in this list even though nothing here parses YAML, meaning that
        candidate could never validate — removed rather than adding a YAML parser, which is out of
        scope for this pass.** An `openApiUrl` option remains available to override the guess list
        for a nonstandard path, but nothing in settings/CLI/UI currently supplies one.
  - [x] Validate every discovered path with `normalizeRoutePath` (from `settings-schema.mjs`, not
        `discovery.mjs` as originally assumed here) before inclusion; drop anything that fails.
  - [x] Exclude paths matching an authenticated/admin heuristic unless the same path was explicitly
        present in OpenAPI or sitemap evidence.
  - [x] Deduplicate suggestions by normalized path, keeping the highest-confidence source label
        (`openapi` > `sitemap` > `manifest` > `robots`).
  - [x] Never forward cookies/auth headers on any request this module makes.
- [x] Update `loadDeveloperRuntimeMetadata` (`scripts/cli/developer-runtime.mjs`) to call
  `discoverMetadataSuggestions(instance.origin)` instead of returning the hardcoded `deferred` empty
  result; 404-on-unknown-key behavior unchanged. The route handler
  (`scripts/cli/portal-routes-developer-runtime.mjs`) was updated to await the now-async loader via
  `Promise.resolve(loader(...))`, since it is shared with the still-sync `loadDeveloperRuntimeHistory`.
- [x] Add `portal/developer-runtime/suggestions-view.js` mirroring `history-view.js`'s open/close/render
  structure. **Deviation from the original "append via mutateLinks" idea:** `mutateLinks` replaces
  the app's whole `links` array rather than appending, so "Add as quick link" instead opens the
  existing add-link dialog prefilled with the suggestion (`openLinkDialogWithSuggestion` in
  `app.js`), reusing that form's validation and revision-conflict handling instead of a silent append.
- [x] Wire an `onSuggestions` callback in `portal/developer-runtime/app.js`'s `cardActions()` and
  `composeProjectActions()`, add a "Suggested routes" entry to the card action menu
  (`data-action="suggestions"` in `index.html`, wired in `templates.js`'s `wireCardActions`), and add
  `fetchMetadata` to `api.js`. **Scope note:** the compose-container inline port row (a separate,
  denser template with its own bare "History" button, no action menu) was left without a matching
  suggestions entry — adding a second bare button there risked clutter and the main card surface
  already covers every app that also appears as a compose member.
- [x] Documented privacy/behavior in `docs/user/reference/runtime.md` under a new "Metadata
  suggestions" section (what is fetched, source-priority dedup, auth-path filtering and its
  evidence-based override) plus entries under "Current Limits" for known gaps.
- [x] Simplify the "Add as quick link" flow. Was: click a suggestion → dialog closes →
  `openLinkDialogWithSuggestion` reopens the free-text add-link dialog prefilled with the suggestion
  as an extra row → user must still submit that form. Now: each suggestion row has its own "Add as
  quick link" button that calls `api.updateLinks` directly (new `addSuggestedLink` in `app.js`,
  wired through `createSuggestionsView`'s renamed `addSuggestion` callback in
  `suggestions-view.js`), no dialog handoff. The row stays in the suggestions dialog, shows
  "Added" on success (button disabled) or an inline error + re-enabled button on failure (409
  revision conflict or validation), so multiple suggestions can be added without reopening the
  dialog. The free-text dialog (`openLinkDialog`, now `{ addBlank }`-free since suggestions no
  longer prefill it) keeps its job for hand-typed links only. Validation
  (`normalizeRoutePath`) and revision-conflict handling (409) are unchanged — they run
  server-side in `mutateLinks` regardless of caller.
  - Added `[data-slot=add-error]` to `tpl-suggestion-row` (`index.html`) and a `.suggestion-row`
    wrapper so the error line doesn't overflow the suggestions list's 3-column grid; matching CSS in
    `styles.css`.
  - Also fixed a related worktree-visibility gap found in the same investigation:
    `memberProject()` (`templates.js`) unconditionally suppressed a member's git badge, assuming it
    always matched the repository-level badge — false when a repository has two worktrees on
    different branches, each running its own listener, since `buildRepositories`
    (`modules/developer-runtime/snapshot.mjs`) picks one arbitrary member's git for the repository-level
    badge. Now only suppressed when the member's branch and `isWorktree` match what the repository
    card already shows; a differing one gets its own badge. Also added a `(worktree)` suffix to the
    branch label when `git.isWorktree` is true, so two worktrees sharing a branch name are still
    distinguishable (no dedicated worktree icon/slot existed in `tpl-git-row` to extend instead).
  - **Not verified:** no Chrome browser automation was available this session, so none of this was
    visually confirmed in a real browser — only the underlying API mutation (`updateLinks` direct
    call, append behavior, 409 handling) was exercised via `curl` against a live running portal, and
    `node --check` confirmed no syntax errors. The rendering change to `templates.js` (git badge
    suppression logic, worktree suffix) has no automated test coverage at all. Flagging both as
    genuinely unverified rather than claiming a visual check that didn't happen.

## Post-implementation review

A `/code-review` pass against the full implementation diff (commit `14803b1`) found two issues,
both fixed in a follow-up commit:

- **Same-loopback-different-port collapse (fixed).** `normalizeRoutePath` validates that a
  discovered URL's host is *some* loopback host, but not that it matches the *specific* app being
  probed — a sitemap or manifest could name a different local app's port, and the suggestion would
  silently collapse to a bare path attributed to the probed app's origin, with no way for the user to
  see the mismatch before confirming "Add as quick link." Fixed by adding an origin-scoped
  `isSameOrigin` check in `metadata.mjs`'s `dedupeSuggestions`, run before path normalization; added
  a regression test (`same-loopback-different-port URL rejection`).
- **OpenAPI discovery was unreachable in production (fixed).** `discoverMetadataSuggestions`
  originally required an explicit `openApiUrl`, which nothing supplied in production. Replaced with
  conventional-path guessing (see Implementation Plan above) — OpenAPI suggestions now work for any
  app serving its document at one of the common framework paths, with `openApiUrl` kept as an
  override for nonstandard paths. Verified against a real local server (no stub) that only serves
  `/swagger.json`, confirmed guessing correctly skips the earlier misses and finds it; also verified
  a 200-but-not-a-real-document response at an earlier guess is skipped rather than treated as a hit.
- **`/openapi.yaml` candidate could never validate (fixed, caught in a second review pass on the
  guessing commit itself).** The guess list included `/openapi.yaml`, but `discoverOpenApiPaths` only
  ever parses response bodies as JSON — a real YAML-format document at that path would always fail to
  parse and get silently skipped, so that candidate was structurally dead despite being listed.
  Removed rather than adding YAML parsing. No behavior regression: JSON-serving apps are unaffected,
  and the removed candidate never could have matched anything.

## Validation

- [x] `scripts/test/developer-runtime-metadata-check.mjs` added, covering: manifest parsing, robots
  `Sitemap:` parsing, `/sitemap.xml` fallback parsing, OpenAPI path extraction, cross-source
  duplicate-path dedup, unsafe/cross-origin URL rejection, credential-bearing URL rejection,
  authenticated-looking route filtering (and its OpenAPI/sitemap-evidence override), malformed
  sources producing no suggestions instead of throwing, and `fetchLoopbackText`'s own guards
  (external redirect reported-not-followed, body-size cap, timeout, non-loopback rejection) against
  a real local `http.createServer`. Invalid-opaque-key resolution is covered via
  `findCurrentInstanceByOpaqueKey` directly (matching how `developer-runtime-check.mjs` already tests that
  resolver) rather than through the CLI singleton snapshot cache, which has a fire-and-forget
  background refresh that isn't hermetic to invoke from a unit test.
- [x] `"test:developer-runtime-metadata": "node scripts/test/developer-runtime-metadata-check.mjs"` added to
  `package.json`.
- [x] `node --check` passed on every touched/added `.mjs`/`.js` file.
- [x] `npm run test:developer-runtime-metadata` (new, 11/11 passing) and `npm run test:developer-runtime`
  (existing core suite) both pass. Also ran every other `test:developer-runtime-*` script
  (`-git`, `-health`, `-history`, `-docker`, `-docker-stats`, `-docker-mounts`,
  `-compose-identity`, `-repository-merge`, `-process`) since this change touched shared exports in
  `probe.mjs`/`http-probe.mjs`/`index.mjs` — all pass, no regressions.
- [x] Manual real-network verification: started a real local app on `127.0.0.1:4517` serving
  `manifest.json`/`robots.txt`/`sitemap.xml`, called `discoverMetadataSuggestions` against it over a
  real socket (no stub), and confirmed correct output — `/app` from manifest with its label,
  `/resume` and `/admin/panel` from the robots-declared sitemap, with `/admin/panel` correctly kept
  despite looking authenticated because it carried sitemap evidence. Also confirmed the live
  `/api/developer-runtime/metadata?key=...` route returns `{ ok: true, suggestions: [...] }` against a real
  running worktree portal instance (a separate instance on port 4417, started and torn down without
  touching the user's already-running portal on port 4317).
- [x] Browser UI verification completed on 2026-08-24 with headless Google Chrome driven through
  the Chrome DevTools Protocol. The repository/worktree card rendered without visible overlap, the
  copy menu opened with branch/path actions and showed copied feedback, the Pages/API Routes
  dropdown rendered 4 page rows and 42 API rows for the portal, the API contract modal opened with a
  curl command, and click-to-capture saved `/plans` in an isolated temp-state portal.
- [ ] **Not exercised:** HTTPS/self-signed origins and an authenticated-page scenario. These remain
  documented limits, not release blockers for this metadata-suggestions pass.

## Merge with main (2026-08-22)

`main` was merged in at `5c76ef9` (merge commit `0b48780`). Four files conflicted; the resolutions
worth recording are the two that changed code rather than concatenating both sides:

| Conflict | Resolution |
| --- | --- |
| `scripts/cli/portal-server.mjs` | This branch converted every `portal-routes-*.mjs` domain to declarative route tables; `main` added `portal-routes-maintenance.mjs` in the older `handleXApi` style. Maintenance was converted to a route table and registered in `API_ROUTE_TABLES`, so one dispatch path survives instead of a table plus a leftover if-chain. `managed-uninstall-check.mjs` follows, driving the route through `dispatchRoutes` with its two assertions unchanged. |
| `portal/developer-runtime/styles.css` | `main`'s `.repository-card > .card-git-row` band and its `.repository-disclosure`/`.repository-drilldown` hover rules target markup this branch removed — `tpl-repository-card` has no outer `<details>`, and git rows now live per checkout inside `.repository-root`. Dropped as dead selectors. |

`package.json` and `test-roborepo.sh` were both-sides additions at the same spot; both kept.

The merge also surfaced a real gap: `developer-runtime-metadata-check.mjs` had a `package.json` `test:*`
script but no `test-roborepo.sh` entry, so it had never run in CI. `main`'s new `orphan-test-check`
caught it on contact. Now wired in beside the other developer-runtime checks — 102 test files reachable.

## Review and main merge (2026-08-24)

Local `main` was merged again at `e07f832` with no conflicts. The branch is now 126 commits ahead of
`origin/developer-runtime-metadata-suggestions` after the merge.

Review found one small route-panel bug and one file-structure cleanup worth doing before browser
verification:

- [x] Route saved-state lookup now uses the same effective project identity as the saved-link
      mutation. Before this, aliased or repository-member cards could check `instance.project.identity`
      while `captureRouteLink` wrote to `project.identity`, leaving saved-route checkmarks stale even
      though capture itself wrote to the correct app.
- [x] API contract modal and curl rendering moved from `portal/developer-runtime/suggestions-view.js` into
      `portal/developer-runtime/api-route-dialog.js`. Saved/discovered-link merge moved into
      `portal/developer-runtime/routes-model.js`, so `suggestions-view.js` now owns dropdown rendering
      only.

Verification after this review:

- [x] `node --check portal/developer-runtime/app.js`
- [x] `node --check portal/developer-runtime/suggestions-view.js`
- [x] `node --check portal/developer-runtime/api-route-dialog.js`
- [x] `npm run test:developer-runtime-metadata` (first sandbox run failed on `listen EPERM 127.0.0.1`;
      rerun with local-bind approval passed)
- [x] `npm run test:developer-runtime`
- [x] `npm run build`

## Completion Summary

Runtime metadata suggestions now ship end to end:

- same-origin metadata discovery from manifest, sitemap/robots, and OpenAPI;
- safe route classification and deduplication;
- portal Pages/API Routes dropdown with saved-link merge behavior;
- API contract modal with generated curl command;
- click-to-capture for discovered page routes;
- repository/worktree grouping and copy controls verified in a real browser.

## Verification

- `node --check portal/developer-runtime/app.js`
- `node --check portal/developer-runtime/suggestions-view.js`
- `node --check portal/developer-runtime/api-route-dialog.js`
- `npm run test:developer-runtime-metadata`
- `npm run test:developer-runtime`
- `npm run build`
- `npm run test:plans`
- Headless Google Chrome CDP verification against `http://127.0.0.1:3060/runtime`: 19 cards,
  7 Pages/Routes triggers, copy menu open/copy/flash states, 4 page suggestions, 42 API suggestions,
  API modal open, no page errors.
- Headless Google Chrome CDP verification against isolated temp-state
  `http://127.0.0.1:3061/runtime`: click-to-capture changed `/plans` from unsaved to saved and
  wrote `/plans` to the isolated Runtime settings.
