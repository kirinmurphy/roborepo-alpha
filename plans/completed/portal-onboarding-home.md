---
id: q7m4k2p
priority: none
next_action:
blocked_by: []
depends_on: []
related:
  - jqi1dof
reviewed_commit: 54c497ed74138218b622b53e088b447d6aaf5faf
---

# Introduce the Portal with a Lightweight Home

## Summary

Give the RoboRepo portal a real Home page that works as a first-run introduction even when no agent harnesses are installed yet.

This is a deliberately small precursor to `docs/plans/backlog/portal-repository-home-and-detail.md`. It establishes `/` as Home, introduces the four current product areas, and updates global navigation without implementing repository aggregation, repository detail, Attention, or other later dashboard behavior.

## Goals

- Make `/` a stable Home page instead of loading Agents.
- Welcome a new user with a short introduction to RoboRepo.
- Provide four obvious entry points: Agents, Plans, Tokens, and Runtime.
- Give each entry point an icon, title, and no more than two lines of explanatory copy.
- Make the entry points visually prominent without inventing one-off page colors.
- Establish a reusable highlight treatment based on the portal's shared theme tokens.
- Update global navigation to: Home, Agents, Plans, Tokens, Runtime.
- Keep the page useful when no harnesses, plans, telemetry, or Runtime processes exist.

## Non-goals

- Repository directory or repository detail pages.
- Repository-scoped navigation or global repository filters.
- Attention summaries, health warnings, or cross-domain aggregation.
- Harness installation from Home.
- Dynamic onboarding progress or first-run state tracking.
- Changing the behavior of the existing Agents, Plans, Tokens, or Runtime pages.
- Adding a new UI framework.

## Current State

The portal page manifest in `scripts/cli/portal-server.mjs` currently exposes:

| Route | Page |
| --- | --- |
| `/` | Agents |
| `/config` | Agents alias |
| `/plans` | Plans |
| `/tokens` | Tokens |
| `/runtime` | Runtime |

`portal/shared/theme.js` builds global navigation from that manifest and contains special handling that treats `/` and `/config` as the same Agents page.

The portal already has the shared pieces needed for this first Home iteration:

- `portal/shared/base.css` owns the light/dark palette and shared surface hierarchy through tokens such as `--bg`, `--panel`, `--raised`, `--line`, and `--accent`.
- `portal/shared/icon.js` provides the reusable `<portal-icon>` element and a centralized monochrome icon registry using `currentColor`.
- `portal/shared/chrome-partial.html` owns the shared header and navigation shell.
- Existing pages use framework-less HTML templates and shared ESM modules rather than a component framework.

The larger backlog story `portal-repository-home-and-detail.md` already defines the eventual repository-first Home. This plan should not duplicate that work.

## Proposed Design

### 1. Route and navigation

Change the canonical page map to:

| Order | Route | Label |
| --- | --- | --- |
| 1 | `/` | Home |
| 2 | `/config` | Agents |
| 3 | `/plans` | Plans |
| 4 | `/tokens` | Tokens |
| 5 | `/runtime` | Runtime |

`/` becomes a dedicated `home` page and remains the default portal destination.

Agents moves to canonical `/config`. The current `/` → Agents compatibility behavior should be removed because `/` now has an independent meaning.

The shared navigation should continue to derive from `PAGES`; do not create a second hard-coded nav list.

### 2. Home content

Keep the first version static and immediately useful. It should not depend on any API response or detected harness state.

Recommended structure:

```text
Welcome to RoboRepo
Manage your local agent configuration, plans, token activity, and development servers from one portal.

[ Agents ]      [ Plans ]
[ Tokens ]      [ Runtime ]
```

The welcome description should remain no more than two visual lines at the normal desktop content width.

Each destination card contains:

| Card | Purpose |
| --- | --- |
| Agents | Manage agent harness configuration, shared packages, rules, permissions, and related setup. |
| Plans | View and manage implementation plans and their lifecycle. |
| Tokens | Inspect agent-session token usage and telemetry. |
| Runtime | See local development servers and developer-runtime activity discovered by RoboRepo. |

Card descriptions should stay to one or two lines. The whole card should be a link so the four destinations read as primary navigation choices, not informational panels with small nested actions.

### 3. Highlight and icon pattern

Use one shared visual pattern rather than assigning arbitrary colors to each product area.

For this iteration:

- use the existing `--panel` surface for cards;
- use `--raised` for hover/focus elevation;
- use `--accent` for the icon treatment, focus/highlight edge, and link emphasis;
- keep borders on `--line`;
- keep text on `--ink` / `--dim`;
- reserve `--ok`, `--warn`, and `--danger` for actual status meaning rather than using them as decorative section colors.

The reusable pattern is:

```text
panel card
├── accent icon treatment
├── title
├── short description
└── hover/focus: raised surface + accent emphasis
```

If future portal work wants persistent section-specific colors, define semantic shared tokens in `portal/shared/base.css` first and reuse them globally. Do not introduce card-local hex values.

Add any missing Home/Agents/Plans/Tokens/Runtime glyphs to the existing `ICONS` registry in `portal/shared/icon.js`. Keep them monochrome, `currentColor`, and on the existing icon size scale. Do not add a separate icon library for this page.

### 4. Browser structure

Add a focused Home surface following current portal conventions:

```text
portal/home/
├── index.html
└── styles.css
```

Prefer static HTML for the welcome content and four destination cards because the first version has no dynamic state.

Only add `app.js` if the existing page bootstrap contract requires page-local JavaScript. Do not introduce JS-rendered nested markup for static Home content.

Home-specific layout and card styling belongs in `portal/home/styles.css`. Shared palette, icon sizing, and generic portal chrome remain in `portal/shared/*`.

### 5. Relationship to the later repository Home

This page is an incremental foundation, not a competing homepage architecture.

When `portal-repository-home-and-detail.md` is implemented later:

- `/` remains Home;
- the global navigation introduced here remains valid;
- the welcome/entry-point treatment may stay as lightweight orientation;
- repository directory and Attention content can be added beneath or replace the simple card grid as that plan specifies;
- no repository API or aggregation contract from the later plan should be pulled into this work early.

## Implementation Plan

### Phase 1 — Routing and global navigation

- [x] Add `{ path: "/", id: "home", title: "Home", dir: "home", default: true }` to `PAGES` in `scripts/cli/portal-server.mjs`.
- [x] Change Agents to canonical `{ path: "/config", id: "config", title: "Agents", dir: "config" }`.
- [x] Order `PAGES` as Home, Agents, Plans, Tokens, Runtime so the generated global nav follows the requested order.
- [x] Remove the `/`/`/config` Agents alias special case from `PAGE_BY_PATH`.
- [x] Remove the `/`/`/config` active-nav special case from `portal/shared/theme.js`; active state should match the canonical page path.
- [x] Confirm `roborepo web` continues opening the default page and now lands on Home.

### Phase 2 — Home page

- [x] Add `portal/home/index.html`.
- [x] Add `portal/home/styles.css`.
- [x] Add the short welcome heading and description.
- [x] Add four full-card links for Agents, Plans, Tokens, and Runtime.
- [x] Keep each card description to no more than two lines in the intended desktop layout.
- [x] Use semantic HTML and keyboard-visible focus states.

### Phase 3 — Shared visual language

- [x] Reuse shared palette tokens from `portal/shared/base.css`; add no page-local hex colors.
- [x] Use `--accent` as the first reusable product-entry highlight treatment.
- [x] Extend `portal/shared/icon.js` with any missing section icons.
- [x] Keep icons monochrome and compatible with both themes.
- [x] Verify the card treatment reads clearly in dark and light modes.

### Phase 4 — Tests and documentation consistency

- [x] Add or extend focused portal routing coverage for `/`, `/config`, and the page manifest order.
- [x] Assert Home is the default page and Agents is canonical at `/config`.
- [x] Add a browser/UI assertion for the five nav destinations and the four Home entry links if the existing portal test harness supports it.
- [x] Check docs that still describe `/` as Agents and update only references made stale by this routing change.
- [x] Leave `portal-repository-home-and-detail.md` in backlog and keep this plan related to it rather than merging the scopes.

## Validation

Use the smallest repo-native checks that prove the routing and page changes, then run the full suite because `PAGES` and shared navigation affect every portal page.

At minimum:

```text
npm run test:unit -- --filter plan-docs
npm test
```

Add a focused portal test command to `package.json` only if the repository does not already have an appropriate routed-page test owner; otherwise extend the existing owner rather than creating a duplicate suite.

Manual browser validation:

1. Run `roborepo web`.
2. Confirm the browser opens `/`.
3. Confirm the nav order is Home, Agents, Plans, Tokens, Runtime.
4. Confirm each Home card opens the expected route.
5. Confirm `/config`, `/plans`, `/tokens`, and `/runtime` still load directly.
6. Confirm Home remains complete and understandable on a machine with no installed harnesses.
7. Confirm keyboard focus is visible on every card and nav destination.
8. Check both light and dark themes.

## Verification

The plan was completed against the merged main (`roborepo-homepage` → main via PR #13):

- `npm run test:unit` — 105/105 check suites passed.
- `npm test` — 423 passed, 0 failed.
- `npm run check` — full CI gate passed, including the 14-test `portal-ui` browser suite.
- `npm run build` — pack dry-run passed.
- All plan checkboxes across Phases 1-4 are ticked; the acceptance criteria in the section below were met.

## Acceptance Criteria

- `/` renders a dedicated Home page.
- The first visible content welcomes the user and explains RoboRepo in no more than two lines.
- Home presents exactly four prominent entry points: Agents, Plans, Tokens, and Runtime.
- Every entry point has an icon, title, short description, and full-card link.
- The global nav is ordered Home, Agents, Plans, Tokens, Runtime.
- Agents is canonical at `/config`.
- The Home page works without any harness installed and does not require API data to render.
- Home uses the existing shared palette and icon system; it introduces no one-off decorative hex colors or separate icon dependency.
- Status colors remain reserved for status meaning.
- Existing deep links for `/config`, `/plans`, `/tokens`, and `/runtime` continue to work.
- The implementation does not introduce repository directory/detail or Attention behavior from `portal-repository-home-and-detail.md`.
- Relevant focused tests and `npm test` pass.

## Risks

- Moving Agents off `/` may expose stale docs or tests that still assume the root route is the config page. Search for those assumptions as part of the routing change.
- Adding decorative per-section colors now would create a visual convention without a semantic system. The initial Home should establish a reusable highlight treatment first; section-specific color tokens can be a separate design decision if they become useful across multiple pages.

## Open Questions

None required for the first implementation. The larger repository-first Home remains governed by `portal-repository-home-and-detail.md`.
