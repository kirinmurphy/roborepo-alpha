---
id: rtkmc8kf
priority: high
next_action: Run /plan-promote to settle the call-to-action design, copy for each setup step, and how Home detects when each step is done
blocked_by: []
depends_on: []
related: ["q7m4k2p", "v6lvuu2"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
worktree:
---

# Walk New Users Through Setup from the Home Page

## Summary

After a first install, Home is the first page a user sees, and it shows little more than a couple
of one-line info banners. This plan replaces those banners with an ordered set of setup calls to
action. Each one explains what a feature does, why a user would turn it on, and offers one clear
button to do so, in this order:

1. Repository observer (Runtime auto-discovery)
2. Agent harnesses
3. Plan suite
4. Token tracking

This is a tracking draft. It records the intended order and the problem; `/plan-promote` settles
the design, copy, and completion signals.

## Context

### Terms

| Term | Meaning on Home |
| --- | --- |
| Repository observer | Runtime auto-discovery: RoboRepo watches local dev servers and Docker containers and remembers the repositories they run from |
| Agent harness | A supported coding agent installed on this machine (for example Claude Code or Codex) that RoboRepo configures |
| Plan suite | The `plan-write` package and its sibling plan commands, which manage plan documents under `docs/plans` and power the Plans page |
| Token tracking | The `telemetry` package, which captures agent session usage for the Tokens page |

### Why the order matters

Each step makes the next one more useful. The observer gives Home repositories to show. Harnesses
are what the plan suite and telemetry act on. The plan suite produces plan activity that Home
lists per repository. Token tracking needs at least one harness producing sessions before it has
anything to capture.

## Goals

- Show a first-run user one coherent setup sequence on Home instead of disconnected banners.
- Present the four steps in the order above, with completed steps visibly done or collapsed.
- Explain each step in enough words that a user knows what turning it on does and what it
  observes before they click.
- Give each step one primary action that enables the feature or starts its setup.
- Keep Home usable at every point in the sequence, including when the user skips steps.

## Non-goals

- Changing how any feature is enabled underneath; the calls to action reuse existing enable
  paths.
- The first-run `/setup` route and staged package draft; plan `v6lvuu2` owns those.
- Harness installation itself; Home can point to it but does not install third-party tools.

## Current state

On a fresh machine with no repositories and auto-discovery off, `portal/home/app.js` hides the
"Active Repos" heading and leaves the content area empty. Only two notices render above it:

| Setup step | What Home shows today | Source |
| --- | --- | --- |
| Repository observer | One-sentence info notice with an "Auto-discover active repos" button. Once repositories exist but auto-discovery is off, the same notice stays above the list; with auto-discovery on and no repositories, a "No repositories yet" empty state replaces it | `tpl-auto-discovery-prompt` and `tpl-repository-empty-state` in `portal/shared/repository-sources-partial.html` |
| Agent harnesses | Info-styled copy of the Agents/Tokens warning: "Install a supported harness to add agent tools and enable token tracking", a supported-harness list, and a secondary "Check for harnesses" button | `harnessSetupPromptElement()` in `portal/shared/harness-warning.js` |
| Plan suite | Nothing. The read-only plan drawer redirects to `/plans` if a user tries to enable the package from it | `onEnablePackage` in `portal/home/app.js` |
| Token tracking | Nothing. The enable prompt exists only on the Tokens page | `portal/tokens/app.js` |

The two notices that do render are independent: neither knows about the other or about the steps
Home does not show, so the page gives no sense of sequence or progress.

## Proposed design

Home shows a setup section while any of the four steps is incomplete. Each step is a card with a
short title, a two-to-three sentence explanation, its status (to do, done, or unavailable until an
earlier step is done), and one primary action. Completed steps collapse to a single line, so a
user who has finished setup sees the normal Home page.

## Implementation plan

- [ ] Define each step's done signal and expose it to Home.
- [ ] Build the setup section and step cards with shared portal templates and theme tokens.
- [ ] Replace the current Home auto-discovery prompt and harness notice with the setup section.
- [ ] Add plan-suite and token-tracking steps that use the existing package enable paths.
- [ ] Write the explanatory copy for all four steps.

## Validation

- On a machine with no harnesses, no repositories, and every feature off, Home shows all four
  steps in order, each with an explanation and a primary action.
- Completing each step from Home moves it to done without a manual reload, and the remaining
  steps keep their order.
- With every step done, Home shows no setup section.
- Skipping any step leaves Home fully usable.
- Browser coverage for the first-run Home states is extended in `scripts/test/portal-ui/`; the
  exact specs are chosen during promotion.

## Risks

- Home, Agents, and Tokens each show setup prompts today. Changing only Home can leave three
  different messages for the same missing harness.
- Overlap with plan `v6lvuu2` could produce two first-run experiences that disagree.

## Open questions

- Where each step's done state comes from (auto-discovery setting, active harness cohort, package
  status for `plan-write` and `telemetry`), and whether Home reads them through one endpoint or
  several.
- Whether later steps are locked until earlier ones finish, or shown in order but always
  actionable.
- Whether a user can dismiss the setup section, and where that choice is stored.
- Whether the shared harness notice on Agents and Tokens adopts the new copy or keeps its own.
- How this section relates to the `/setup` route from plan `v6lvuu2`, so first-run guidance is
  not built twice.
- Final copy for each step, including what the plan suite does for a user who has never seen a
  plan document.

## Ownership with first-run setup

[[v6lvuu2]] owns the resumable staged draft, `/setup`, confirmation/apply, and initialization-complete
record. This plan owns ongoing setup guidance on Home using shared feature-readiness signals.
Home actions may enter the staged workflow or call an existing post-initialization enable path;
they must not implement a second draft/commit flow. Whether to lock later optional steps, allow
skipping, or dismiss guidance remains a promotion-time UX choice. The completed Home/onboarding
plans supply the current components, not this four-step sequence.
