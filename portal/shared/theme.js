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
import { mountOverflowNav } from "/portal/shared/overflow-nav.js";
import { currentRepositoryScope, onRepositoryScopeChange, scopedPagePath } from "/portal/shared/repository-scope.js";

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
  const navLink = (p, inMenu) => {
    const link = tpl("tpl-nav-link");
    link.href = scopedPagePath(p, currentRepositoryScope());
    fill(link, { label: p.title });
    if (p.id === currentPageId) {
      link.classList.add("active");
      link.setAttribute("aria-current", "page");
    }
    if (inMenu && p.icon) {
      const icon = document.createElement("portal-icon");
      icon.className = "menu-item-icon";
      icon.setAttribute("name", p.icon);
      icon.setAttribute("size", "sm");
      icon.setAttribute("aria-hidden", "true");
      link.prepend(icon);
    }
    return link;
  };
  // Below 640px the primary links no longer fit beside the logo, so every page moves into the ⋮ menu.
  const navRow = mountOverflowNav(nav, { menuLabel: "More pages", collapseBelow: 640 });
  const renderNav = () => navRow.setItems(
    PORTAL_PAGES.map((p) => ({
      label: p.title,
      current: p.id === currentPageId,
      secondary: Boolean(p.secondary),
      render: (inMenu) => navLink(p, inMenu),
    })),
  );
  renderNav();
  // Links carry the repository scope, so they follow it as it changes.
  onRepositoryScopeChange(renderNav);

  const currentPage = PORTAL_PAGES.find((p) => p.id === currentPageId);
  if (currentPage?.repositoryScope) {
    // The repository filter gets its own sub-header row inside the sticky site header, so the two
    // stay pinned together. The module is loaded only where it renders, so unscoped pages skip the
    // selector and its dialog.
    document.querySelector(".portal-header").append(tpl("tpl-repository-scope-bar"));
    void import("/portal/shared/repository-scope-selector.js").then(({ mountRepositoryScopeSelector }) =>
      mountRepositoryScopeSelector(currentPage));
  }
  // A page that pins its own row under the header (Plans' lifecycle row) needs the header's height,
  // which grows when the repo row joins it.
  const header = document.querySelector(".portal-header");
  const publishHeaderHeight = () =>
    document.documentElement.style.setProperty("--portal-header-height", `${header.getBoundingClientRect().height}px`);
  new ResizeObserver(publishHeaderHeight).observe(header);
  publishHeaderHeight();
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
