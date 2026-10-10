// Shared portal chrome: renders the global header, footer, nav, and theme toggle. Every page loads
// this before its own app.js. Adding a portal page = add one entry to PAGES in
// scripts/cli/portal-server.mjs — the server injects it into window.PORTAL_MANIFEST and the nav
// below picks it up on every page, so there is nothing to hand-sync here.
//
// The no-flash theme *init* is NOT here: it must run before first paint, so it stays as a tiny
// inline <script> in each page's <head>. This file only handles the interactive toggle + nav.
//
// The header/footer/nav-link markup is cloned from <template>s injected via the {{CHROME}}
// marker (portal/shared/chrome-partial.html, rendered server-side in
// scripts/cli/portal-server.mjs) — one source of truth instead of duplicating markup per page.
// The loading overlay is NOT here: it's real markup in the initial HTML (see {{LOADING}} in
// portal-server.mjs) so it's visible on first paint instead of flashing in after this module
// script runs.
import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";
import "/portal/shared/icon.js";

if (!window.PORTAL_MANIFEST) {
  throw new Error(
    "portal manifest missing: window.PORTAL_MANIFEST was not injected into this page",
  );
}
const PORTAL_PAGES = window.PORTAL_MANIFEST.pages;

(function renderChrome() {
  if (!document.querySelector(".portal-header")) {
    document.body.prepend(tpl("tpl-portal-header"));
  }
  if (!document.querySelector(".portal-footer")) {
    document.body.append(tpl("tpl-portal-footer"));
  }
  const nav = document.getElementById("nav");
  if (!nav) return;
  const currentPageId = window.PORTAL_MANIFEST.currentPageId;
  nav.prepend(
    ...PORTAL_PAGES.map((p) => {
      const link = tpl("tpl-nav-link");
      link.href = p.path;
      fill(link, { label: p.title });
      if (p.icon) {
        const icon = document.createElement("portal-icon");
        icon.setAttribute("name", p.icon);
        icon.setAttribute("size", "md");
        icon.setAttribute("aria-hidden", "true");
        fill(link, { icon });
        link.classList.add("nav-icon-only");
        link.setAttribute("aria-label", p.title);
        link.title = p.title;
      } else {
        link.querySelector('[data-slot="icon"]')?.remove();
      }
      if (p.id === currentPageId) link.classList.add("active");
      return link;
    }),
  );
})();

// Theme toggle: sun glyph in dark mode (click -> light), moon in light mode. Choice persists in
// localStorage (key shared with the head init script) and is applied across all portal pages.
// On change we dispatch "portal:themechange" on <html> so a page can react (e.g. the telemetry
// dashboard redraws its canvas, whose colors are resolved from CSS vars at draw time).
(function themeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const render = () => {
    const light = document.documentElement.dataset.theme === "light";
    btn.textContent = light ? "☾" : "☀";
    btn.title = light ? "Switch to dark mode" : "Switch to light mode";
  };
  btn.addEventListener("click", () => {
    const next =
      document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("portal-theme", next);
    } catch (e) {}
    render();
    document.documentElement.dispatchEvent(
      new CustomEvent("portal:themechange", { detail: { theme: next } }),
    );
  });
  render();
})();
