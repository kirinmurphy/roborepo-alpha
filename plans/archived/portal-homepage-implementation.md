---
id: portal-homepage-implementation-plan
priority: low
next_action: Fill in the next concrete task.
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Portal Homepage Implementation

## Purpose

Add a dedicated portal homepage at `/` that summarizes current work and actionable problems without replacing the full Config, Runtime, Plans, or Telemetry pages.

Keep `/runtime` as its own management page. The homepage receives a compact active-app view rather than inheriting Runtime's editing, alias, hidden-item, inactive-project, and settings controls.

Repository identity plumbing is specified separately in `../completed/canonical-repository-identity-plan-v2.md` (delivered). This first homepage iteration may consume canonical repository IDs where available, but it must not introduce repository-centric cards or broader cross-domain UI yet.

## Confirmed Product Decisions

- `/` becomes the portal homepage.
- `/runtime` remains the full Runtime page.
- Recent plans are determined from timestamps and use a trailing seven-day window.
- All warnings appear in one widget, divided into domain sections with one shared warning theme.
- The homepage uses the same cumulative safe-token threshold already represented by the telemetry chart.
- The threshold policy moves to shared global portal configuration; it is not copied into homepage code.
- Repository identity plumbing ships in the same undertaking, but identity-driven homepage redesign is deferred.

## Current Behavior to Preserve

- `scripts/cli/portal-server.mjs` registers portal pages and serves shared chrome and static assets.
- `roborepo serve` currently opens `/config` by default.
- `GET /api/developer-runtime` exposes cached active-instance data.
- `GET /api/plans` exposes plan lifecycle and Git metadata.
- Telemetry analysis already supports a one-week range and emits anomaly, loop, spike, and session data.
- The cumulative chart receives `cumulative_concern` from `scripts/cli/telemetry-analyze.mjs`.
- The current concern policy is:
  - `max(10,000,000, 2 × p90 session total)` when usable session totals exist.
  - `20,000,000` when no usable history exists.
- Config already computes resource context-cost warnings; the homepage must reuse that calculation.
- `roborepo doctor` and `roborepo verify` are distinct. The homepage reports doctor-style health findings and must not imply that a full verification ran.

## Homepage Information Architecture

### 1. Attention Widget

Render one warning widget with consistent colors, spacing, severity treatment, and empty/loading/error states. Divide it into labeled domain sections:

#### Token-heavy chats

- Count sessions whose cumulative token total exceeds the shared safe-token threshold.
- Scope the count to the trailing seven days.
- Show the effective threshold in the detail text or accessible label.
- Link to Telemetry with the one-week range selected.
- Avoid labeling per-turn statistical spikes as unsafe chats; these are separate signals.

#### Telemetry anomalies

- Show current telemetry warnings and anomaly flags for the trailing seven days.
- Include spikes, loops, and other existing actionable findings exposed by the telemetry analysis layer.
- Deduplicate repeated findings by stable finding ID or a deterministic compound key.
- Link to the relevant filtered Telemetry view.

#### Large agent resources

- Reuse Config's existing context-cost calculation and warning boundaries.
- Show count, highest severity, and the largest few resources.
- Link to the relevant Config section.
- Do not calculate file size or token cost independently in the browser.

#### Installation health

- Show structured doctor findings grouped by warning and error severity.
- Include the last completed check time and a manual refresh action.
- State explicitly when no check has completed or the cached result is stale.
- Link to a detailed health view or provide a compact expandable list if no dedicated page exists.

Each section remains visible when empty and displays a concise healthy state. A failure in one domain must not prevent the other sections from rendering.

### 2. Active Apps Widget

- Reuse the Runtime snapshot rather than running separate discovery.
- Show active, non-hidden projects and their active HTTP apps.
- Include project/app name, origin, status, and saved quick links when present.
- Link the widget header to `/runtime`.
- Open apps using their current Runtime origin.
- Exclude inactive projects, unmatched management details, alias controls, and settings from the homepage.
- Preserve Runtime's unsupported-platform and refresh-failure states.

### 3. Plans Summary Widget

- Show counts for active, backlog, completed, and unclassified plans.
- Highlight active plans.
- Show plans created or changed during the trailing seven days.
- Prefer the plan file's most recent meaningful timestamp:
  1. Git last-commit timestamp for that plan file.
  2. Filesystem modification timestamp when Git history is unavailable.
- Label the list `Recently changed` unless a distinct creation timestamp can be proven.
- Do not infer that the first time RoboRepo discovers a file is its creation date.
- Link entries and summary counts to `/plans`.

## Shared Global Site Configuration

Create a server-owned configuration module for portal-wide policy values. The browser receives resolved values; it does not define defaults.

Recommended shape:

```js
export const portalPolicy = {
  recentWindowMs: 7 * 24 * 60 * 60 * 1000,
  telemetry: {
    cumulativeConcern: {
      fallbackTokens: 20_000_000,
      minimumTokens: 10_000_000,
      percentile: 0.9,
      multiplier: 2
    }
  },
  doctor: {
    staleAfterMs: 10 * 60 * 1000
  }
}
```

Place this under a shared application/config boundary used by server-side portal domains. Treat it as application policy, not user-editable settings in this iteration.

Refactor telemetry's `computeCumulativeConcern` to consume this policy. Expose both the computed threshold and enough metadata to explain it:

```json
{
  "tokens": 20000000,
  "source": "fallback",
  "window": "current-filter",
  "policy": {
    "minimumTokens": 10000000,
    "percentile": 0.9,
    "multiplier": 2
  }
}
```

Make `cumulativeConcern.tokens` the canonical threshold used by `computeCumulativeConcern`, analysis responses, the telemetry chart, and Home Token usage Attention. If the legacy numeric `cumulative_concern` field remains during migration, derive it directly from `cumulativeConcern.tokens` in the response adapter rather than computing it separately. Add coverage that asserts `cumulative_concern === cumulativeConcern.tokens` for the compatibility period. Remove the numeric alias once no current consumer reads it.

## Homepage API Boundary

Add a homepage aggregation module and `GET /api/home`. The browser should make one request for initial homepage state rather than reproducing domain logic.

Suggested response:

```json
{
  "generatedAt": "ISO-8601",
  "window": {
    "rangeMs": 604800000,
    "start": "ISO-8601",
    "end": "ISO-8601"
  },
  "warnings": {
    "tokenHeavyChats": {},
    "telemetry": {},
    "resources": {},
    "doctor": {}
  },
  "developer-runtime": {},
  "plans": {},
  "partialFailures": []
}
```

Implementation rules:

- Aggregate existing service functions, not HTTP-loopback calls to the portal's own APIs.
- Run independent read operations concurrently.
- Return partial results when one domain fails.
- Give every warning a stable ID, domain, severity, title, summary, timestamp, and target URL.
- Keep absolute filesystem paths and raw telemetry prompts/results out of browser responses.
- Include canonical repository IDs only where the identity layer has resolved them.

## Doctor Integration

Extract doctor checks into a reusable structured function while keeping existing CLI text output as an adapter.

Structured finding fields:

```json
{
  "id": "stable-check-id",
  "status": "warning",
  "domain": "install",
  "summary": "Plain-language finding",
  "remediation": "Action the user can take"
}
```

Execution and caching:

- Run once when the portal starts.
- Cache the last completed result in memory.
- Refresh automatically only after the configured stale interval.
- Add a protected POST refresh endpoint using the portal's existing origin and mutation-token controls.
- Deduplicate concurrent refreshes with one in-flight promise.
- Keep the previous successful result visible if a refresh fails, while marking it stale and reporting the refresh error.
- Do not automatically run full `verify` from the homepage.

## Portal Routing and Navigation

- Register a new `home` page in the portal page manifest.
- Serve it at `/` from `portal/home/`.
- Make Home the first navigation item and ensure active-page state works at `/`.
- Change `roborepo serve`, `roborepo web`, and portal reuse/open behavior to default to `/`.
- Preserve explicit deep links to `/config`, `/plans`, `/runtime`, and `/telemetry`.
- Update docs that currently say the portal opens `/config`.

## Browser Implementation

Create:

- `portal/home/index.html`
- `portal/home/app.js`
- `portal/home/api.js`
- `portal/home/templates.js`
- `portal/home/styles.css`

Use `portal/shared/base.css`, shared chrome, theme variables, loading behavior, and accessible interaction patterns. Keep the page JavaScript focused on fetching, state, and rendering; keep all calculations and domain classification server-side.

Refresh behavior:

- Poll the aggregate endpoint at a modest interval, such as 10 seconds.
- Allow Runtime's established cache/refresh policy to govern discovery freshness.
- Do not trigger doctor on every poll.
- Update only changed sections when practical, but correctness is more important than incremental DOM optimization in the first iteration.

## Identity Integration Boundary

During this work:

- Adopt the shared repository identity resolver described in the companion plan.
- Add `repositoryId` to eligible Runtime, Plans, and Telemetry summaries.
- Preserve global and unresolved items.
- Do not group the homepage by repository.
- Do not add chat/plan counts to Runtime cards yet.
- Do not hide records that cannot be associated.

## Implementation Sequence

1. Add shared portal policy and refactor the telemetry cumulative-concern calculation.
2. Add canonical repository identity plumbing required by the companion plan.
3. Extract structured doctor checks and implement caching.
4. Add server-side homepage selectors for warnings, Runtime, and Plans.
5. Add `GET /api/home` and doctor refresh handling.
6. Register `/`, update default portal opening behavior, and add navigation.
7. Build the homepage widgets and states.
8. Update documentation and add tests.

## Validation

Add focused tests for:

- Shared concern-policy defaults and computed values.
- Chart and homepage receiving the same effective threshold.
- Seven-day boundary behavior using a fixed clock.
- Token-heavy sessions counted by cumulative total, not individual delta spikes.
- Telemetry anomaly filtering and deduplication.
- Config resource-warning reuse.
- Doctor cache freshness, refresh failure, and concurrent refresh deduplication.
- Recently changed plan timestamp precedence.
- Active-app filtering and partial Runtime failures.
- Partial homepage responses when individual domains fail.
- `/` routing, navigation state, and default open behavior.
- Origin/token protection for doctor refresh.
- No absolute paths or sensitive telemetry content in the homepage payload.

Run existing targeted suites for Telemetry, Runtime, Plans, Config/context cost, doctor, and the portal, followed by `npm test`.

## Acceptance Criteria

- Opening the portal lands on `/`.
- `/runtime` remains a full standalone management page.
- One warning widget contains separate Token usage, Telemetry, Agent config, and Health sections.
- All homepage warning data uses a trailing seven-day window where recency applies.
- The telemetry chart and homepage use one shared cumulative safe-token policy and value.
- Active apps and plan summaries reuse current domain data sources.
- Doctor results are structured, cached, timestamped, and manually refreshable.
- Domain failures degrade independently.
- Canonical repository IDs flow through eligible domain summaries without introducing repository-centric homepage UI.
- Existing portal pages and deep links remain functional.

## Deferred Work

- Repository cards that combine localhost apps, chats, plans, config warnings, and health.
- Identity-management UI beyond Runtime's current explicit alias workflow.
- User-editable portal policy thresholds.
- Full verify execution or background repair from the homepage.
- Notifications outside the portal.
