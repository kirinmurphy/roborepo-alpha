# Telemetry

Telemetry is RoboRepo's local, opt-in usage analysis system. It captures per-tool-call facts from
Claude and Codex hooks, turns them into deterministic conclusions (token spikes, testing behavior,
loops, cost breakdowns), and lets a user mark configuration changes and compare sessions before and
after them. Everything lives in local JSONL/JSON files under the RoboRepo state directory; nothing
leaves the machine during normal capture and analysis. The optional `--deep` report passes a
computed summary to an available AI CLI, as described below.

## Turning It On

Turn on **Token Activity Tracking** in portal Settings or on the Tokens page. This enables the
telemetry package, installs its capture
hooks, and turns capture on. The CLI entry point, `roborepo telemetry enable`, performs the same
action. Start a new local coding session in the desktop app after enabling it so the session loads
the hooks.

Turning tracking off in the portal, or running `roborepo telemetry disable`, stops capture; the
portal can still browse data captured earlier. Capture is off by default because the spool grows
with every session.

**Telemetry-only install.** `roborepo telemetry install` sets up capture without the rest of
RoboRepo: it wires only the capture hooks into `~/.claude/settings.json` and `~/.codex/hooks.json`
and turns capture on. Use it to measure baseline token usage before adopting the full suite; running
the normal install later upgrades it.

**Codex hook trust.** Codex runs only hooks you have trusted. After enabling tracking, Codex may
ask you to trust `~/.codex/hooks.json`; approve it if prompted. Codex loads hooks at session start,
so sessions that were already running do not capture. Start a new session in the app; a full app
restart is not part of normal setup.

## Capture

Capture runs from the harness hooks `SessionStart`, `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, and `Stop`. Each capture (schema v3) carries:

- timestamp, harness, event, session ID;
- hashed working directory and repository identity (root hash, remote hash, branch, short SHA);
- tool metadata (name, MCP server/tool, command hash/size, file extension/path hash — never a raw
  command or path);
- best-effort call-paired duration (`call_id`-keyed, so concurrent/nested calls never clobber each
  other's start stamp);
- a reference to the session's effective configuration snapshot (`config_snapshot_id`);
- for shell commands only, a semantic `operation` classification (category — test, lint, typecheck,
  build, format, install, git, serve, read, or other — plus runner/scope/target/exit-status/
  failure-signature; never the raw shell command);
- an inferred `phase` (discovery/implementation/debugging/verification/finalization/unknown, with
  confidence and classifier version);
- `intervening`-work signals (edit-since-last-test — an edit tool ran, including Codex's
  `apply_patch`, or the working-tree diff changed since the previous test run started — plus
  changed-file count/categories, diff fingerprint change, targeted-test-since-last-full,
  failure-signature change) — all hashes/booleans/counts, never diff content;
- transcript-derived token counts, prompt size/hash/preview, and the tool result size that most
  recently entered context (size only, never content).

Records are appended to per-harness JSONL spools (`telemetry/spool/<harness>.jsonl`), capped at
~25MB each (oldest lines trimmed, newest ~70% kept). Older schema-v2 records remain readable
— every reader treats the spool structurally rather than gating on `.schema`.

## Markers

A marker is an immutable, append-only event: `change`, `phase`, `outcome`, `experiment-start`,
`experiment-end`, or `note`. Corrections append a new marker referencing the original via
`supersedes` rather than editing history.

```sh
roborepo telemetry mark --type change --title "Prevent full-suite debugging loops" \
  --package test-harness --skill test-harness \
  --metric test.full_suite_calls_per_debug_phase --expect decrease
```

`--type` and `--title` are required. Repeatable/optional flags: `--package`, `--skill`, `--tag`,
`--metric`, `--expect increase|decrease|no-change`, `--description`, `--session`, `--phase` (phase
markers only), `--status` (outcome markers only — `successful`/`partial`/`failed`/`abandoned`/
`unknown`), `--supersedes`, and for outcome markers `--task-category`, `--files-touched`,
`--directories-touched`, `--insertions`, `--deletions`. Repository, branch, SHA, timestamp, and a
deduplicated configuration snapshot are always resolved automatically — a caller cannot override
machine-derived identity fields.

An outcome marker is the only place `Stop` alone is never treated as success: outcome must be set
explicitly. Task category and scale on an outcome marker are recorded as `explicit` when set via the
CLI; they are never inferred.

## Experiments

```sh
roborepo telemetry experiment start --title "Test-harness guidance v2" \
  --metric test.full_suite_calls_per_debug_phase --expect decrease \
  --guardrail outcome.completion_rate --minimum-sessions 10

roborepo telemetry experiment end <experiment-id>
roborepo telemetry experiment status [<experiment-id>]
```

| Command | What it does |
| --- | --- |
| `start` | Creates the experiment definition and its `experiment-start` marker together |
| `end <id>` | Appends an `experiment-end` marker and links it to the experiment |
| `status [<id>]` | Reports lifecycle state, definition, cohort sizes, effect size, confidence, and whether the result is `ready` — never a provisional winner |

A result is ready when:

- the primary metric computed for both the before and after cohorts around the start marker;
- both cohorts meet `eligibility.minimum_sessions_per_cohort` (default 10); and
- no serious data-quality issue was flagged (one session dominating a cohort, or excluded sessions).

## Configuration snapshots

Snapshots are content-addressed (`cfg_<24-hex>`, hashed from normalized packages/rules/skills/hooks/
commands/feature-flags — session-specific fields like `harness`/`model`/`created_at` are excluded
from the hash) and deduplicated on write. One is built per session at `SessionStart` and referenced
by every later capture in that session. Details a snapshot cannot read (full hook command strings,
MCP server registration detail, parsed Codex `config.toml`) are recorded as `unavailable` rather
than guessed.

## Cohorts, metrics, and comparisons

**Metrics registry** is the single source of truth for every
metric formula, unit, and directionality used by the CLI report, the portal, alerts, and experiments
— UI components never define their own formulas. 26 metrics across six groups: tokens, time, calls,
testing, outcome, reliability. Each metric declares `direction_good` (`lower`/`higher`/`neutral`) and
a `minimum_sample` below which a value is technically computable but should be treated as
low-confidence. Robust summaries (trimmed mean, median, percentile) are used for heavy-tailed
token/duration distributions rather than plain averages.

**Cohort filter** is a normalized object shared by the CLI and
portal: `time`, `harnesses`, `models`, `repos`, `packages`/`skills` (exposure, resolved via
`config_snapshot_id`), `operations`, `phases`, `outcomes`, `task_categories`, `snapshot_ids`. The same
filter object scopes every panel — no panel-local filter silently redefines the global cohort.

**Marker-relative comparison** is the preferred way to answer "did this change something". Given a
`change` marker, sessions are split into before and after cohorts, dropping sessions that span the
marker. The cohorts are equalized (by session count or duration) and compared per metric. Every comparison reports cohort sizes, excluded-session reasons, effect size,
and a confidence label:

- **strong signal** — both cohorts ≥20 sessions, no serious data-quality issue;
- **emerging pattern** — computable, but below the strong-signal session floor;
- **insufficient evidence** — either cohort below the minimum session count, or the metric didn't
  compute;
- **data-quality warning** — one session dominates a cohort (>40% of its captures), or sessions were
  excluded for spanning the marker.

When no marker is selected, an earlier-vs-later **midpoint regression** is shown instead, labeled
*exploratory* in both the portal and CLI because it is not tied to any specific change.

Every comparative finding has the same parts:

- **Observation** — what changed
- **Evidence** — cohort sizes and effect size
- **Interpretation** — labeled as inference
- **Next action**, **confidence**, and any **data-quality issues**
- The exact cohort and metric, so the portal's "open analysis" action can reproduce it

No finding claims a package, skill, or rule *caused* a result; the wording stays at "exposed to" or
"correlates with."

## Package telemetry policies

A package's `package.config.json` may declare `telemetry.policies`:
`[{ metric, operator, value, minimum_samples, severity }]`. RoboRepo checks each policy's shape
(known metric, valid operator, numeric threshold), then evaluates it:

| Result | When |
| --- | --- |
| `satisfied` | The metric meets the threshold |
| `violated` | The metric misses the threshold |
| `insufficient-samples` | Fewer sessions than the policy's `minimum_samples` |
| `unknown` | The metric has no value for these sessions |

Policies are advisory: nothing blocks a command or tool call. No built-in package declares
policies yet.

## CLI report

`roborepo telemetry report` prints, in order: insights (each with confidence and a next action),
data-quality warnings, read warnings, recent markers, experiment readiness, usage windows, testing
efficiency, cost breakdowns, the exploratory midpoint regression, loops, sessions, spikes, and raw
contributor tables.

`--deep` adds an LLM summary of those findings. It tries the installed Claude, Codex, and Gemini
CLIs in that order and invokes the first available one with `-p`. Only the computed summary is
passed to that CLI, never raw capture or transcript content.

The report and the portal share one analysis and metric registry, so their numbers agree for the
same cohort.

## Portal

The `/tokens` page uses the same analysis data as `roborepo telemetry report`, adding interactive
condition comparisons, event history, and change records. It refreshes every 5 seconds. See the
[Telemetry Walkthrough](../guides/telemetry.md) for how to read it.

## Privacy

By default, telemetry keeps derived facts instead of raw content:

| Never stored | Stored instead |
| --- | --- |
| Full prompts | Size, hash, and a 200-character preview |
| Shell commands | Hash, size, and a semantic category |
| Tool results and transcripts | Sizes only |
| Absolute paths | Hashes |
| Failure output | A failure-signature hash; the text used to compute it is never written |

- Estimated token and cost figures (~4 characters per token) are labeled as estimates, apart from
  counts the provider reports.
- `telemetry export`, `backup`, and `purge` cover markers, snapshots, and experiments along with
  the capture spool; `purge --backup` keeps a recoverable copy.
- The portal server binds to loopback only.

## Retention

Every telemetry store trims itself as it is written. Nothing runs on a schedule, and no data is
removed while you are not using the tool.

| Store | Path under `<stateRoot>` | Bound |
| --- | --- | --- |
| Capture spool | `telemetry/spool/<harness>.jsonl` | 25MB per harness |
| Markers | `telemetry/events/markers.jsonl` | 5MB |
| Configuration snapshots | `telemetry/snapshots/` | 5MB total |
| Experiments | `telemetry/experiments/` | 5MB total |

None of these expire by age. The spool is the durable record rather than a queue — nothing drains it
after analysis — so an old capture is still the only copy of that session, and only size bounds it.

- **Trims overshoot.** A store at its cap drops to roughly 70% rather than to exactly the cap, so a
  trim happens rarely instead of on every subsequent write.
- **A running experiment is never removed.** An experiment with no `end_marker_id` is still live and
  its end marker will reference it, so only finished experiments are eligible for eviction.

Markers, snapshots, and experiments sit three to four orders of magnitude below their caps in normal
use; those bounds exist to stop a runaway, not to manage everyday growth.

Inspect current sizes, or reclaim space early, with:

```
roborepo maintenance stores
roborepo maintenance stores reset telemetry-spool-claude
roborepo maintenance stores reset telemetry-spool-claude --all
```

`reset` applies the store's own policy; `--all` clears it outright. `telemetry purge --all` remains
the way to remove every telemetry store at once, and `purge --backup` keeps a recoverable copy.

## Schema versions

| Record | Schema field | Current version | Notes |
| --- | --- | --- | --- |
| Capture | `schema` | 3 | v2 records remain readable; readers never gate on `.schema`. |
| Marker | `schema` | 1 | |
| Configuration snapshot | `schema` | 1 | Content-addressed id (`cfg_<24-hex>`). |
| Experiment | `schema` | 1 | |

## Related

- [Telemetry Walkthrough](../guides/telemetry.md) — what the portal pages show.
