import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";

export function harnessRow(harness, detected, onToggle) {
  const node = fill(tpl("tpl-settings-harness-row"), { name: harness.displayName });
  const entry = detected.get(harness.id);
  const status = node.querySelector("[data-slot=status]");
  const toggle = node.querySelector("[data-slot=toggle]");
  if (!entry) {
    status.textContent = "Not detected";
    toggle.textContent = "Not detected";
    toggle.disabled = true;
    return node;
  }
  const active = entry.enabled !== false && (!entry.confidence || entry.confidence === "confirmed");
  status.textContent = active ? "Detected · enabled" : entry.enabled === false ? "Detected · disabled" : "Detected · needs confirmation";
  toggle.textContent = entry.enabled === false ? "Enable" : "Disable";
  toggle.addEventListener("click", () => onToggle(harness.id, entry.enabled === false));
  return node;
}
