---
id: portal-config-web-components-plan
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit: b8684ef
---

# portal/config/ Web Components + `<dialog>` Refactor

## Status

**Complete.** Shipped in `main`. The full five-file split
(`portal/config/state.js`, `api.js`, `templates.js`, `panels.js`, `app.js`),
all three custom elements (`portal/config/elements/bucket-control.js`,
`config-item.js`, `config-toggle.js`), and the `<dialog>` migration
(`portal/config/panels.js`, `portal/config/index.html`) landed as designed.
Retained as a record of the file-split map and custom-element verdicts.

## Context

Follow-up to `docs/plans/portal-web-components-dialog-plan.md` (the `portal/plans/`
refactor), which explicitly deferred `portal/config/` and `portal/telemetry/` as
separate work. This plan covers `portal/config/app.js` (439 lines) only —
telemetry (1057 lines, chart-heavy, its own modal shape) gets its own plan
after this one lands and proves the pattern a second time.

Grounded in a full-file research pass (every function in `config/app.js` and
`config/index.html` classified; every CSS rule cross-checked against
`base.css`/`plans/styles.css`/`telemetry/styles.css` for duplication).

## File split

Same five-file shape as `portal/plans/`: `state.js` (pure data/logic),
`api.js` (fetch wrappers), `templates.js` (markup construction),
`panels.js` (singleton chrome-panel controllers), `app.js` (wiring only).

**state.js**: `TOGGLE_ENDPOINT`, `SECTION_TEMPLATE_ID`, `BUCKETS`,
`DRIFT_CHIP`, `resolveDriftChip(rootConfig, harness)` (extracted pure lookup
from `renderConfigFiles`), `snapshotChanged(prevSignature, snap)` (extracted
pure diff from `applySnapshot`'s dedupe — app.js keeps owning the mutable
`last` variable itself, matching how plans' app.js owns `state.snapshot`
rather than pushing mutable page state into state.js). `lastSnapshot` is
**not** a state.js candidate — it's modal-lifecycle UI state, moves into the
modal controller instead.

**api.js**: `fetchConfig()` (was `load()`'s inline GET), `fetchSource({kind,
id, harness})` (was `openSourceModal`'s inline GET, querystring-building
moves in), `toggleItem(kind, id, enabled)` (was `toggleSwitch`'s inline
POST), `applyPermission(payload)` (was `applyBucket`'s inline POST).
`applyBucket` itself stays in **app.js**, not api.js — it's
POST-plus-orchestration (call `api.applyPermission()`, then reconcile UI),
same shape as plans' `enablePackage()`.

**templates.js**: `dot()`, `badge()`, `setOptionalText()` unchanged. The
local `slot()` reimplementation gets **deleted** — replaced by importing
`portalFillSlots as fill` from shared/api.js, matching plans/templates.js
(config currently hand-rolls a subset of what the shared helper already
does). `renderStandardSection`/`renderConfigFiles`'s pure row/panel-building
halves move here, taking callback bags (`{ onInspectClick }`) the same way
plans' `cardActions`/`drawerActions` bags work — templates.js never imports
the modal directly, app.js wires the callback when calling it.

**panels.js**: the modal controller (`createConfigModal()`, see below) — the
primary content of this file, mirroring how plans/panels.js's main content
is `createInfoModal()`.

**app.js**: `render()`, `applySnapshot()`/`showError()`/`load()`,
`applyBucket()`, poll bootstrap, `renderSection()`/`renderPermissionsSection()`
(kept here — they decide *which* component to instantiate, that's wiring).

## `<dialog>` migration for `#modal`

Same mechanics as plans' `#info-modal`: `.modal-backdrop`/`.modal` div nest
collapses to one `<dialog id="config-modal">`; `showModal()`/`close()`
replace `classList.add/remove("open")`; manual Escape listener deleted
entirely (native); backdrop-click listener retargeted to the dialog element
itself (`event.target === dialogEl`, same identity check, not deleted — a
`<dialog>` IS its own backdrop area). `.modal-head`/`.modal-title`/
`.modal-path`/`.modal-close`/`.modal-body`/`.modal-footer` carry over
unchanged. `.modal-backdrop`/`.modal-backdrop.open` deleted from
`config/styles.css` (dead after migration).

**Design decision: `createConfigModal()` panel-factory in panels.js, not a
custom element.** The modal is a page singleton (one `#modal`, referenced by
ID, never cloned), never declaratively instantiated — always imperatively
driven from two call sites. Custom elements earn their keep for N-instance,
declaratively-authored units; this is neither. Reusing panels.js's existing
factory idiom (`createRootsPanel`, `createInfoModal`) keeps one controller
shape for the whole page instead of introducing a second idiom that only
differs from it in syntax.

`createConfigModal()` exposes `{ openSource(inspect, {rules, onDefaultClick}),
openSnapshot(title, path, data) }` — the two existing entry points
(fetch-then-show vs. show-already-known-data), both funneling through
internal `setHeader`/`setContent`/`setFooter`/`open` helpers. `
attachModalDefaults`'s DOM-building half moves to templates.js as
`tmpl.modalDefaults(rules, onDefaultClick)`; its `lastSnapshot?.globals?.rules`
module-global read is eliminated — app.js passes `state.snapshot.globals.rules`
in explicitly each call, removing a hidden load-order dependency between
`applySnapshot` and `openSourceModal`.

## Custom element inventory

Same test as plans': does it own real behavior beyond "filled template"?

- **`<bucket-control>`** — **strongest candidate.** `arbitraryListRow`
  duplicates `behaviorRow`'s deny/ask/allow button-building loop almost
  verbatim (same three buttons, same current/disabled logic, same
  confirm-on-loosen guard, same `applyBucket` call shape, differing only in
  payload key). This is the one candidate eliminating *actual duplicated
  logic*, not just similar markup. Properties: `.current` (bucket string),
  `.onSelect` (async callback — caller owns confirm+POST+error-routing, the
  element does NOT bake in a confirm-dialog policy since the message text
  differs by call site), `.compact` (bool). Both `behaviorRow` and
  `arbitraryListRow` shrink to constructing one `<bucket-control>` each.
- **`<config-item>`** — **clears the bar.** Same shape as `<plan-card>`: N
  instances per render, owns conditional listener wiring (inspect-click,
  toggle-swap) internally. `.item`/`.actions` properties
  (`{onInspect, onToggle}`), builds itself from `tpl-config-item` internally.
  Embeds `<config-toggle>` the same way `<plan-card>` embeds `<action-button>`.
- **`<config-toggle>`** — **weakest of the three, borderline, not a slam
  dunk.** `toggleSwitch` does own real async behavior (optimistic-disable,
  POST, success/revert), but unlike the other two there's no cross-call-site
  duplication to eliminate and no meaningful properties beyond "am I on."
  Justified mainly by `<config-item>` needing something embeddable in its
  toggle slot with its own independent lifecycle — not an independent case
  as strong as the other two. Dispatches a bubbling `config-toggle-saved`
  CustomEvent (detail: `{config: snapshot}`) rather than importing
  `applySnapshot` directly, avoiding a layering inversion (element depending
  on app.js). **If, once `<config-item>` is written, inlining the toggle
  logic turns out simpler without meaningfully complicating `<config-item>`,
  reconsider keeping `toggleSwitch` as a plain templates.js function instead
  — don't force this one into existence purely for symmetry.**

## Portal-wide CSS: what's in scope here vs. deferred

Found five real duplication/divergence targets. Scope discipline: this plan
touches only `config/styles.css` + `base.css` — telemetry stays untouched.

| Item | Action |
|---|---|
| **`.item-err` active bug** — config overrides base.css's `margin-top: 6px` with its own `3px` (config/styles.css:191-193 vs base.css:234-241), a real live divergence, not a look-alike | **Fix now.** Delete config's override, inherit base.css's version (including the `:empty{display:none}` rule config currently lacks). Verify visually — if 3px was intentional, it'll show as a regression during Playwright verification, resolved by observation not guesswork. |
| **`.panel`** — 3 independent copies (config, telemetry, byte-identical for config vs. telemetry's 4-property subset; plans' `.settings`/`.filters` structurally different, not a clean match) | **Hoist the config/telemetry-identical subset to base.css now.** Config touches a class name telemetry already uses unchanged — safe, doesn't leave telemetry half-migrated. Telemetry's own now-redundant `.panel` rule stays (dead CSS, not broken) until telemetry's own follow-up removes it explicitly. |
| **Modal-chrome class names** (`.modal-head`/`.modal-close`/`.modal-body` — same names config keeps post-migration, same names plans left behind pre-migration but hasn't cleaned up) | **Defer to telemetry follow-up** — hoisting now means guessing a shared shape from one still-migrating page and one already-migrated-not-cleaned-up page; needs telemetry's actual final shape too. |
| **Pill/badge components** (config's `.badge`/`.badge-skill`/`.badge-cmd`/`.drift-chip`, plans' `.chip`/`.filter-chip` — 4+ variants, real structural differences) | **Defer.** Collapsing now risks the wrong shared shape without telemetry's own badge-like elements accounted for. |
| **Text-link buttons** (config's `.reset-link`/`.text-link`, telemetry's `.linkbtn`) | **Defer**, same reasoning — config shouldn't unilaterally pick a name telemetry may not adopt. |

Also in-scope (caused by this plan's own work, not a cross-page hoist
question): delete `.modal-backdrop`/`.modal-backdrop.open` from
`config/styles.css` once `#modal` becomes a `<dialog>` — config's own
cleanup.

`{{HEAD}}` partial adoption for config is a trivial, independent pickup in
this same effort — the server mechanism (`renderHead(page)` in
`portal-server.mjs`) is already generic and config is already a registered
page; just replace config's `<head>` with the `{{HEAD}}` marker.

## Migration sequencing

Each step isolated, verified via real `roborepo serve` + headless Playwright
before the next, none batched:

1. **File split** (state/api/templates/panels/app), no behavior change —
   mechanical extraction, `slot()` deleted for `portalFillSlots`. Verify:
   page loads, every section renders identically, toggle a package/skill,
   apply a permission bucket, open the source-inspect modal (still old
   markup at this point) — zero regressions before touching structure further.
2. **`.item-err` fix** — tiny, isolated. Verify error spacing in both
   themes, empty-slot collapse behavior.
3. **`.panel` hoist** to base.css — isolated from dialog/element work.
   Verify every `.panel`-classed section renders unchanged both themes;
   separately re-check telemetry's own `.panel` usages are visually
   unchanged (telemetry untouched but now overlapping base.css's rule).
4. **`{{HEAD}}` partial** — independent, can land anytime. Verify title/
   stylesheet/no-flash/token-still-injected, plans/telemetry unaffected.
5. **`<dialog>` for `#modal`**, alongside old markup first, not removed
   until proven. Verify **both** entry points (`openSource` via
   inspect-click or config-files grid click; `openSnapshot` via the
   defaults-menu), `::backdrop` both themes, Escape, backdrop-click,
   inside-click no-close, footer show/hide correctness across both entry
   points, no console errors. Then delete old markup/CSS/JS.
6. **`<bucket-control>`** — touches `behaviorRow` and `arbitraryListRow`
   together (the point is eliminating their shared duplication in one step).
   Verify: click each bucket button, confirm correct POST payload shape per
   call site, UI updates (current/disabled), deny→other confirm-dialog still
   blocks POST on Cancel, reset/remove still works.
7. **`<config-toggle>`** — verified standalone if feasible (mount from
   `renderStandardSection` before that function is itself componentized),
   otherwise land with step 8 if genuinely inseparable — decide once
   written. Verify on/off toggle, optimistic-disable in flight, success
   re-render, failure revert + error text.
8. **`<config-item>`** — last among elements (embeds `<config-toggle>`,
   mirrors `<plan-card>` being last since it embeds `<action-button>`).
   Verify full row render, inspect-click still opens modal, toggle still
   functions post-componentization.

Steps 6-8 not batched with step 5 or steps 2-4.

## Verification

Same Playwright-against-real-server pattern already established:

- `roborepo serve`, `page.goto("/")`, wait for `#page-loading` to clear.
- `console`/`pageerror` captured every step, standard not exceptional.
- `request`/`response` captured for steps 1, 6, 7, 8 — custom-element
  property setters re-triggering `render()` unexpectedly is a real risk
  class plain functions didn't have.
- Assert real DOM state post-interaction (e.g. bucket button's actual
  `classList`/`disabled`, not "a handler ran").
- Toggle `data-theme` mid-script for step 5.
- **Two-entry-point modal check** (step 5): script both `openSource` and
  `openSnapshot` in the same pass, confirm no stale footer/content bleeds
  between them.
- **Permission bucket check** (step 6): `page.on("dialog")` for the
  confirm — Cancel leaves POST unfired (verify via request listener),
  Accept fires it and updates DOM; separately verify arbitrary-command
  bucket change and reset/remove.
- **Toggle check** (step 7): on/off, POST body shape, in-flight state,
  simulated-failure revert + error text (post-item-err-fix spacing).
- **Config-files grid check**: all six `[data-config-kind]` buttons open
  correctly; drift chips render correctly per `DRIFT_CHIP` state (needs a
  fixture/mock covering all five states — a live dev environment won't
  naturally exercise all of them).
- Each step's script isolated before the next; one final full-pass
  regression script after all 8 steps land.

## Explicitly out of scope this pass

Do not hoist modal-chrome names, pill/badge components, or text-link buttons
— all deferred to telemetry follow-up per the CSS section above. Do not
treat `<config-toggle>` as an obvious win — reconsider inlining it if
`<config-item>`'s slot logic turns out simple once written. Do not
componentize `dot()`/`badge()`/`setOptionalText()`/dispatch functions — no
owned behavior. Do not give `<bucket-control>` its own confirm-dialog policy
— caller-owned, message text differs by call site. Do not attempt telemetry
in this pass — separate plan, larger, different modal shape. Do not cache
`renderHead()`'s per-request read — matches existing no-cache pattern. Do
not add `attributeChangedCallback`/`observedAttributes` to any new element —
re-render model is always "set property, re-render whole node."
