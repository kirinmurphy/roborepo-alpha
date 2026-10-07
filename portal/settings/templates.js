import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";

export function harnessRow(harness, detected, onToggle) {
  const node = fill(tpl("tpl-settings-harness-row"), { name: harness.displayName });
  const entry = detected.get(harness.id);
  const status = node.querySelector("[data-slot=status]");
  const toggle = node.querySelector("[data-slot=toggle]");
  if (!entry) {
    status.textContent = "Not detected";
    toggle.remove();
    return node;
  }
  const active = entry.enabled !== false && (!entry.confidence || entry.confidence === "confirmed");
  status.textContent = active ? "Detected · enabled" : entry.enabled === false ? "Detected · disabled" : "Detected · needs confirmation";
  const enabled = entry.enabled !== false;
  const action = enabled ? "Disable" : "Enable";
  toggle.textContent = action;
  toggle.setAttribute("aria-label", `${action} ${harness.displayName}`);
  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    toggle.setAttribute("aria-busy", "true");
    try {
      await onToggle(harness.id, !enabled);
    } finally {
      toggle.disabled = false;
      toggle.removeAttribute("aria-busy");
    }
  });
  return node;
}

export function harnessEmptyState() {
  return tpl("tpl-settings-harness-empty");
}
