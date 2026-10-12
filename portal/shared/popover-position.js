// Shared fixed-popover positioner for the anchored menus (menu-button.js, option-dropdown.js). The
// old per-component logic only chose above/below by a fixed threshold — if the panel was taller than
// the room on the chosen side, it rendered partially off-screen with no way to reach the clipped
// items. This instead clamps the panel's max-height so its far edge always stays on-screen and lets
// it scroll internally past that (overflow-y is set on the panel by CSS).
//
// panel must be position:fixed. trigger is the element the panel anchors to. Opens on whichever
// vertical side has more room, clamped to that room; horizontally aligns to the nearer viewport edge.
//
// A fixed panel does not move when the page scrolls, so every positioned panel is followed: on any
// scroll or resize it is re-placed against its trigger's new rect, on the side it opened on, until
// the panel or its trigger leaves the document. Its height is fixed when it opens and only a resize
// re-clamps it: re-clamping on scroll grew the panel by however far its trigger had scrolled, so a
// panel whose top had scrolled off-screen stretched to several screens tall.

const GAP = 4; // px between trigger and panel
const VIEWPORT_MARGIN = 8; // keep the panel's far edge this far inside the viewport

const followed = new Map(); // panel → { trigger, openAbove }
let frame = null;
let resized = false; // a resize arrived since the last frame

export function positionPopoverPanel(panel, trigger) {
  const openAbove = place(panel, trigger, null, true);
  followed.set(panel, { trigger, openAbove });
  if (followed.size === 1) {
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
  }
}

function schedule(event) {
  if (event.type === "resize") resized = true;
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const clamp = resized;
    resized = false;
    for (const [panel, { trigger, openAbove }] of followed) {
      if (!panel.isConnected || !trigger.isConnected) followed.delete(panel);
      else place(panel, trigger, openAbove, clamp);
    }
    if (!followed.size) {
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    }
  });
}

// `side` is null on open, which picks the roomier side; following keeps that side so a panel never
// flips while the page scrolls under it. `clamp` re-sizes the panel to the room on that side.
function place(panel, trigger, side, clamp) {
  const rect = trigger.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;

  // Room available on each side of the trigger, minus the gap and a small viewport margin.
  const roomBelow = vh - rect.bottom - GAP - VIEWPORT_MARGIN;
  const roomAbove = rect.top - GAP - VIEWPORT_MARGIN;
  const openAbove = side ?? roomBelow < roomAbove;
  const available = Math.max(openAbove ? roomAbove : roomBelow, 0);

  // Clamp the panel height to the room on the chosen side so the far edge stays on-screen; the panel
  // scrolls internally past that (CSS gives it overflow-y:auto). Recomputed on every open, so a
  // previous open on a cramped side never sticks.
  if (clamp) panel.style.maxHeight = available + "px";

  if (openAbove) {
    panel.style.top = "auto";
    panel.style.bottom = vh - rect.top + GAP + "px";
  } else {
    panel.style.bottom = "auto";
    panel.style.top = rect.bottom + GAP + "px";
  }

  const rightAligned = rect.left + rect.width / 2 > vw / 2;
  if (rightAligned) {
    panel.style.right = vw - rect.right + "px";
    panel.style.left = "auto";
  } else {
    panel.style.left = rect.left + "px";
    panel.style.right = "auto";
  }
  return openAbove;
}
