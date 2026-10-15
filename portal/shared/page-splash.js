// The shared empty-state splash: a centered title, a lead, and optional action buttons, for a page
// or page scope that has nothing to show yet (.page-splash in base.css).
//   pageSplash({ title, body, actions: [{ label, onClick }] }) -> HTMLElement
import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";

export function pageSplash({ title, body, actions = [] }) {
  const node = fill(tpl("tpl-page-splash"), { title, body });
  const host = node.querySelector("[data-slot=actions]");
  for (const { label, onClick } of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.btn = "secondary";
    button.textContent = label;
    button.addEventListener("click", onClick);
    host.append(button);
  }
  return node;
}
