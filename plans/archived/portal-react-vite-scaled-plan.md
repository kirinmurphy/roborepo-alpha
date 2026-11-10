---
id: portal-react-vite-scaled-plan
priority: low
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# React And Vite Portal Scaling Plan

## Status

Proposed

## Purpose

The current portal can stay static for the immediate cleanup, but a larger portal will eventually
need stronger tools for shared layout, component reuse, stateful interactions, route composition,
and tests. This plan describes the target architecture for moving the portal to a React + Vite
single-page app while keeping RoboRepo's local loopback server and existing CLI-centered runtime.

This is a future migration plan, not a prerequisite for the current Config, Plans, and Telemetry
pages.

## Current Behavior

- `roborepo serve` starts the local portal through the existing Node CLI.
- Portal pages are static HTML files under `portal/<page>/index.html`.
- Browser behavior is written as classic JavaScript files under each page directory.
- Shared chrome and theme behavior live in `portal/shared/theme.js` and `portal/shared/base.css`.
- Server APIs live behind `scripts/cli/portal-server.mjs` and supporting CLI modules.
- The portal has no frontend build step and no package dependencies for React, Vite, TypeScript,
  or test tooling.
- The npm package includes `portal/` and `scripts/cli/`, so any build output must fit the package
  distribution model.

## Target State

Use a Vite-built React single-page app for the browser frontend, served by the existing
`roborepo serve` local HTTP server.

The server remains the source of truth for:

- local file access
- package and skill mutation
- telemetry analysis
- plans scanning and prompt generation
- portal manifest and mutation-token generation

The React app owns:

- layout and navigation
- client-side routes
- reusable components
- page-level state and data fetching
- modal, table, drawer, form, and chart composition
- user-visible loading, empty, and error states

Next.js is not part of this plan. The portal is local-only, has no SEO requirement, and does not
need server-side rendering or hosted app routing.

## Architecture

### Source layout

Add a frontend source tree separate from generated build output:

```text
portal/
  app/
    index.html
    src/
      main.tsx
      routes/
        ConfigPage.tsx
        PlansPage.tsx
        TelemetryPage.tsx
      components/
        AppLayout.tsx
        PortalNav.tsx
        ThemeToggle.tsx
        Modal.tsx
        Drawer.tsx
        DataTable.tsx
        StatusLine.tsx
      api/
        client.ts
        config.ts
        plans.ts
        telemetry.ts
      types/
        config.ts
        plans.ts
        telemetry.ts
      styles/
        base.css
        config.css
        plans.css
        telemetry.css
  dist/
    ...
```

`portal/dist/` is generated build output. It should be included in published packages only if the
install/runtime path cannot build frontend assets after installation.

### Routing model

Use a small client router rather than Next-style file routing:

```text
/config
/plans
/telemetry
/
```

`/` redirects or aliases to Config. The existing `/config` alias remains valid.

The server serves the SPA shell for all known portal paths and continues to serve JSON APIs under
`/api/...`.

### Data model

Define TypeScript interfaces for API responses near the client API modules:

- `ConfigSnapshot`
- `BehaviorViewSection`
- `PlansSnapshot`
- `PlanRecord`
- `TelemetryReport`
- `TelemetrySession`

Runtime validation can start lightweight. The first migration should type client code and keep
server-side validation where it already exists. Add runtime schema validation later only where bad
data would cause unsafe rendering or unclear failures.

### API client

Create one typed client:

```ts
getJson<T>(path: string): Promise<T>
postJson<TResponse, TBody>(path: string, body: TBody): Promise<TResponse>
```

The client reads the portal token and manifest from a server-injected bootstrap object. All
mutations use the same token path.

### Component model

Initial shared components should cover repeated portal interaction patterns:

- `AppLayout` for header, nav, footer, updated-at status, and theme wiring.
- `StatusLine` for loading/error/saved state.
- `Modal` for Config source inspection and Telemetry session detail.
- `Drawer` for Plans document detail.
- `DataTable` for Telemetry tables and any future dense admin surfaces.
- `SegmentedControl`, `Toggle`, `SelectFilter`, and `SearchInput` for Config and Plans controls.
- `MarkdownPanel` for server-rendered or sanitized Markdown/HTML views.

Keep page-specific domain rendering in page folders until there is repeated use.

## Migration Strategy

### Phase 1: Build system behind the existing server

- Add `react`, `react-dom`, `vite`, `typescript`, and `@vitejs/plugin-react`.
- Add frontend scripts:

  ```json
  {
    "portal:dev": "vite --host 127.0.0.1",
    "portal:build": "vite build",
    "portal:preview": "vite preview --host 127.0.0.1"
  }
  ```

- Configure Vite output to `portal/dist`.
- Teach `roborepo serve` to serve `portal/dist` when present.
- Keep existing static pages available until React parity is proven.

### Phase 2: Shared shell and Config route

- Implement `AppLayout`, manifest bootstrap, nav, theme toggle, and API client.
- Port Config first because it already has server-computed view models and clear mutation flows.
- Keep current Config APIs unchanged.
- Add focused tests for package toggles, permission changes, modal inspection, and error states.

### Phase 3: Plans route

- Port Plans filters, discovery roots, groups, drawer, prompt-copy actions, and package banner.
- Preserve Markdown files as source of truth.
- Keep prompt generation server-side.
- Add tests for filtering, empty states, drawer open/close, root mutation, and prompt copy.

### Phase 4: Telemetry route

- Port Telemetry last because it is the largest and most chart-heavy page.
- Decide whether the current canvas chart remains imperative inside a React component or moves to a
  small charting helper.
- Keep expensive analysis server-side.
- Add tests for route load, telemetry-disabled prompt, filter controls, and table/modal detail.

### Phase 5: Remove legacy static pages

- Delete old page-local HTML/JS only after React routes pass parity checks.
- Keep shared CSS variables and visual language unless redesign is intentional.
- Update package `files`, docs, and smoke tests to reflect the built frontend.

## Server Changes

- Serve React `index.html` for every known portal route.
- Continue serving `/api/...` as JSON.
- Continue enforcing loopback origin and mutation-token checks for POST.
- Inject bootstrap data into the SPA shell:

  ```js
  window.ROBOREPO_PORTAL = {
    token,
    pages,
    defaultPage: "config"
  };
  ```

- Support development proxying if Vite dev server is used during local frontend work.
- Keep production `roborepo serve` independent from Vite's dev server.

## Package And Runtime Rules

- Published packages must not require users to run `vite build` before `roborepo serve`.
- If source ships without build output, install/update must build or provide a clear failure mode.
- If build output ships, package checks must verify `portal/dist` is current with source.
- Node runtime support remains aligned with the existing `engines.node` floor.
- The portal must continue to bind to loopback only.

## Validation

- `npm run portal:build` produces `portal/dist`.
- `roborepo serve` serves the built React app without starting Vite.
- `/`, `/config`, `/plans`, and `/telemetry` all load through direct browser refresh.
- Existing API smoke checks still pass.
- Mutating requests without token still fail.
- Config package/skill/permission mutations work.
- Plans root updates, refresh, drawer, and copy actions work.
- Telemetry dashboard loads, redraws on theme change, and can enable telemetry.
- Package dry-run output includes required portal assets.

## Rollback

The migration should keep the old static pages until route parity is complete. If the React app
fails packaging or runtime validation, `roborepo serve` can point back to the old `portal/<page>/`
HTML files while server APIs remain unchanged.

Rollback should not require changing package state, user config, telemetry data, or plan documents.

## Open Decisions

- Should React source live under `portal/app/` or a separate `apps/portal/` directory?
- Should `portal/dist` be committed, generated during release, or generated during install?
- Should Vite dev server proxy API calls to `roborepo serve`, or should `roborepo serve` proxy the
  Vite dev server in development mode?
- Should telemetry charts remain custom canvas code or move to a dedicated chart component/helper?
- Should client API types be hand-written first or generated from server-owned schemas later?

## Success Criteria

- The portal has one app shell and one client routing model.
- Shared UI behavior is componentized instead of copied between pages.
- Server APIs and mutation security stay stable.
- Published RoboRepo installs can open the portal without a frontend build step.
- The React migration reduces page-growth cost without turning the local CLI portal into a hosted
  web-app architecture.
