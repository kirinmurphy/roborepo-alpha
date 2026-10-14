// mountOverflowNav — a row of items that keeps its primary items in the bar and the rest behind a
// trailing ⋮ menu. Below `collapseBelow` px the row collapses: every item moves into the menu and
// the bar keeps only the trigger. The site header nav and the Plans lifecycle row both use it.
//
//   const row = mountOverflowNav(navEl, { menuLabel: "More pages", collapseBelow: 640 });
//   row.setItems([{ label, current, secondary, render: (inMenu) => Node }]);
//
// `render` runs once for the bar copy of each primary item and once for every item's menu copy, so
// it must return a fresh node each call; it owns how the current item is marked. The menu holds
// every item and CSS shows the primary copies only while collapsed, so collapsing never re-renders.
//
// `collapsedFace: "current"` swaps the collapsed trigger's ⋮ for the current item's label and a
// caret — for rows where the menu is the only thing left on screen and must say what is selected.
//
// setItems can run on every data refresh: it replaces items in place around the menu, so an open
// menu stays open and a focused trigger keeps its focus.
import { portalTpl as tpl } from "/portal/shared/api.js";
import "/portal/shared/icon.js";

export function mountOverflowNav(container, {
  menuLabel = "More",
  collapseBelow,
  collapsedFace = "dots",
  highlightSecondarySelection = true,
}) {
  const more = tpl("tpl-overflow-more");
  const trigger = more.querySelector(".overflow-more-trigger");
  const panel = more.querySelector(".overflow-more-panel");
  const currentLabel = more.querySelector("[data-slot=current]");
  panel.id = `${container.id}-more-panel`;
  trigger.setAttribute("aria-controls", panel.id);
  container.classList.add("overflow-nav");
  container.dataset.collapsedFace = collapsedFace;
  container.append(more);

  const setOpen = (open) => {
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  };
  trigger.addEventListener("click", () => setOpen(panel.hidden));
  // Picking an item closes the menu. Focus returns to the trigger, since the item it was on may be
  // re-rendered away by whatever the pick triggers.
  panel.addEventListener("click", (event) => {
    if (!event.target.closest("a, button")) return;
    const hadFocus = panel.contains(document.activeElement);
    setOpen(false);
    if (hadFocus) trigger.focus();
  });
  document.addEventListener("click", (event) => {
    if (!more.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden) return;
    const hadFocus = more.contains(document.activeElement);
    setOpen(false);
    if (hadFocus) trigger.focus();
  });
  // Tabbing out past the last item closes the menu rather than leaving it open behind the focus.
  more.addEventListener("focusout", (event) => {
    if (event.relatedTarget && !more.contains(event.relatedTarget)) setOpen(false);
  });

  // A trigger showing the current item's label names itself; only the bare ⋮ needs an aria-label.
  const syncTriggerName = () => {
    const showsLabel = collapsedFace === "current" && container.hasAttribute("data-collapsed");
    if (showsLabel) {
      trigger.removeAttribute("aria-label");
      trigger.removeAttribute("title");
    } else {
      trigger.setAttribute("aria-label", menuLabel);
      trigger.setAttribute("title", menuLabel);
    }
  };
  const narrow = window.matchMedia(`(max-width: ${collapseBelow}px)`);
  const applyCollapsed = () => {
    container.toggleAttribute("data-collapsed", narrow.matches);
    syncTriggerName();
  };
  narrow.addEventListener("change", applyCollapsed);
  applyCollapsed();

  return {
    setItems(items) {
      const current = items.find((item) => item.current);
      // The bar has no item to mark when the current one lives only in the menu.
      trigger.classList.toggle("active", highlightSecondarySelection && Boolean(current?.secondary));
      currentLabel.textContent = current?.label ?? "";
      panel.replaceChildren(
        ...items.map((item) => {
          const node = item.render(true);
          if (!item.secondary) node.classList.add("overflow-primary");
          return node;
        }),
      );
      for (const child of [...container.children]) if (child !== more) child.remove();
      more.before(...items.filter((item) => !item.secondary).map((item) => item.render(false)));
    },
  };
}
