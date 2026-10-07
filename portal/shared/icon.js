// <portal-icon name="refresh"> — single reusable element backed by the ICONS registry below.
// Add a new icon anywhere on the site by adding one entry here; every call site just sets `name`.
// Renders inline (no shadow DOM) so page CSS can still target `svg`/`path` the way existing
// call sites already do (e.g. developer-runtime's setRefreshing() toggles the icon via [hidden]).
const ICONS = {
  refresh: {
    viewBox: "0 0 16 16",
    body: `<path fill="currentColor" d="M8 2.5a5.5 5.5 0 1 0 5.163 3.588.75.75 0 0 1 1.406-.526A7 7 0 1 1 8 1v-.5a.5.5 0 0 1 .82-.385l2.25 1.875a.5.5 0 0 1 0 .77L8.82 4.635A.5.5 0 0 1 8 4.25V2.5Z" />`,
  },
  pencil: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" d="M11.3 2.3a1 1 0 0 1 1.4 0l1 1a1 1 0 0 1 0 1.4L5.6 12.8l-2.9.6.6-2.9L11.3 2.3Z" /><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M9.9 3.7l2.4 2.4" />`,
  },
  filter: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M2 3h12L9.5 8.2v4.3L6.5 14V8.2L2 3Z" />`,
  },
  "agent-prompt": {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M2 2.5h12a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8.8L5.5 13.8V10.5H2a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />`,
  },
  "external-link": {
    viewBox: "0 0 24 24",
    body: `<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="15 3 21 3 21 9" /><line stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" x1="10" y1="14" x2="21" y2="3" />`,
  },
  link: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="m6.2 9.8 3.6-3.6M6.5 5.2l2-2a3 3 0 0 1 4.3 4.3l-2 2M9.5 10.8l-2 2a3 3 0 0 1-4.3-4.3l2-2" />`,
  },
  // Info: a circled "i" — the same stroke family as warning, for prompts that invite an action
  // rather than flag a problem.
  info: {
    viewBox: "0 0 16 16",
    body: `<circle fill="none" stroke="currentColor" stroke-width="1.3" cx="8" cy="8" r="6.5" /><path fill="currentColor" d="M7.4 7h1.2v4.5H7.4V7Z" /><circle fill="currentColor" cx="8" cy="5" r="0.75" />`,
  },
  warning: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" d="M8 1.5 15 13.8H1L8 1.5Z" /><path fill="currentColor" d="M7.4 6h1.2v4.2H7.4V6Z" /><circle fill="currentColor" cx="8" cy="11.7" r="0.75" />`,
  },
  close: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M3 3l10 10M13 3 3 13" />`,
  },
  settings: {
    viewBox: "0 0 24 24",
    body: `<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="2" />`,
  },
  copy: {
    viewBox: "0 0 16 16",
    body: `<rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" /><path fill="none" stroke="currentColor" stroke-width="1.3" d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />`,
  },
  // Success confirmation, paired with `copy` — same 16x16 box and stroke weight so swapping one for
  // the other does not shift the control's metrics.
  check: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M3 8.5l3.2 3.2L13 5" />`,
  },

  // Technology glyphs. Deliberately monochrome silhouettes in this set's own style rather than
  // vendor logos: real brand marks are trademarked (this repo installs onto other people's
  // machines) and are multi-color, which would make them the only icons here that ignore
  // currentColor and therefore the only ones that break in one of the two themes.
  //
  // Each is a suggestion of the tool's familiar shape, not a reproduction of its mark.
  // Container ship: stacked deck boxes over a hull.
  docker: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M1.5 8.5h9.2c.9 0 1.6-.5 2-1.2M1.5 8.5c0 2.5 1.7 4.5 4.6 4.5 3.4 0 6-1.7 7-4.7" /><rect x="3" y="6.2" width="2" height="2" fill="none" stroke="currentColor" stroke-width="1.1" /><rect x="5.6" y="6.2" width="2" height="2" fill="none" stroke="currentColor" stroke-width="1.1" /><rect x="5.6" y="3.8" width="2" height="2" fill="none" stroke="currentColor" stroke-width="1.1" /><rect x="8.2" y="6.2" width="2" height="2" fill="none" stroke="currentColor" stroke-width="1.1" />`,
  },
  // Node: the hexagon that reads as "node" across the ecosystem.
  node: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M8 1.6l5.4 3.1v6.6L8 14.4 2.6 11.3V4.7L8 1.6Z" />`,
  },
  // Supabase: the lightning bolt of its mark, as an outline.
  supabase: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M8.8 1.6L3 8.6h4.2v5.8L13 7.4H8.8V1.6Z" />`,
  },
  // ngrok / tunnel: two endpoints joined through a constriction.
  tunnel: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M1.8 8h3.4M10.8 8h3.4" /><circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" stroke-width="1.3" />`,
  },
  // A checkout's directory on disk, beside the branch and worktree glyphs in Home's worktree details.
  folder: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M1.5 4a1 1 0 0 1 1-1h3.4l1.5 1.5h6.1a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z" />`,
  },
  "git-branch": {
    viewBox: "0 0 16 16",
    body: `<circle cx="4" cy="3" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3" /><circle cx="4" cy="13" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3" /><circle cx="12" cy="6" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3" /><path fill="none" stroke="currentColor" stroke-width="1.3" d="M4 4.6V11.4" /><path fill="none" stroke="currentColor" stroke-width="1.3" d="M4 8c0-2.5 2-3.5 4.5-3.8" />`,
  },
  chevron: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M4 6l4 4 4-4" />`,
  },
  // A linked worktree on the Runtime page's checkout rows: a crown on a stem. (The main checkout
  // uses `home`.) Kept to a single stroke colour so a later status tint can recolour the whole glyph
  // at once.
  tree: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M5.2 9.6a2.6 2.6 0 0 1-.5-5.1 3.4 3.4 0 0 1 6.6 0 2.6 2.6 0 0 1-.5 5.1Z" /><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M8 9.6v4.9M5.8 14.5h4.4" />`,
  },

  // Header brand mark only. Outlined like the rest of the set, but heavier (1.5) so it holds up as
  // the brand mark; the eyes stay solid so the face reads at a glance. No antenna. The glyph spans
  // x 2.75–21.25, y 6–19, so the viewBox is cropped to a square centered on those bounds — a stock
  // 24×24 box left it riding high and small in the header.
  robot: {
    viewBox: "2 2.5 20 20",
    body: `<rect x="5.75" y="6.75" width="12.5" height="11.5" rx="3" fill="none" stroke="currentColor" stroke-width="1.5" /><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M5.75 10.5H4.5a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h1.25M18.25 10.5h1.25a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-1.25M10 15.25h4" /><circle cx="9.75" cy="11.75" r="1.25" fill="currentColor" /><circle cx="14.25" cy="11.75" r="1.25" fill="currentColor" />`,
  },
  // GitHub mark (Octicons mark-github, MIT). Stands in for the "GitHub" provider-link text on
  // repository rows; other forges keep their text label (see configureProviderLink).
  github: {
    viewBox: "0 0 16 16",
    body: `<path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />`,
  },
  // Portal section glyphs — the monochrome entry-point icons for Home's destination cards.
  // Same stroke family as the rest of this set (1.3 weight, round caps/joins, currentColor).
  // Home: a house — roof peak over a door, read as "start here".
  home: {
    viewBox: "0 0 16 16",
    body: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" d="M2.5 7.6 8 3l5.5 4.6" /><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M4 6.8V13h8V6.8" /><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M6.5 13v-3h3v3" />`,
  },
  // Agents: a small robot head — the harness/prompt side of the portal. A neutral bot mark rather
  // than a vendor silhouette, so it can't be misread as a brand logo.
  agents: {
    viewBox: "0 0 16 16",
    body: `<rect x="3.5" y="6" width="9" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="1.3" /><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M8 3.5V6" /><circle cx="8" cy="2.8" r="1.1" fill="none" stroke="currentColor" stroke-width="1.3" /><path fill="currentColor" d="M6.4 9.3h.01M9.6 9.3h.01" />`,
  },
  // Plans: a checklist document — a bordered sheet with a check, read as "implementation plan".
  plans: {
    viewBox: "0 0 16 16",
    body: `<rect x="3" y="2.5" width="10" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" /><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M5.6 6.6l1.3 1.3 2.6-2.8" />`,
  },
  // Tokens: a coin — a token unit. The inner "T" notches read as a minted value without needing a
  // currency glyph.
  tokens: {
    viewBox: "0 0 16 16",
    body: `<circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.3" /><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M6.4 6.4h3.2M8 6.4v3.2" />`,
  },
  // Runtime: a terminal — the dev-server / local process side of the portal.
  runtime: {
    viewBox: "0 0 16 16",
    body: `<rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" /><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M5 6.5l2 2-2 2" /><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M8.5 10.5h2.5" />`,
  },
};

// A fixed scale, not free-form pixel values. Call sites pick a step (`size="sm"`); they do not get
// to invent a size, and page CSS must not shrink an icon below the scale with a bare `svg { width }`
// rule — every step here is chosen to stay legible, and 10px-class icons (which this page had) are
// not. `md` is the default and matches the body-text cap height.
//
// The floor sits at 16px: at 14 the stroke-heavy glyphs in this set (git-branch's three circles,
// the copy sheets) lost their interior detail and read as smudges next to text, which is what made
// the small icons on the repository card hard to identify. Each step is ~1.25x its predecessor so
// the gaps stay visually distinct rather than being pixel-adjacent.
const ICON_SIZES = { sm: 16, md: 22, lg: 26, xl: 30, xxl: 40, xxxl: 48 };
const DEFAULT_ICON_SIZE = "md";

class PortalIcon extends HTMLElement {
  static observedAttributes = ["name", "size"];

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const name = this.getAttribute("name");
    const icon = ICONS[name];
    if (!icon) {
      this.replaceChildren();
      return;
    }
    // An explicit `size` wins; otherwise the nearest `data-icon-size` ancestor sets the step, so a
    // page can pick one standard size for its own icons in a single place (<body data-icon-size>).
    const step = this.getAttribute("size") || this.closest("[data-icon-size]")?.dataset.iconSize;
    const size = ICON_SIZES[step] || ICON_SIZES[DEFAULT_ICON_SIZE];
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", icon.viewBox);
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = icon.body;
    this.replaceChildren(svg);
  }
}

if (!customElements.get("portal-icon")) customElements.define("portal-icon", PortalIcon);
