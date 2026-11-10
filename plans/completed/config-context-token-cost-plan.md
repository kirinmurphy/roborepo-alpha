---
id: config-context-token-cost
priority: medium
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit: 1213b58bbdeaf52b59424b2741d49d524411a538
---

# Config Page Context and Token Cost Plan

## Completion Summary

All implementation and automated-test success criteria are met as of commit `1213b58`.
Manual visual QA (light/dark theme, narrow viewport, live toggle-updates-totals) was skipped by
explicit user decision rather than performed — the reviewing session had no screenshot or
browser-automation tool available. Confidence instead rests on: `test:context-cost` (13/13
checks, boundary/reconciliation/cache cases included), `test-roborepo.sh` `/api/config`
contextCost assertions, and a live `GET /api/config` fetch against the running portal confirming
the documented data shape (method, thresholds, per-harness breakdown, components) is populated
correctly. If a rendering regression exists (CSS, badge layout, toggle wiring), it would not be
caught by this evidence — flag for a follow-up visual pass if UI bugs are reported later.

## Implementation Status

- [x] `scripts/cli/context-cost.mjs` — estimator (`ceil(chars/4)`, `estimated-v1`), thresholds constant, collectors, aggregation, stat-signature cache (same-object cache hits keep the portal `snapshotChanged` skip working)
- [x] Snapshot wiring — `snapshot.contextCost`, `section.contextCost` rollups, `item.contextCost` in `packagePresentationItem`; permissions section labeled `not-prompt-context`
- [x] Portal — `tpl-context-summary` first panel, Generated Files cost chips (Rules counts, Config `Not prompt context`, Hooks `Conditional`), section header rollups, muted per-item cost badges in `<config-item>`
- [x] Tests — `scripts/test/context-cost-check.mjs` (11 checks incl. 7999/8000/20000/20001 boundaries, reconciliation, cache invalidation) + `npm run test:context-cost`; `/api/config` contextCost asserts in `test-roborepo.sh`
- [x] Docs — "Harness Context estimates" section in `docs/user/reference/config-control-panel.md`
- [x] Manual portal verification — skipped by user decision; no screenshot/browser-QA tool
  available in the reviewing session. Verified instead at the API/data level: portal server
  running, `GET /api/config` returns populated `contextCost` (method, thresholds, per-harness
  breakdown, components) matching this plan's data model; full `test:context-cost` suite (13
  checks) passes against commit 1213b58. Visual rendering (themes, narrow width, live
  toggle-updates-totals) was not eyeballed in a browser.

Implementation decisions of note:

- Skill discovery cost = frontmatter `name: description`, counted startup only when the
  package is enabled AND the skill is installed for that harness (`basis:
  "skill-discovery-metadata"` — labeled estimate of harness startup metadata).
- Skill-backed slash command discovery folds into the skill's discovery entry; the wrapper body
  counts on-demand (via `loadSlashCommandPlan()` in-memory content), so package on-demand =
  SKILL.md + wrapper with no double counting.
- Per-item display numbers are the max across harnesses with a `harnessesDiffer` flag.
- Threshold sanity check against this machine's real config: Claude startup ~2.5k, Codex ~2.5k
  → both `low`; thresholds (8k/20k) leave sensible headroom for heavier package sets.

Post-review UI revisions (user decisions, superseding this plan's original UI spec):

- The "On-demand installed" harness column and the section rollups' "· on demand ~X" segment
  were removed — a sum over skill bodies that never load together is noise. Section rollups
  show `Enabled startup ~X (· +~Y if all enabled)` only.
- Per-package single-invocation cost is instead rated on a dedicated skill-size scale
  (`ON_DEMAND_LEVEL_THRESHOLDS`, low < 1k / medium 1k–3k / high > 3k) with a colored chip on
  the item row for medium (warn) and high (danger) only; low renders no chip.
- Active rollups honor install state per harness (`enabled && installed`), so section sums
  reconcile exactly with `breakdown.packageRulesTokens + skillDiscoveryTokens`.
- The startup chip tooltip now reveals the formula: rendered rules (core baseline + package
  rules) + discovery metadata.
- The "Harness Context" panel was replaced by a one-row "Tokens used in config" bar using a
  new shared `<token-chip>` web component (`portal/shared/token-chip.js` + base.css styles):
  solid level-colored background, ⓘ icon, hover/click tooltip with a contributing-amounts
  table (System rules / Package rule snippets / Skill discovery descriptions / Total). The
  same chip renders on the Generated Files rules cells and in the source-inspect popup header
  (rules → rendered-rules cost; skills/commands → single-invocation cost).
- Chip styling switched from border+transparent to solid background with contrasting ink
  (`--chip-ink`, `--chip-muted-bg/-ink` palette vars, both themes).
- Dark-mode readability: text that used the `--off` fill shade (modal path, behavior default,
  panel footnote, source-empty, clickable underline) now uses `--dim`.
- Later warning-panel follow-up: the top context bar moved into the agent files table as a
  `Usage` row, low/green rules-file chips were suppressed, medium/high warnings render above the
  table sorted by severity and percent-of-high-threshold, and skill discovery warnings include an
  info tooltip explaining aggregate vs. individually large discovery descriptions.
- Thresholds now live in `manifests/platform/context-cost-thresholds.json` with separate scales
  for startup payloads, rendered rules, rule fragments, skill discovery metadata (same threshold
  values as Chat-Time Output snippets), and on-demand skill/command loads.

## Goal

Add token-cost visibility to the Config page so a user can see:

- the estimated harness context loaded at chat startup;
- whether that startup payload is low, medium, or high;
- each enabled package's contribution;
- totals for each Config section;
- separate costs for content loaded only when a skill, command, hook, or tool is invoked.

The page should not add every file shown on Config into one misleading number. Some files are always included in chat context, while others are settings, executable automation, or conditional content.

## Page and Code Identified

The Config page is the portal root:

- `scripts/cli/portal-server.mjs`
  - `PAGES` maps `/` to the Config page.
  - `/config` is a stable alias for the same page.
  - `GET /api/config` returns the Config snapshot.
- `portal/config/index.html`
  - Holds templates for Generated Files and the package sections.
  - `#main` is populated entirely by JavaScript.
- `portal/config/app.js`
  - Polls `/api/config` every 10 seconds.
  - Renders Generated Files first, followed by `snapshot.behaviorView` sections.
- `portal/config/templates.js`
  - Converts the server model into section and Generated Files DOM.
- `portal/config/elements/config-item.js`
  - Renders each package row, including its existing badge slot.
- `portal/config/styles.css`
  - Defines the one-column, 960px-wide page layout, panels, rows, and badges.
- `scripts/cli/config.mjs`
  - `readConfigSnapshot()` marshals packages, rules, live files, hooks, settings, and permissions.
  - `buildBehaviorView()` is the single server-side presentation model used by the web page and terminal UI.
  - `packagePresentationItem()` produces each standard section row.
- `scripts/cli/rules-render.mjs`
  - Already renders the exact baseline and enabled-package rule payloads used in `CLAUDE.md` and `AGENTS.md`.

The implementation should preserve this architecture: calculate token data on the server, attach it to the snapshot and `behaviorView`, and keep the browser responsible only for display.

## Define What Is Being Measured

Use two cost classes:

| Class | Meaning | Examples |
| --- | --- | --- |
| Startup context | Included automatically at the beginning of a chat | Rendered `CLAUDE.md`/`AGENTS.md`, enabled package rule fragments, skill/command discovery metadata if the harness exposes it in context |
| On-demand context | Added only after a relevant action | Full `SKILL.md`, full slash-command workflow, hook output, MCP tool result |

Do not count these as prompt tokens merely because Config displays them:

- `settings.json`, `config.toml`, and `hooks.json` configuration syntax;
- hook scripts that execute outside the model context;
- disabled packages;
- the same rule fragment twice because it appears in both a package row and the rendered rules file.

Hooks need a conditional cost: count only text actually injected into the model when the hook fires. MCP packages need two separate concepts: tool-definition/schema context, when measurable, and variable tool-result tokens. Do not estimate arbitrary future tool results.

## Recommended User Interface

### 1. New first panel: Harness Context

Insert this before Generated Files.

Show one result per harness because Claude and Codex receive different rendered rules and may expose different skill/tool metadata:

| Harness | Startup payload | Rating | On-demand installed content |
| --- | ---: | --- | ---: |
| Claude | `~12.4k tokens` | `Medium` | `~31.8k available` |
| Codex | `~10.9k tokens` | `Medium` | `~29.2k available` |

Use green for low, orange for medium, and red for high. Include the word as well as color for accessibility. The main badge should read, for example, `~12.4k tokens · Medium`; the `~` prevents an estimate from looking exact.

Add short supporting text: “Startup payload is included automatically in every new chat. On-demand content is added only when invoked.”

Do not show a combined Claude + Codex total because a chat runs in one harness, not both.

### 2. Generated Files

Keep the existing first table, now second on the page. Add token badges only to prompt-bearing rows:

- Rules: Claude and Codex live-rule token counts.
- Config: `Not prompt context`.
- Hooks: `Conditional`; optionally show the known injected-output estimate where deterministic.

This prevents users from treating every generated file as equivalent context.

### 3. Section rollups

Add a right-aligned summary in each standard section header:

`Enabled startup ~1.8k · on demand ~6.4k`

Only enabled items contribute to the primary rollup. If useful, a muted secondary value can say `+~2.1k if all enabled`, but do not mix disabled costs into the active total.

Permissions should say `Not prompt context` unless Roborepo renders explanatory permission rules into `AGENTS.md`/`CLAUDE.md`. If it does, attribute that rendered text to the package/rules source that created it, not to the JSON/TOML permission entries.

### 4. Individual package rows

Reuse the existing `badges` area in `<config-item>`:

- rules package: `~420 startup`;
- auto-loaded skill: `~85 discovery` and `~2.1k when loaded`;
- slash-command workflow: `~60 discovery` and `~3.4k when run`;
- hook-only package: `conditional ~120`;
- optimization/tool package with no deterministic prompt text: `no fixed prompt cost`.

The badge title or a small popover should explain the components and estimator. Avoid using green/orange/red on every item; reserve severity colors for the total and section gauge so green does not imply that an individual package is “good.”

## Data Model

Add a pure token-cost module, for example `scripts/cli/context-cost.mjs`.

Suggested snapshot shape:

```json
{
  "contextCost": {
    "method": "estimated-v1",
    "harnesses": {
      "claude": {
        "startupTokens": 12400,
        "onDemandTokens": 31800,
        "level": "medium",
        "components": []
      },
      "codex": {
        "startupTokens": 10900,
        "onDemandTokens": 29200,
        "level": "medium",
        "components": []
      }
    }
  }
}
```

Each component should have:

```json
{
  "id": "react",
  "packageId": "react",
  "sourceType": "skill",
  "harness": "claude",
  "load": "on-demand",
  "tokens": 2140,
  "active": true,
  "sourcePaths": ["globals/packages/react/skills/react/SKILL.md"]
}
```

Attach a summarized `contextCost` to each `packagePresentationItem()` and each section in `buildBehaviorView()`:

```json
{
  "startupTokens": 85,
  "onDemandTokens": 2140,
  "activeStartupTokens": 85,
  "activeOnDemandTokens": 2140
}
```

Keep raw source paths in the server model for traceability, but the browser only needs totals, labels, and explanatory text.

## Marshalling and Attribution

Build a component inventory from the package catalog, then resolve text through the same functions and source paths used by installation/rendering.

1. Render full live startup rules independently for Claude and Codex with `renderRulesPreview(harness, enabledIds)`.
2. Render baseline and each package rule fragment separately for attribution.
3. Measure the full rendered result as the authoritative harness total.
4. Measure individual fragments for package display.
5. Reconcile fragment sums against the authoritative rendered total and expose any unattributed remainder as `core/baseline`.
6. For skills, measure separately:
   - discovery metadata that the harness actually exposes at startup;
   - the full `SKILL.md` and any files automatically loaded with it.
7. For slash commands, measure the generated wrapper plus skill body only when running the command; count any startup command metadata separately.
8. For hooks, measure only deterministic stdout inserted into context, grouped by event.
9. For MCPs, add schema counts only after Roborepo can obtain the actual tool definitions presented to the harness. Until then display `runtime-dependent` rather than inventing a number.

The full rendered rules total must not be calculated by simply summing source files. Rendering adds preambles and can normalize or deduplicate content, including the existing caveman communication collapse.

## Token Estimation

RoboRepo is currently dependency-free and supports both Claude and Codex. A single offline tokenizer cannot claim exact counts for both harnesses.

Implement the first version as an explicitly labeled estimate:

- normalize text exactly as it is passed to the harness;
- use a deterministic local estimator, such as `ceil(characterCount / 4)`;
- display rounded counts with `~`;
- include `method`, `version`, and character count in internal results so the estimator can change without changing the UI contract.

Structure the module behind `estimateTokens(text, harness)` so exact adapters can be added later:

- Codex: an optional local tokenizer compatible with the active OpenAI model;
- Claude: Anthropic's token-count endpoint when credentials and network use are explicitly enabled.

Do not call external APIs during the portal's 10-second poll. Cache results by harness, estimator version, enabled package IDs, and content hash. Recompute only when relevant source or enabled state changes.

## Qualitative Thresholds

Treat the rating as a configurable product heuristic, not a model limit. Use the percentage of a reference startup-context budget so labels remain explainable:

- Low/green: under 8,000 tokens;
- Medium/orange: 8,000–20,000 tokens;
- High/red: over 20,000 tokens.

Store thresholds in one exported constant and return them in the API metadata. Add a tooltip: “Roborepo guidance for reusable startup instructions; this is not the model's context-window limit.”

These thresholds should be validated against real RoboRepo configurations before release. An `80k` startup payload should be unambiguously High even if the selected model supports a much larger total context window.

## Implementation Steps

1. Add `scripts/cli/context-cost.mjs` with pure estimation, classification, aggregation, attribution, rounding, and cache-key functions.
2. Add source collectors that use the package catalog and existing rule/skill/command resolution paths; do not create a second package inventory.
3. Extend `readConfigSnapshot()` with top-level per-harness totals and component records.
4. Extend `packagePresentationItem()` and section creation in `buildBehaviorView()` with active startup/on-demand rollups.
5. Add `tpl-context-summary` to `portal/config/index.html`.
6. Render the summary before `tmpl.configFiles()` in `portal/config/app.js`.
7. Add summary and section-total renderers to `portal/config/templates.js`.
8. Extend `config-item.js` to render semantic cost badges from `item.contextCost`; keep status badges unchanged.
9. Add accessible low/medium/high styles and responsive layout rules to `portal/config/styles.css`.
10. Document the estimate method and startup/on-demand distinction in the Config UI and portal reference documentation.

## Tests and Verification

Add focused Node tests alongside the existing script tests:

- estimator is deterministic and handles empty/Unicode content;
- classification boundaries at 7,999, 8,000, 20,000, and 20,001;
- disabled packages do not affect active totals;
- section totals equal their active item totals;
- package rule attribution plus baseline reconciles to the full rendered rules total;
- the same content is not double-counted as both a package fragment and live rules;
- Claude and Codex totals differ when harness-specific rules differ;
- skill discovery and full skill content land in different load classes;
- config files are labeled as non-context;
- snapshot remains serializable and stable so polling does not trigger unnecessary rerenders.

Portal verification:

- summary is the first panel at both `/` and `/config`;
- all totals update after a package toggle without refreshing;
- generated Rules counts match the corresponding harness summary breakdown;
- colors pass contrast requirements and labels remain understandable without color;
- layout remains readable at narrow widths;
- source inspection still opens and toggles still work.

## Acceptance Criteria

- The first panel reports separate Claude and Codex startup estimates and low/medium/high ratings.
- Every standard section displays enabled startup and on-demand rollups.
- Every measurable package displays its own cost classification.
- Disabled package cost is visible only as potential cost and excluded from active totals.
- Settings/config syntax is never presented as chat-token cost.
- Conditional content is never silently added to the startup total.
- The authoritative startup total is based on the final rendered payload for each harness.
- Counts are consistently labeled as estimates until a harness-specific exact tokenizer is used.
- The feature adds no network request to the normal portal polling path.
