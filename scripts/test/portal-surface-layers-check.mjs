#!/usr/bin/env node
// The portal's surface layers must stay distinguishable in both themes. Each nested layer is only
// useful if it reads as a different surface from the one it sits on, and a one-off colour tweak in
// either theme can silently collapse two of them into one (the Runtime page's rows once matched the
// page background in light theme, and tooltip heading bands nearly vanished in dark theme).
//
// Distances are CIELAB lightness (L*, 0-100), which tracks how different two greys look far better
// than raw RGB or WCAG contrast ratios do at these low contrasts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "..", "..", "portal", "shared", "base.css"), "utf8");

// The first `:root {` block is the dark (default) palette; the light one overrides it.
function tokens(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing ${selector} block in base.css`);
  const block = css.slice(start, css.indexOf("\n}", start));
  const values = {};
  for (const [, name, value] of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) values[name] = value;
  return values;
}

function lightness(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

// The smallest lightness gap that still reads as a separate surface at a glance.
const STEP = 2.8;

for (const [theme, palette] of [["dark", tokens(":root")], ["light", { ...tokens(":root"), ...tokens(':root[data-theme="light"]') }]]) {
  const L = (name) => {
    assert.ok(palette[name], `${theme}: --${name} is not a hex colour in base.css`);
    return lightness(palette[name]);
  };
  const gap = (a, b) => Math.abs(L(a) - L(b));

  assert.ok(gap("bg", "panel") >= STEP, `${theme}: page and panel read as one surface (${gap("bg", "panel").toFixed(1)})`);
  assert.ok(gap("panel", "surface-band") >= STEP, `${theme}: a row band disappears into its card (${gap("panel", "surface-band").toFixed(1)})`);
  assert.ok(gap("bg", "surface-band") >= STEP, `${theme}: a row band matches the page behind the card (${gap("bg", "surface-band").toFixed(1)})`);
  assert.ok(gap("surface-band", "surface-sunken") >= STEP, `${theme}: an opened list is not set apart from its rows (${gap("surface-band", "surface-sunken").toFixed(1)})`);
  // Local contrast is what the eye compares: an inset unit against the list it sits in must stand
  // out more than that list stands out from its rows. (Light theme steps back to white for inset,
  // so "further from the band" would not hold there; this rule does in both themes.)
  assert.ok(
    gap("surface-sunken", "surface-inset") > gap("surface-band", "surface-sunken"),
    `${theme}: inset units are not the most distinct layer (${gap("surface-sunken", "surface-inset").toFixed(1)} vs ${gap("surface-band", "surface-sunken").toFixed(1)})`,
  );
  // Dropdowns, menus, and tooltips share --popover-bg; it must not bleed into the card it opens from.
  assert.ok(gap("popover-bg", "panel") >= 2 * STEP, `${theme}: a dropdown blends into its card (${gap("popover-bg", "panel").toFixed(1)})`);
  assert.ok(gap("popover-bg", "wash-heading") >= 2 * STEP, `${theme}: tooltip heading bands do not stand out (${gap("popover-bg", "wash-heading").toFixed(1)})`);
  console.log(`ok  ${theme} surface layers`);
}

// Light theme's chrome steps down from the top: the site header darkest, the repo filter row a middle
// grey, the page lightest. Dark keeps the header on the page colour, so this applies to light only.
{
  const palette = { ...tokens(":root"), ...tokens(':root[data-theme="light"]') };
  const L = (name) => {
    assert.ok(palette[name], `light: --${name} is not a hex colour in base.css`);
    return lightness(palette[name]);
  };
  assert.ok(L("scope-bar-bg") - L("header-bg") >= STEP, `light: the repo row is not lighter than the header (${(L("scope-bar-bg") - L("header-bg")).toFixed(1)})`);
  assert.ok(L("bg") - L("scope-bar-bg") >= STEP, `light: the page is not lighter than the repo row (${(L("bg") - L("scope-bar-bg")).toFixed(1)})`);
  // Dim header text ("Synced", "Viewing") must stay readable on the darker header: WCAG AA, 4.5:1.
  const luminance = (hex) => ((lightness(hex) + 16) / 116) ** 3;
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const ratio = contrast(palette["header-dim"], palette["header-bg"]);
  assert.ok(ratio >= 4.5, `light: dim header text is ${ratio.toFixed(2)}:1 on the header`);
  console.log("ok  light chrome steps header -> repo row -> page");
}

console.log("portal surface layers check passed");
