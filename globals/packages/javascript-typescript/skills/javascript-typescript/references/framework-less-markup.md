# Building Markup Without A Component Framework

Rare case: the project has no React/Vue/Svelte/Astro (or similar) and needs to build DOM
structure directly. Most JS/TS work has a framework — read this only when it doesn't.

## Core rule

Never hand-assemble multi-element DOM structures as nested builder calls in JS (e.g. chained
`createElement`/`appendChild`, or a custom `el(tag, attrs, ...children)` helper composing several
nested tags). This scatters markup and styling decisions into procedural code, making structure
hard to see and hard to edit as HTML/CSS.

Use whatever templating mechanism the project already has: JSX/TSX components, a framework's
template syntax, or plain HTML `<template>` elements with a slot-fill helper when there is no
framework. If the project has no framework and no existing templating convention, introduce one
(e.g. `<template>` + a small slot-fill utility) rather than defaulting to JS-composed markup.

Assigning a JS template-literal string to a `<template>`'s `.innerHTML` (`const t =
document.createElement("template"); t.innerHTML = \`...\`;`) is still the banned pattern, not a
fix for it — the structure is still authored as a JS string, just wrapped in a `<template>`
variable instead of applied directly. A real fix means the markup exists as an actual `<template>`
tag somewhere (in the host page's HTML, or a server-rendered partial), not constructed by JS at
runtime.

A single leaf node with dynamic text or a dynamic class (e.g. one `<span>` or `<li>`) is fine as a
one-line builder call — the rule targets nested, multi-element structure, not every dynamic DOM
write.

## When to promote a template-fill into a custom element

A `<template>` + slot-fill function is the default. Promote a rendered unit to a light-DOM custom
element (`class extends HTMLElement`, light DOM by default) only when it owns real behavior beyond
"filled template with static content" — a listener it manages itself, async/in-flight state,
error handling, or logic duplicated near-identically across two or more call sites that a shared
element would eliminate outright (not just similar-looking markup).

Signals it's worth promoting:

- The same interactive pattern (e.g. a button group, a toggle, an editable row) is being
  hand-built in more than one place with copy-pasted event-wiring logic.
- The unit needs its own lifecycle (in-flight/optimistic state, revert-on-failure, internal
  open/close state) that would otherwise leak into the caller's rendering function.
- The unit will be instantiated N times per render (a list of cards, rows, controls) — the class
  form keeps each instance's state and listeners self-contained instead of re-wiring per item in a
  loop.

Signals it's NOT worth promoting (keep it a plain function):

- It's a one-shot fill of static content with no listener of its own (e.g. a label, a badge, a
  status dot). Converting these adds a class + registration + instantiation site for what's
  already a two-line function call.
- It's a page singleton referenced by id, never declaratively authored or cloned more than once
  (e.g. a single global modal/dialog). Prefer a panel-factory function (a controller object
  returned from a `createXModal()`-style function) over a custom element here — the element form
  exists to make N-instance, declaratively-authored units self-contained; a singleton gets no
  benefit from that and just adds a second controller idiom to the page.
- It's borderline and only exists to embed inside another new element "for symmetry." Build the
  parent element first; if inlining the child's logic turns out simpler once the parent is
  written, keep it inlined. Don't force a promotion purely to mirror an unrelated precedent.

## Conventions for the custom-element form, once promoted

- Light DOM by default — the page's existing CSS should keep applying to the element's
  rendered content without a second styling mechanism. Light DOM also keeps `querySelector`,
  test selectors, and `aria-labelledby`/`<label for>` references working across the element.
- Use shadow DOM only when the element must be isolated from CSS it does not control: a widget
  embedded in third-party pages, a component library shared across apps, or a container for
  untrusted or user-supplied HTML. Expose styling through CSS custom properties and `::part()`,
  and use `<slot>` when callers supply content.
- Data in via properties (`el.record = value`), not attributes, for anything that isn't a plain
  string (objects, callbacks). Attributes are fine for small string values that benefit from being
  visible in the DOM (an id, a label).
- Callbacks in via properties too (`el.onClick = fn`), since functions aren't attribute-safe.
  The element should not import application/page-level modules directly to reach a callback —
  keep it dependency-free so it can be reused without pulling in the page's wiring code.
- Prefer dispatching a bubbling `CustomEvent` for "something happened, caller decides what to do"
  over the element importing and calling an app-level function directly — this avoids a layering
  inversion where a reusable component depends on page-specific orchestration code.
- Re-render model: "set a property, rebuild the whole subtree" (`replaceChildren` on change), not
  `attributeChangedCallback`/`observedAttributes` fine-grained patching, unless the project already
  has a stronger reason to need partial updates.
- Each element is a standalone ES module whose only top-level side effect is
  `customElements.define(...)`. A barrel module that imports each element file is a reasonable way
  to register a whole set from one script tag.
