import { portalPostJson, portalWireBackdropClose } from "/portal/shared/api.js";
import { repositoryLabel, PROBLEM_KINDS } from "./conditions-format.js";
import { setText } from "./conditions-dom.js";

export function createChangeForm(getData, onSaved) {
  const dialog = document.getElementById("condition-change-dialog");
  const form = document.getElementById("condition-change-form");
  let editing = null;
  const open = (marker = null) => {
    editing = marker;
    const data = getData();
    form.reset();
    setText(form, "h2", marker ? "Edit change" : "Mark a change");
    form.elements.title.value = marker?.title ?? "";
    form.elements.supersedes.value = marker?.marker_id ?? "";
    form.elements.intent.value = marker ? "suspected" : "response";
    const localTime = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    form.elements.effective_at.value = localTime(new Date(marker?.effective_at ?? marker?.ts ?? Date.now()));
    form.elements.effective_at.disabled = !marker;
    form.elements.intent.onchange = () => { form.elements.effective_at.disabled = form.elements.intent.value === "response"; };
    const repo = form.elements.repository;
    repo.replaceChildren(new Option("All repos", "all"));
    for (const value of [...new Set((data.conditions?.comparisons ?? []).filter((row) => row.dimension === "repo").map((row) => row.value))]) repo.add(new Option(repositoryLabel(value), value));
    if (marker?.repository_id && ![...repo.options].some((option) => option.value === marker.repository_id)) repo.add(new Option(marker.repository_id, marker.repository_id));
    repo.value = marker?.repository_id ?? "all";
    const finding = form.elements.finding_id;
    finding.replaceChildren(new Option("None", ""));
    for (const row of data.conditions?.ledger ?? []) if (PROBLEM_KINDS.includes(row.kind)) finding.add(new Option(`${row.kind} · ${row.repository_label ?? repositoryLabel(row.context.repository_id)} · ${row.ts}`, row.id));
    finding.value = marker?.finding_id ?? "";
    if (marker) for (const input of form.querySelectorAll('[name="watching"]')) input.checked = marker.watching_kinds?.includes(input.value) ?? false;
    form.querySelector("[data-change-error]").textContent = "";
    dialog.showModal();
  };
  const newButton = document.getElementById("condition-mark-change");

  newButton.onclick = () => open();
  portalWireBackdropClose(dialog, () => dialog.close());
  form.querySelector("[data-change-cancel]").onclick = () => dialog.close();
  form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const relocates = editing && form.elements.intent.value === "response";
      // Moving an existing change to "now" rewrites which sessions count as before/after it.
      if (relocates && !window.confirm("Moving this change to now will change which sessions count as before and after it. Continue?")) return;
      const result = await portalPostJson("/api/telemetry/markers", { type: "change", title: form.elements.title.value,
        // A correction is a new marker; carry the recorded exposure so it is not silently erased.
        packages: editing?.packages ?? [], skills: editing?.skills ?? [], tags: editing?.tags ?? [],
        effective_at: form.elements.intent.value === "response" ? new Date().toISOString() : new Date(form.elements.effective_at.value).toISOString(),
        scope: form.elements.repository.value === "all" ? "all" : "repository",
        repository_id: form.elements.repository.value === "all" ? null : form.elements.repository.value,
        watching_kinds: [...form.querySelectorAll('[name="watching"]:checked')].map((input) => input.value),
        finding_id: form.elements.finding_id.value || null, supersedes: form.elements.supersedes.value || null });
      if (result.ok === false) throw new Error(result.error);
      dialog.close();
      await onSaved();
    } catch (error) { form.querySelector("[data-change-error]").textContent = error.message; }
    finally { submit.disabled = false; }
  };

  return { open, setEnabled(enabled) {
    newButton.disabled = !enabled;
    newButton.title = enabled ? "Record a change boundary" : "Enable live telemetry to record changes";
  } };
}
