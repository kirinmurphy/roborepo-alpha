# Portal UI header and section conventions

This is the initial shared convention for portal page structure. It keeps page hierarchy visible
without turning every section into a card.

## Page shell

Use the shared classes from `portal/shared/base.css`:

```html
<main class="inner portal-page">
  <header class="portal-page-header">
    <h1>Page title</h1>
  </header>
  <section class="portal-section" aria-labelledby="section-title">
    <header class="portal-section-head"><h2 id="section-title">Section title</h2></header>
    <!-- section content -->
  </section>
</main>
```

- One `h1` names the page. Keep the page header compact and omit a subtitle when the page's
  sections provide enough context.
- Each major section uses `portal-section`, with `portal-section-head` for its `h2`.
- Adjacent sections are separated by a horizontal rule; major sections do not receive their own
  background, border, or rounded-card treatment.
- Use `portal-section-description` for muted supporting copy and keep section actions in the
  heading or at the end of the section, aligned to the right on larger screens.
- Use `panel` only for a deliberately elevated component such as a data card, dialog body, or
  dense tool surface—not as the default wrapper for every page section.

Settings is the first page using this convention. Existing page-specific dashboard compositions
can migrate incrementally when their hierarchy is next touched; this guide is the shared target,
not a reason to rewrite unrelated layouts.
