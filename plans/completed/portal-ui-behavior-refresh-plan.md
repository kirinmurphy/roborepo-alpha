---
id: portal-ui-behavior-refresh-plan
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Portal UI & Behavior Refresh Plan

## Status

Completed. All four sections (global loading, /config, /plans, /telemetry) and all 7 Open
Questions are resolved in code. The discovery-root time-budget truncation path is now covered:
`DISCOVERY_TIME_BUDGET_MS` (`modules/plan-docs/index.mjs`) is overridable via
`ROBOREPO_DISCOVERY_TIME_BUDGET_MS`, letting `scripts/test/plan-docs-check.mjs` force the deadline
to 0ms against the existing traversal test tree and assert `truncated: true` deterministically —
no real slow scan or huge synthetic tree needed. Default budget raised 2.5s → 5s (per-directory
walk cost is ~0.05-0.2ms; 5s covers well beyond any realistic discovery-root folder size, and the
only cost of a longer budget is extra wait time on a misconfigured root before it gives up).
Verified via `npm test` (285/285 passing, including the new truncation case).

## Purpose

A batch of portal UX/behavior fixes gathered from live use, spanning all three portal pages
(`/config`, `/plans`, `/telemetry`) plus the shared chrome layer. Ranges from small legibility
fixes to a real rewrite of the plan-docs repository scanner. Grouped below by page, in priority
order (global/shared → config → plans → telemetry), since the global loading rework touches all
three pages and should land first.

## Decisions Locked In (from clarifying Q&A)

- **Link icon placement (config items):** icon sits on each item's own label row, inline next to
  the item name — not just the section panel-head.
- **Plan Docs single external link:** use the first entry in that item's existing `urls[]`; drop
  the rest from the visible list. No new manifest field.
- **Repository traversal rewrite:** add a max-depth cap AND a time budget, in addition to the
  `.git`-stop and directory blacklist, so a misconfigured discovery root (e.g. `$HOME` or `/`)
  can't hang the scan or walk the whole filesystem.
- **Plans filter redesign:** ALL 7 filters (search + repository + lifecycle + priority + blocked +
  readiness + review + health) move into the expandable/collapsible section together. Any
  non-default filter gets a removable chip in the always-visible summary row.
- **Global loading rework:** full-page loading overlay, applied to all three pages (config, plans,
  telemetry) — not just config. Each page's own status text (plan/repo counts, telemetry meta,
  etc.) becomes ordinary in-page content once loaded, not a persistent bar.

## Current Behavior (relevant facts, verified against code)

### Shared / global

- `portal/shared/base.css` defines `.page-status` (base.css:187) as a fixed-ish top bar, styled
  `color: var(--dim)`.
- All three pages (`portal/config/index.html:23`, `portal/plans/index.html:21`,
  `portal/telemetry/index.html:23`) render `<div class="page-status" id="status|meta">loading…</div>`
  as literally the first element in `<body>`, before `<main>`.
- Each page's `app.js` overwrites that div's `textContent` after its initial fetch resolves, and on
  every subsequent poll. It doubles as "loading indicator" AND "persistent status/metadata bar" —
  two different jobs on one element, which is the ask #1 complaint (hard to find where the markup
  "lives" because it's all `textContent` assignment in JS, no template).
- No shared full-page loading/hide pattern exists today; each page just leaves `#status`/`#meta`
  showing "loading…" until the first fetch resolves.

### `/config` (`portal/config/index.html`, `portal/config/app.js`, `portal/config/styles.css`)

- Config item rows come from `<template id="tpl-config-item">` (index.html:219-234). Row layout:
  `dot | item-body (label+badges, description, hint, url-row, status) | toggle`.
  `url-row` (`app.js:353-367`) renders each `item.urls[]` entry as a plain `<a class="url-link">`
  showing the raw URL text (styles.css:396). This is what the ask calls "external badge" — there is
  no separate badge concept for links; it's just the raw-text anchor. Confirmed via
  `scripts/cli/config.mjs:341-344` — `badges` only ever contains `"pending"` or a non-standard
  `item.status` string, never anything link-related.
- Section templates for "Skills - Workflows" (`tpl-section-commands`, index.html:181-189) and
  "Skills - Code Conventions" (index.html:190-202) carry `<p class="panel-desc">` description text.
  `panel-desc` color is `var(--dim)` (config/styles.css:35 references shared `--dim` token).
  `--dim` is `#a3adb8` in dark mode and `#656d76` in light mode (base.css:16, base.css:59) — user
  reports this reads poorly in dark mode specifically.
  `.panel-head h2` (config/styles.css:26) and `.panel-desc` font sizes are the two the user wants
  bumped one step.
- `Token Optimization` section (`tpl-section-token-optimization`, index.html:175-180) renders items
  through the same `tpl-config-item` path — the "external badge" question above applies here too;
  there's no special badge, just the URL text-link.
- `#status` on this page shows `"updated " + toLocaleTimeString()` after load, and
  `"applying " + item.label + "…"` / `"saved " + item.label + " " + time` during toggle mutations
  (app.js:139-157). This duplicates the "updated at" timestamp that `portalSetUpdatedAt()`
  (shared/api.js) already writes into the site header — ask wants the subheader copy removed,
  keeping the header's version as the single source.

### `/plans` (`portal/plans/index.html`, `portal/plans/app.js`, `portal/plans/styles.css`)

- Toolbar (index.html:23-34) is one `<section class="toolbar">` with `#search` + 6 `<select>`
  filters + Refresh + "Copy next prompt", all always visible, all in `app.js:42-48`'s shared
  filter-state wiring.
- Discovery roots UI is a `<details class="settings" id="settings">` (index.html:35-45):
  `<summary>` holds the label + rendered root chips (`#roots`); the `<form id="root-form">` inside
  has `#root-input`, an implicit-submit "Add root" button, and a separate `#roots-done` button.
  These two buttons are currently NOT laid out on one row with a size-fit "Done" — that's CSS-only
  today, no explicit flex row in the markup/CSS (needs to be added).
- `renderRoots()` (app.js:67-82): when `roots.length === 0`, replaces `#roots` with the text
  "No discovery roots configured." and forces `settingsEl.open = true`. There's no separate
  "no discovery roots" section wrapper distinct from this — it's just plain text inside the
  `<summary>`. (The ask's "remove the section wrapper" item may be describing a different visual —
  worth confirming with a screenshot, flagged in Open Questions.)
- `renderPackageBanner()` (app.js:162-176) builds the "Plan Docs workflows are not enabled" banner
  into `<section id="package-banner" class="package-banner" hidden>` which sits INSIDE `<main>`,
  after the `<details class="settings">` block and before `#warnings`/`#groups`
  (index.html:46-48). It is not full-bleed today — it inherits `<main>`'s padding.
- Discovery-root scanning is server-side in `modules/plan-docs/index.mjs`:
  - `discoverRepositories()` (index.mjs:65-93) loops `settings.discoveryRoots`, and for each root
    calls `immediateChildren(root, ignored)` (index.mjs:172-184) — **only the root itself and its
    direct child directories** are checked via `candidateRepository()` (index.mjs:186-200), which
    tests for a `.git` dir OR a `docs/plans` dir. This is the exact rigidity the ask flags: it
    cannot find a repo nested more than one level under a discovery root, and it does not stop at
    the first `.git` it finds — it just checks two fixed levels.
  - `DEFAULT_IGNORED` (index.mjs:9) is `["node_modules", ".git", "vendor", "dist", "build"]` —
    used only inside `immediateChildren` to skip listing those dirs as repo candidates, not as a
    traversal-abort signal.
  - `discoverPlansInRepository()` / `walkPlans()` (index.mjs:202-237) is the SEPARATE recursive
    walk that finds `.md` files under `docs/plans` once a repository root is already known — this
    part is unaffected by the rewrite; only `discoverRepositories`/`immediateChildren`/
    `candidateRepository` need to change.
  - `MAX_REPOS = 250` (index.mjs:11) already caps total repos found; no existing depth or time cap
    on the walk itself.
- Filters state (`app.js:3-15`) is a flat `state.filters` object with 8 keys (`search` +
  `repository/lifecycle/priority/blocked/readiness/review/health`), wired generically in the loop
  at app.js:42-48. `populateFilters()` (app.js:89-97) rebuilds all 6 `<select>` option lists from
  the snapshot on every `applySnapshot()`.
- Validation on add-root: `document.getElementById("root-form")` submit handler
  (app.js:30-39) POSTs directly to `/api/plans/settings` with the raw input value; no client-side
  existence check. Server-side, `updatePlanSettings()` (scripts/cli/plans.mjs:32-36) calls
  `normalizeRootInput()` (modules/plan-docs/index.mjs:56-63), which DOES call `fs.statSync` and
  throws `"discovery root must be a readable directory"` if it's not a directory — so server-side
  validation already exists and already rejects bad paths (returns an error the POST promise
  rejects with, caught by `.catch(showError)`). The ask is specifically about doing this check
  **before adding to the list / earlier feedback** — currently the error only surfaces after the
  round trip, and a failed add still clears... (need to verify: does `input.value = ""` run before
  or after error? — see app.js:34-38: `.then()` clears input, `.catch()` calls `showError`, so a
  failed add does NOT clear the input today, which is correct behavior already). Confirm exact UX
  gap with user before building (see Open Questions).

### `/telemetry` (`portal/telemetry/index.html`, `portal/telemetry/app.js`)

- `#meta` (index.html:23, class `page-status meta`) is the first element in `<body>`, ABOVE
  `.filterbar` (index.html:24-37) which holds the time-range buttons and harness filter — so
  today the meta line is visually and structurally above the filter it's actually scoped by.
  (Note: working tree currently has an uncommitted formatting-only diff on this file that already
  reordered indentation but did NOT change this element order — confirmed via `git diff`.)
- Content is built in `load()` (app.js:75-77):
  `"{captures} captures · {sessions} sessions · spike ≥ {threshold} tok · ~{5h tok} tok last 5h / ~{7d tok} last 7d (local estimate){scope}{harness label}"`
  — a single dot-separated string, one `textContent` assignment, no per-field markup.
- `spike_threshold` comes from the server response (`data.spike_threshold`), it is a **computed
  value** (not a fixed constant) — need to confirm exact computation server-side before writing
  copy that explains it (flagged in Open Questions; likely statistical, e.g. percentile-based, in
  the telemetry aggregation module).
- `usage_windows.five_hour` / `usage_windows.seven_day` are rolling local token-usage estimates.

## Proposed Behavior

### 1. Global: full-page loading, page-local status content (all 3 pages)

- Remove the "loading… → overwritten with content" dual-purpose `.page-status` element from all
  three `index.html` files.
- Add a full-page loading overlay (new shared markup/CSS in `portal/shared/base.css` +
  `portal/shared/theme.js` or a small shared partial each page includes) that:
  - covers the viewport on initial load
  - is hidden once the page's first data fetch resolves (success OR handled error state)
  - is NOT reused for subsequent polls/refreshes — only first paint
- Each page keeps its own status/metadata content, but as **plain in-page markup** near where it's
  conceptually scoped:
  - `/config`: drop the "updated …" text entirely (site header already shows this via
    `portalSetUpdatedAt()`); keep per-toggle "applying…/saved/error" feedback but scope it to the
    row being toggled instead of a page-level bar (check `item-status` slot in
    `tpl-config-item` — this may already be sufficient once the page-level bar is gone).
  - `/plans`: `statusText()` (plan/repo counts) becomes a small in-page line near `<main>`'s top,
    written as static HTML with a `data-slot`-style template per this doc's global template
    guidance below, not a floating bar.
  - `/telemetry`: the `#meta` line moves BELOW `.filterbar` (see telemetry section below) and is
    restructured, not just relocated.
- Template-ize dynamically-injected HTML wherever it currently lives only as JS string
  concatenation or `el(...)` calls with no HTML anchor, favoring the existing `<template id="...">`
  + `tpl()`/`slot()` pattern already used in `portal/config/app.js` (`tpl()` at app.js:12-14,
  `slot()` at app.js:16-18). This is the concrete answer to "make templates more obvious where
  markup lives" — apply that established pattern to `/plans` and `/telemetry`, which currently
  build more raw HTML via string concatenation (e.g. `telemetry/app.js` `table()` at app.js:867-882,
  `renderInsights` at app.js:749-756) than `/config` does.
  - Scope: convert the sections this plan already touches (plans filter chips, plans banner,
    telemetry meta) to templates as they're built; a full sweep of every telemetry string-built
    panel (causes/spikes/sessions/tool tables etc.) is a larger separate effort — flag as
    out-of-scope stretch goal, not required for this plan to land.

### 2. `/config` page

- **Link icon instead of package link section:** for every config item with `urls[]`, render an
  inline external-link icon (box+arrow, e.g. `↗` or an inline SVG) directly on the item's label
  row, immediately after the item name. Remove/replace the current `url-row` text-link list.
  Icon opens `urls[0]` in a new tab (existing `target="_blank" rel="noopener noreferrer"`).
  If an item has more than one URL, only the first is exposed via the icon (matches the Plan Docs
  decision below) — document this as the new general rule for all config items with multiple URLs,
  not just Plan Docs.
- **Plan Docs: single external link:** same mechanism — expose only `urls[0]` for the plan-docs
  package item. If more than one related link is relevant, that has to be linked from the target of
  `urls[0]` itself (e.g. from its README), not surfaced as multiple portal links.
- **Dark/light mode legibility for `.panel-desc`:** adjust `--dim` usage for this specific class (or
  introduce a dedicated `--desc-dim` token) so description text is lighter in dark mode and darker
  in light mode than current `--dim` (`#a3adb8` dark / `#656d76` light) — needs a concrete new value
  pair, propose during implementation and screenshot-check contrast.
- **Bump description and section-title font sizes:** `.panel-desc` and `.panel-head h2` each go up
  one step on whatever type scale `base.css`/`config/styles.css` currently follow (inspect existing
  scale before picking exact `rem`/`px` values — don't invent a parallel scale).
- **Token Optimization "external badge":** confirmed there is no distinct badge — it's the same
  `urls[]` text-link mechanism as every other item. Resolved by the link-icon change above; no
  separate fix needed. Communicate this finding back to the user as part of the PR/changelog so the
  "what does this mean" question is explicitly answered, not just silently fixed.
- **Remove subheader update timestamp:** covered by the global loading-rework item above.

### 3. `/plans` page

- **Hide filter section entirely when there are no discovery roots.** Currently the toolbar always
  renders; gate it (or the whole filter section, per the collapsible redesign below) on
  `snapshot.settings.discoveryRoots.length > 0`.
- **Discovery-root form layout:** "Add Root" and "Done" on one row, 1rem gap between them; Done is
  a padded button sized to its own text (not flex-growing); Add Root fills remaining row width.
  CSS flex row change in `plans/styles.css` plus the corresponding markup group in
  `plans/index.html:40-44` if the current `<form>` structure needs a wrapping flex container.
- **"Plan Docs workflows are not enabled" banner → full-width top banner:**
  - Move it to be the first thing in the general page content, below the (now global) page loading
    state and below the page's own status line, but ABOVE the filter/discovery-root UI.
  - Full viewport width, flush to browser edges — this requires breaking out of `<main>`'s padding
    (e.g. render it as a sibling of `<main>` rather than a child, or use a negative-margin
    full-bleed technique keyed to `<main>`'s padding value — pick whichever is more robust given
    `base.css`'s existing layout approach; inspect `<main>` padding before deciding).
  - Give it a subtle accent background (new CSS, distinct from `.panel`/warning colors already in
    use) so it reads as a banner, not another panel.
  - Must scroll with the page (not `position: sticky`/`fixed`).
- **Discovery Root section visual distinction:** give the discovery-root UI a subtly different
  panel/section background than "read-only" or "read-primary-action" sections, so it visually
  implies "this is a different kind of control" — needs a new CSS class, not reuse of an existing
  panel variant. (First: identify what CSS classes currently represent "read-only" and
  "read-primary-action" sections in this codebase — term used by the user may map to existing
  conventions; verify before inventing new visual language.)
- **Remove section wrapper around "No discovery roots configured":** the current implementation
  (`renderRoots()`, app.js:67-82) already renders that state as plain text inside `<summary>`, not
  inside a distinct wrapped section — confirm with the user (screenshot) what wrapper they're
  seeing before making a change here; may already be resolved once the rest of this section's
  layout work lands, or may reveal a wrapper this doc's code read missed.
- **Rename "Discovery Root" → "Project Folders":**
  - UI label text: `<span class="settings-label">Discovery roots</span>` (index.html:37) →
    "Project Folders" (or similar).
  - Form label: add explicit `<label>` text "Look for docs in:" for `#root-input`
    (currently only a placeholder, no label).
  - Keep internal state/API naming (`discoveryRoots`, `/api/plans/settings`) unchanged — this is a
    display-copy-only rename, not a rename of the underlying settings schema or API contract particle
    (avoid a wide, disruptive rename across server code for a copy change).
- **Explain the scan behavior on the empty state:** when no discovery roots are configured, add
  explanatory copy describing the scan pattern
  (`[Project Folder]/**/[repo with .git]/docs/plans/`) and what folders are skipped, so a new user
  understands the model before adding their first root. Content should reflect the NEW traversal
  behavor below, not the current rigid one — write this copy after the traversal rewrite lands (or
  write it to describe the target behavior and treat both changes as one PR).
- **Rewrite repository discovery traversal** (`modules/plan-docs/index.mjs`):
  - Replace `discoverRepositories()` + `immediateChildren()` + `candidateRepository()`'s
    root/direct-child-only logic with a real recursive walk per discovery root:
    - Walk all folders under (and including) the discovery root.
    - The MOMENT a folder is found containing a `.git` entry, treat that folder as an eligible repo
      root — **do not recurse further into it** (stop descending past the repo boundary; a repo's
      internal subfolders should never be re-scanned as candidate repo roots).
    - For each identified repo root, check for `docs/plans` exactly as `discoverPlansInRepository`
      does today (unchanged).
    - Add a directory blacklist that aborts descent into any folder matching known non-repo/
      non-repo-parent patterns: extend `DEFAULT_IGNORED` (currently
      `node_modules, .git, vendor, dist, build`) — treat this as the bail-out set the ask
      describes, and consider adding more (`.cache`, `coverage`, `.next`, `.venv`, `__pycache__`,
      etc.) as "dependable escape hatches." Confirm the final list with the user before merging
      (it's a judgment call with real false-negative risk if too aggressive).
    - **Depth cap:** add a max traversal depth (proposed default: 6 levels below the discovery
      root — confirm against realistic monorepo nesting before finalizing) so a root like `$HOME`
      or `/` can't walk indefinitely.
    - **Time budget:** add a wall-clock budget for the whole `discoverRepositories()` call (e.g.
      2-3 seconds, configurable) — if exceeded, stop walking, mark the result `truncated: true`
      (reuse the existing `truncated` flag already returned by this function, index.mjs:70/92),
      and surface it through the existing `errors`/`truncated` snapshot fields already wired to
      `renderWarnings()` in `plans/app.js:153-160`. No new UI needed for this — the truncation
      warning path already exists end-to-end.
    - `MAX_REPOS = 250` stays as an additional hard cap.
  - This is a real behavior change to a function used by every `/api/plans` call — needs test
    coverage (check `scripts/test/plan-docs-check.mjs`, which already tests this module, before
    writing new tests) and manual verification against a real nested-repo layout before merging.
- **Collapsible/expandable filter section with real-time apply + active-filter chips:**
  - Convert the current always-visible `<section class="toolbar">` into a collapsible section
    (same interaction pattern as the existing `<details class="settings">` discovery-root block is
    a reasonable structural precedent, though this is a distinct new component).
  - All 7 filters (search + 6 selects) move inside the collapsible body. Filter changes apply
    in real time (already true today — the existing `input`/`change` listeners at app.js:42-48
    call `render()` immediately; keep that behavior, just relocate the controls).
  - Add a "Done" button that ONLY collapses the section — no data/apply side effect (filters are
    already live).
  - Default collapsed state: shows only (a) the active-filter chip list (if any filters are
    non-default) and (b) an "Add filters" toggle button that expands the section.
  - Active-filter chips: one chip per non-default filter (repository/lifecycle/priority/blocked/
    readiness/review/health, and probably search-text too — confirm with user whether a non-empty
    search term also gets a chip, since it's freeform text rather than a discrete selection — see
    Open Questions), each with a small remove icon that resets just that one filter to its default
    (`"all"` for selects, `""` for search) without needing to reopen the section.
  - This needs new client state (`filtersExpanded: boolean`, default `false`) alongside the
    existing `state.filters` object in `plans/app.js`.
- **Validate discovery-root folder exists before adding:**
  - Add a client-side existence check before the POST in the `#root-form` submit handler
    (app.js:30-39) — note the portal is a local Node server serving a local filesystem, so this
    needs a small server endpoint (or reuse of an existing one) the client can call to stat the
    path, OR accept the current server-side rejection (`normalizeRootInput` already throws on a
    non-directory path, confirmed at modules/plan-docs/index.mjs:60-61) and just improve the
    ERROR PRESENTATION (inline form error instead of/in addition to the shared warnings bar) rather
    than adding a new pre-flight check. Recommend the latter (reuse existing server validation,
    improve error display) to avoid duplicating validation logic client + server — confirm with
    user before building a new endpoint.

### 4. `/telemetry` page

- **Move meta content below the filter bar:** swap DOM order so `.filterbar` (index.html:24-37)
  comes first, `#meta` (or its replacement) renders after it, both still above `<main>`.
- **Redesign what's shown — replace the current 4-item dot-separated line.** Candidates to propose
  in this plan for user sign-off (per the "draft options" decision above):
  1. **Token budget remaining** — some framing of `usage_windows.five_hour` /
     `usage_windows.seven_day` against a known ceiling (needs a ceiling value; check whether one
     exists server-side already, e.g. plan-tier limits, before promising this is buildable as
     specified — flagged in Open Questions).
  2. **Activity trend vs. the filtered window's own recent history** — e.g. "captures this window
     vs. same-length prior window: +12%" — requires the server to compute a comparable prior-window
     bucket, which may not exist yet (check `/api/data` response shape server-side before
     committing to this).
  3. **Spike rate** — spikes as a fraction of captures in the current filtered window (numerator
     already available via `data.spikes`, denominator via `data.capture_count` — cheap, no new
     server work).
  4. Keep raw counts (captures/sessions) since they're cheap context, but restyle as distinct
     label/value pairs instead of a dot-separated sentence.
  - Recommend leading with whichever of #2/#3 the server can support with the LEAST new
    aggregation work — needs a quick look at the telemetry aggregation module (not yet located in
    this session) before finalizing which candidates are "free" vs. "new work." Flagged as a
    required investigation step before implementation, not a decision this doc makes.
- **Restructure into distinct label/value layout:** once content is decided, replace the single
  dot-separated string with a small grid/row of stat items, each with a label (small, dim) and
  value (larger, higher contrast) — mirrors patterns like `dataviz` skill's stat-tile guidance if
  that skill is loaded during implementation.

## Edge Cases

- Discovery root traversal hitting a permission-denied directory mid-walk: must not abort the whole
  scan — match existing `walkPlans()` error-tolerant pattern (index.mjs:217-224, catches and
  records non-ENOENT errors, continues). Same handling applies if the walk reaches an
  OS-restricted path (e.g. under `/System` on macOS).
- A discovery root that IS itself inside another already-discovered repo (nested roots configured
  by the user) — dedupe already exists via `seen` set in `discoverRepositories()` (index.mjs:69,86)
  keyed by realpath; confirm this still holds after the rewrite.
- Symlinked directories during traversal — current code does not appear to guard against symlink
  cycles in the NEW recursive walk (the old code only went 1 level deep so this wasn't a risk);
  needs an explicit cycle guard (e.g. track realpath'd visited dirs) in the rewritten walker.
- Empty search string still counts as "no active filter" — must not render a chip for it.
- Telemetry meta stat candidates that need new server aggregation should degrade gracefully (hide
  the stat, not show "undefined"/"NaN") if the server hasn't been updated yet — keep client and
  server changes in the same PR to avoid this state existing in practice.

## Explicitly Out of Scope

- Full sweep of every telemetry panel's HTML-string-building code into templates (flagged as a
  stretch goal under item 1, not required).
- Any change to `discoverPlansInRepository`/`walkPlans` (the docs/plans `.md` file walk) — only
  `discoverRepositories`/repo-boundary detection changes.
- Renaming the underlying `discoveryRoots` settings key, API field, or CLI env var
  (`ROBOREPO_PLAN_ROOTS`) — "Project Folders" is display copy only.

## Open Questions (need answers before/during implementation)

1. **"Discovery Root" section wrapper removal** — the code as read today shows the empty state as
   plain text, not a wrapped section. Get a screenshot or more specific pointer from the user to
   confirm what should be removed.
2. **Should a non-empty search string get its own removable chip** in the new filter-chip UI, same
   as the discrete select filters? (Freeform text vs. discrete selection — different UX contract.)
3. **Telemetry "token budget remaining"** — does a ceiling value exist anywhere server-side
   (plan/tier limit), or does this need to be defined from scratch (e.g. user-configurable
   threshold)? Needs a look at the telemetry aggregation server module before promising this in the
   final metric set.
4. **Telemetry "activity trend vs prior window"** — does `/api/data` (or its backing module) already
   compute anything comparable to a prior-window baseline? If not, is adding that aggregation
   in-scope for this plan or a follow-up?
5. **Directory blacklist final list** — confirm the extended bail-out set (`.cache`, `coverage`,
   `.next`, `.venv`, `__pycache__`, etc., beyond the current `node_modules, .git, vendor, dist,
   build`) before merging; false positives here silently hide real repos from discovery.
6. **Depth cap default (proposed 6) and time budget default (proposed 2-3s)** — confirm these are
   reasonable for the user's actual discovery-root layouts (how deep do their real project trees
   nest a repo under a root folder?).
7. **Config item "read-only" / "read-primary-action" section naming** — confirm these terms map to
   existing CSS classes in `plans/styles.css` (used loosely by the user; verify the actual class
   names before implementing the Discovery Root panel's distinct background).

## Suggested Sequencing

1. Global loading/page-status rework (touches all 3 pages' shared shell — do first so later work in
   each page builds on the final structure, not the old one).
2. `/config` page items (self-contained, no cross-page dependency, mostly CSS + one render-path
   change for the link icon).
3. `/plans` repository-traversal rewrite (`modules/plan-docs/index.mjs`) — server-side, land and
   test independently of the UI changes on the same page.
4. `/plans` UI changes (banner, discovery-root rename/layout/validation, filter collapse+chips) —
   depends on #1 (global shell) and benefits from #3 landing first so the new empty-state copy can
   describe the real (new) traversal behavior.
5. `/telemetry` — depends on #1; metric-content decision (Open Questions #3/#4) should be resolved
   before building the new stat layout, since it determines whether new server aggregation is
   needed first.

## Verification Plan

- `scripts/test/plan-docs-check.mjs` already covers `modules/plan-docs/index.mjs` — extend it with
  cases for: nested repo discovery (repo 2+ levels deep), stop-at-first-`.git` (no double-counting
  a repo's own subfolders), blacklist bail-out, depth cap, and time-budget truncation flag.
- Manual verification in a real browser for every UI item (per this repo's standing instruction to
  actually exercise UI changes, not just typecheck) — start the portal via its existing dev command
  and click through config/plans/telemetry in both light and dark theme.
- No existing typecheck/build step beyond repo-native test scripts — confirm current test command
  via `package.json`/`scripts/test/` before running full verification pass.
