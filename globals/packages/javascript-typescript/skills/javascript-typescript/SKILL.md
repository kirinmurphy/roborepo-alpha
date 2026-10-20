---
name: javascript-typescript
description: "Use when working on TypeScript, JavaScript, ECMAScript modules, TSX/JSX utility code, lint/type errors, exports/imports, helper functions, type safety, or JS/TS code style. Pair with react when touched files contain React components or hooks."
---

# JavaScript TypeScript

Apply this when the repo or touched files use JavaScript or TypeScript.

## Paired Skills

**Load these as part of the work; do not wait to be asked for them by name.**

| Skill | Load when | Contributes |
| --- | --- | --- |
| `react` | A touched file contains a component, a hook, JSX/TSX markup, or client state | Component and hook conventions, effect and state rules, and React-specific test shape |

Say which paired skills applied and which did not. A skipped skill and a forgotten one look the
same otherwise.

## Functions

These are defaults; a file that consistently does otherwise keeps its own style.

- Prefer `function` declarations for context-agnostic utilities, especially exported helpers.
- Prefer arrow functions for callbacks, inline handlers, closures, and functions that intentionally capture local state or props.
- Place a pure helper by who uses it, as `code-style` describes: next to its only consumer, in a shared module once a second module needs it. Being pure does not by itself earn a separate module.
- Small local helpers can live below the main function/export and rely on hoisting.

## Types

- Avoid `any`; prefer precise types, `unknown` with narrowing, generics, or local interfaces.
- Use `as const` for stable literal maps and default tables.
- Extract repeated or meaningful string/number values into named constants.
- Keep runtime parsing and type assumptions close together so callers receive typed values.

## Modules

- Prefer named exports unless the project has a clear default-export convention.
- Keep imports explicit and remove unused imports after edits.
- Preserve the repo's module style: ESM, CommonJS, path aliases, and file extension rules.

## Lint And Formatting

- Use repo-native scripts and config. Do not invent ESLint, Prettier, or typecheck commands.
- For file-scoped fixes, prefer scoped lint/format commands only when the repo supports them.

## Building Markup

- If the project has no component framework (no React/Vue/Svelte/Astro or similar) and the task involves building DOM structure directly, read `references/framework-less-markup.md` before hand-assembling elements — it covers the `<template>`+slot-fill convention and when a rendered unit is worth promoting to a light-DOM custom element.
- Otherwise, use the project's existing framework/templating mechanism (JSX/TSX components, a framework's template syntax) — do not introduce framework-less patterns into a project that already has one.
