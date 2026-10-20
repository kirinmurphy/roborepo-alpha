// What the user has opened on the Tokens report survives a re-render. Polls and scope changes
// rebuild most panels from scratch when a new report version lands; without this, every expanded
// Investigate section snapped shut and an open "+N more" list vanished mid-read.
//
//   preserveViewState(root, () => renderEverything(data));
//
// Elements are matched across the rebuild by a stable key: an Investigate section by its
// `data-sec-key`, a "+N more" list by its waste row's range label. Both open and closed are
// restored, so a section the user collapsed stays collapsed too. Anything without a key keeps the
// state its renderer gives it.

const KEYED_VIEWS = [
  {
    selector: "details[data-sec-key]",
    key: (node) => node.dataset.secKey,
    isOpen: (node) => node.open,
    setOpen: (node, open) => { node.open = open; },
  },
  {
    selector: ".waste-more",
    key: (node) => node.closest(".waste-sources")?.parentElement?.querySelector(":scope > .waste-range")?.textContent ?? null,
    isOpen: (node) => node.classList.contains("open"),
    setOpen: (node, open) => {
      node.classList.toggle("open", open);
      node.setAttribute("aria-expanded", open ? "true" : "false");
    },
  },
];

export function preserveViewState(root, render) {
  const saved = KEYED_VIEWS.map((view) => new Map(
    [...root.querySelectorAll(view.selector)]
      .map((node) => [view.key(node), view.isOpen(node)])
      .filter(([key]) => key != null),
  ));
  const focusKey = focusedSectionKey(root);
  render();
  KEYED_VIEWS.forEach((view, index) => {
    for (const node of root.querySelectorAll(view.selector)) {
      const key = view.key(node);
      if (saved[index].has(key)) view.setOpen(node, saved[index].get(key));
    }
  });
  // A rebuilt summary is a new element, so keyboard focus on one would otherwise drop to <body>.
  if (focusKey != null) {
    root.querySelector(`details[data-sec-key="${CSS.escape(focusKey)}"] > summary`)?.focus({ preventScroll: true });
  }
}

function focusedSectionKey(root) {
  const summary = document.activeElement?.closest?.("details[data-sec-key] > summary");
  return summary && root.contains(summary) ? summary.parentElement.dataset.secKey : null;
}
