---
id: 4eis1s6s
priority: low
next_action:
blocked_by: []
depends_on: []
related:
  - rtkmc8kf
reviewed_commit: c6051ff2
worktree: portal-home-hello-guy-greeting
---

# Greet Visitors on the Home Page

## Summary

Home should greet whoever opens the portal with the message "hello guy!". This is a deliberately
small change whose main purpose is to exercise the plan suite end to end (write, promote, execute,
review, close) on work with no design risk.

## Context

Home is the portal's default page, served at `/` from `portal/home/index.html`. Its `<main>` holds,
in order: the loading placeholder, three hidden status banners (harness, Codex hook, auto-discovery),
the greeting, the "Active Repos" heading section, the mock-data disclaimer, a warning notice, and the repo list.
Before this change, nothing on the page greeted the user.

Home is framework-less: static markup lives in `index.html`, and `portal/home/app.js` fills the
dynamic regions at runtime. `app.js` writes only into those regions by their ids (the banner
mounts, the disclaimer, the warning notice, and `home-content`); nothing rebuilds `<main>` or
removes its static children. The page's styles live in
`portal/home/styles.css`, where each banner carries a 16px bottom margin and `main.home-main`
supplies the top padding.

The loading placeholder (`portal/shared/loading-partial.html`) is an overlay positioned over all of
`<main>`. It hides once the page's first data request settles, so static content in `<main>` is
in the DOM from the start and becomes visible when the overlay hides.

Home's Playwright coverage lives in `scripts/test/portal-ui/portal-ui.spec.mjs`, in the
`repository-first portal Home` describe block. Its `Home renders the canonical repository
directory` test is the closest existing check: it opens `/` and asserts the "Active Repos" heading
is visible.

## Goals

- Home shows the text "hello guy!" every time it loads, whatever the repo, harness, or
  auto-discovery state.
- The greeting sits directly above the "Active Repos" heading. Any status banner that is showing
  stays above the greeting.

## Non-goals

- Personalizing the greeting (user name, time of day).
- Adding the greeting to any page other than Home.
- Letting the user dismiss or turn off the greeting.

## Proposed design

Add the greeting as static markup, since it never changes and needs no runtime data.

| Piece | Location | Change |
| --- | --- | --- |
| Markup | `portal/home/index.html` | A `<p class="home-greeting">hello guy!</p>` inside `<main>`, directly before the `home-heading` section |
| Style | `portal/home/styles.css` | A `.home-greeting` rule for spacing only: no top margin, and a bottom margin matching the banners' 16px. Text inherits the page's type styles |
| Test | `scripts/test/portal-ui/portal-ui.spec.mjs` | A test in the `repository-first portal Home` block that opens `/` and asserts the greeting is visible and above the heading |

Static markup adds no code to `app.js`, and the greeting renders in every state because nothing
in `app.js` builds or removes it.

With no banner showing, the greeting is the first visible content on the page; a showing banner
stays above it (see the decision log).

## Implementation plan

- [x] Add the `home-greeting` paragraph to `portal/home/index.html` directly before the
      `home-heading` section
- [x] Add the `.home-greeting` spacing rule to `portal/home/styles.css`
- [x] Add a test to the `repository-first portal Home` block in
      `scripts/test/portal-ui/portal-ui.spec.mjs` that opens `/`, finds the greeting with
      `page.getByText("hello guy!", { exact: true })`, asserts it is visible, and asserts its
      bounding box sits above the "Active Repos" heading's
- [x] Run the new test while iterating, then the full portal UI suite and the repository gate

## Validation

- Opening `/` shows "hello guy!" directly above the "Active Repos" heading.
- The new test passes when run alone and fails if the paragraph is removed from `index.html`:

```bash
npm run test:portal-ui -- --grep "greeting"
```

- The portal UI suite passes:

```bash
npm run test:portal-ui
```

- The repository gate passes. It runs the portal UI suite only when a Playwright browser is
  installed, so run the suite above directly as well:

```bash
npm run check
```

## Documentation impact

No reader-facing doc is affected. `docs/user/reference/repositories.md` describes Home as a
directory of known repos and documents its controls; a static greeting adds no control and
changes no behavior that reference covers.

## Verification

- The focused greeting test failed before the markup was added and passed afterward.
- `npm run test:portal-ui` passed all 100 tests after updating the existing banner-order assertion.
- `git diff --check` passed.
- The first `npm run check` run found an existing `UNKNOWN_PLAN_NAMESPACE` finding for
  `backlog/agent-permissions-global-audit.md`; the same focused check failed on `main`.
  At the user's request, that plan was renamed to
  `backlog/agent-config-permissions-global-audit.md`, using the declared `agent-config` prefix.
- The focused plan naming check and the full `npm run check` gate then passed. The gate ran the
  package install and Docker clean-machine phases and all 100 portal UI tests; optional Windows
  installer parity was skipped because PowerShell is unavailable.
- A portal from this worktree is running at `http://127.0.0.1:57473` with isolated temporary state.

## Not tested

- [ ] Confirm the greeting visually on the running Home page. The browser security policy blocked
      this agent from opening the local portal; the automated Chromium checks passed.

## Related plans

Checked against `main` at `c6051ff2`.

| Plan | Relationship | Notes |
| --- | --- | --- |
| `rtkmc8kf` Walk New Users Through Setup from the Home Page (backlog) | Unlanded, no conflict | Also adds content above the "Active Repos" heading. Neither depends on the other; whichever lands second places its markup relative to the other's |

## Decision Log

- **2026-10-16** — The greeting goes directly above the heading and below any status banner. A
  banner asks the user to act (fix a harness, review a hook, turn on discovery), so it keeps the
  top of the page whenever it shows.
- **2026-10-16, user decision** — Rename the unrelated permissions audit plan to use the
  `agent-config` prefix already declared in `plans-config.json`, instead of adding a new namespace.
  This resolved the repository gate's naming finding without changing naming policy.
- **2026-10-16** — Removed the untested-gate entry after the complete gate passed. Its optional
  Windows parity phase was skipped because PowerShell is unavailable and does not cover this Home
  change; the separate visual Home check remains unconfirmed.

## Open Questions

None.

## Archived

2026-10-16: Abandoned after serving as a manual QA test case for the plan lifecycle review and ship workflow.
