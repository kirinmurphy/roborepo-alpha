---
name: react
description: Use when working on React, Next.js, Remix, Vite React, or any repo where manifests or files show React and the task touches JSX/TSX, components, hooks, client state, effects, routing UI, or React tests. Do not use for non-React frontend stacks unless the user explicitly asks for React guidance.
---

# React

Apply this only after confirming the repo or touched files use React.

## Paired Skills

**Load these as part of the work; do not wait to be asked for them by name.**

| Skill | Relationship | Load when | Contributes |
| --- | --- | --- | --- |
| `javascript-typescript` | requires | Always: React components, hooks, and tests are JS/TS | Module, function, type, and lint conventions this skill builds on |
| `code-style` | requires | The work places a component, hook, or helper: who owns it and where it lives | Ownership and placement rules |

Say which paired skills applied and which did not. A skipped skill and a forgotten one look the
same otherwise. Each row follows the paired-skill rule in Skill Loading: a `requires` row is always
available, and a `recommends` row whose skill the session does not list is skipped and named once
in the report. Never ask the user to enable a package.

## Stack Detection

Treat React as present when any strong marker exists:

- `package.json` dependencies/devDependencies include `react`, `react-dom`, `next`, `remix`, or `@vitejs/plugin-react`.
- Touched files are `.tsx` / `.jsx` and contain React components or hooks.
- Repo has React framework structure such as `app/`, `pages/`, `src/app/`, or `src/components/` with TSX/JSX files.

If markers are absent, skip this skill. If markers exist but the task is unrelated to React files, keep this context dormant.

## Hooks And State

- Prefer deriving state during render over syncing state with `useEffect`.
- Avoid `useEffect` + `setState` when the value can be computed from props, state, URL params, query data, or memoized selectors.
- Use effects for real side effects: subscriptions, timers, imperative browser APIs, network calls not handled by framework/query tools, and synchronization with external systems.
- Do not silence hook dependency warnings with workarounds. Fix the dependency model or extract stable helpers.
- Do not use scheduling hacks to force state order: `setTimeout(..., 0)`, `queueMicrotask`, or render-time ref mutation.
- Do not call `setState` during render. Move transitions into event handlers, reducers, framework loaders/actions, or effects only when synchronizing with an external system.
- Keep component-scoped handlers as arrow functions when they close over props, state, or hooks.

## Components

- Keep exported components and primary functions near the top; move ancillary helpers below.
- Prefer named exports for shared components and utilities.
- Prefer composition over configuration for complex UI; extract repeated markup into focused components.
- Use semantic HTML and accessible labels. Testing-friendly markup should also be user-friendly markup.
- Avoid procedural comments. Prefer self-describing component, helper, and test utility names.

## Tests

- Test user-observable behavior using roles, labels, and visible text.
- Prefer React Testing Library semantics over implementation details.
- Use `data-testid` only when semantic selectors are impractical.
