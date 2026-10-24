// Shared hover/focus tooltip for any element carrying a `data-tip` (plain text) or `data-tip-html`
// (rich content, sourced from a sibling <template>) attribute. One singleton bubble is appended to
// <body> and positioned with JS so it never crosses the viewport edges — the same boundary-aware
// behavior as the dropdown popovers (unlike a CSS ::after tooltip, which happily renders
// off-screen). Import once per page; it wires delegated listeners itself.
//
// Why JS and not a native element: there is no native, cross-browser, *styleable* tooltip. The
// `title` attribute auto-positions but can't be styled; the Popover API renders in the top layer but
// you still position it yourself; CSS anchor-positioning (position-try-fallbacks) does flip/shift
// automatically but is not yet broadly supported. So a tiny JS positioner is the reliable path.

const MARGIN = 8; // keep this far inside the viewport
const GAP = 8; // space between trigger and bubble
// Hover must rest this long before a tip appears, so sweeping the pointer across a list does not
// flash a bubble for every row it crosses. Keyboard focus shows immediately: focus is deliberate.
const SHOW_DELAY_MS = 500;
// `data-tip-placement="panel"` marks a tip too large to float beside its trigger. On a wide enough
// screen it docks to the right edge instead, reading as a side panel rather than a popup over the
// row being read; below this width there is no room for that and it floats like any other tip.
const PANEL_MIN_VIEWPORT = 1100;
const PANEL_GUTTER = 24;

let bubble = null;

function ensureBubble() {
  if (bubble) return bubble;
  bubble = document.createElement("div");
  bubble.className = "portal-tooltip";
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;
  document.body.appendChild(bubble);
  return bubble;
}

// Picks whichever side (above/below, left/right) has the most room rather than a fixed
// preference, then clamps inside the viewport. If neither vertical side can fit the content at
// its natural height, the roomier side wins and the bubble gets a capped max-height + internal
// scroll instead of overflowing the screen.
function position(el) {
  const tip = ensureBubble();
  tip.style.maxHeight = "";
  tip.style.overflowY = "";
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;

  const spaceBelow = vh - r.bottom - GAP - MARGIN;
  const spaceAbove = r.top - GAP - MARGIN;
  const below = spaceBelow >= th || spaceBelow >= spaceAbove;
  const availableVertical = Math.max(below ? spaceBelow : spaceAbove, 0);

  // A tooltip must never scroll. The bubble is pointer-events:none, so a scrollbar here is
  // unreachable by definition — content past the fold is not "scrollable", it is invisible, and a
  // tooltip that silently hides half its content is worse than one that is merely tall.
  //
  // So when the preferred side cannot fit the content, the bubble is allowed to use the full
  // viewport height instead of being capped to that side, and is then clamped into view below.
  // Being tall is fine: this is a transient overlay with nothing beside it competing for space.
  if (th > availableVertical) {
    tip.style.maxHeight = `${vh - MARGIN * 2}px`;
  }

  if (tip.classList.contains("portal-tooltip--panel")) {
    // Docked: gutter from the top and right edges, and never taller than the viewport allows.
    tip.style.maxHeight = `${vh - PANEL_GUTTER * 2}px`;
    tip.style.top = `${PANEL_GUTTER}px`;
    tip.style.left = `${Math.round(vw - tip.offsetWidth - PANEL_GUTTER)}px`;
    return;
  }

  // Re-measure: the max-height above can change the height when it forces content to re-wrap.
  const finalHeight = tip.offsetHeight;
  // Anchor to the preferred side, then clamp so the whole bubble stays on screen. Clamping rather
  // than capping is what lets a tall tooltip slide up into view instead of being truncated.
  const preferredTop = below ? r.bottom + GAP : r.top - GAP - finalHeight;
  const top = Math.max(MARGIN, Math.min(preferredTop, vh - finalHeight - MARGIN));
  tip.style.top = `${Math.round(top)}px`;

  const spaceRight = vw - r.left - MARGIN;
  const spaceLeft = r.right - MARGIN;
  const alignLeft = spaceRight >= tw || spaceRight >= spaceLeft;

  let left = alignLeft ? r.left : r.right - tw;
  left = Math.max(MARGIN, Math.min(left, vw - tw - MARGIN));
  tip.style.left = `${Math.round(left)}px`;
}

function show(el) {
  const tip = ensureBubble();
  const templateSelector = el.getAttribute("data-tip-html");
  if (templateSelector) {
    const template = el.querySelector(templateSelector) || document.querySelector(templateSelector);
    if (!template) return;
    tip.replaceChildren(template.content.cloneNode(true));
    tip.classList.add("portal-tooltip--rich");
    tip.classList.remove("portal-tooltip--lines");
  } else {
    const text = el.getAttribute("data-tip");
    if (!text) return;
    tip.textContent = text;
    tip.classList.remove("portal-tooltip--rich");
    tip.classList.toggle("portal-tooltip--lines", text.includes("\n"));
  }
  tip.classList.toggle("portal-tooltip--comfortable", el.getAttribute("data-tip-size") === "comfortable");
  const panel = el.getAttribute("data-tip-placement") === "panel";
  // Wide wherever it shows; docked only where the screen has room for a side panel.
  tip.classList.toggle("portal-tooltip--wide", panel);
  tip.classList.toggle("portal-tooltip--panel", panel && window.innerWidth >= PANEL_MIN_VIEWPORT);
  tip.hidden = false;
  // Position after it's laid out so offsetWidth/Height are real.
  position(el);
}

let pendingShow = null;

function cancelPendingShow() {
  clearTimeout(pendingShow);
  pendingShow = null;
}

function hide() {
  cancelPendingShow();
  if (bubble) bubble.hidden = true;
}

const TRIGGER_SELECTOR = "[data-tip], [data-tip-html]";

function install() {
  // Delegated so it covers elements added after load (insight rows are rendered per repaint).
  document.addEventListener("pointerover", (e) => {
    const el = e.target.closest?.(TRIGGER_SELECTOR);
    // Moving between children of the same trigger is not a new hover.
    if (!el || el.contains(e.relatedTarget)) return;
    cancelPendingShow();
    pendingShow = setTimeout(() => {
      pendingShow = null;
      if (el.isConnected) show(el);
    }, SHOW_DELAY_MS);
  });
  document.addEventListener("pointerout", (e) => {
    const el = e.target.closest?.(TRIGGER_SELECTOR);
    if (el && !el.contains(e.relatedTarget)) hide();
  });
  // Keyboard accessibility: focus/blur mirror hover.
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest?.(TRIGGER_SELECTOR);
    if (!el) return;
    cancelPendingShow();
    show(el);
  });
  document.addEventListener("focusout", hide);
  // Anything that shifts layout out from under an open tip should dismiss it.
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
}

install();
