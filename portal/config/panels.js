// Wiring for the Config page's self-contained chrome panels: the source-inspect /
// snapshot-view <dialog>, and the post-enable recommendations <dialog>. app.js calls into this controller instead of owning the modal's DOM
// refs and listeners itself. This is a
// panel-factory (like createInfoModal in plans/panels.js), not a custom element: the modal is a
// page singleton referenced by id, never declaratively instantiated or cloned.

import { portalWireBackdropClose } from "/portal/shared/api.js";
import { renderMermaidBlocks } from "/portal/shared/markdown-mermaid.js";
import * as api from "./api.js";
import * as tmpl from "./templates.js";

export function createConfigModal() {
  const dialogEl = document.getElementById("config-modal");
  const titleEl = document.getElementById("modal-title");
  const pathEl = document.getElementById("modal-path");
  const costRowEl = document.getElementById("modal-cost-row");
  const contentEl = document.getElementById("modal-content");
  const footerEl = document.getElementById("modal-footer");
  const requiresEl = document.getElementById("modal-requires");
  const requiresListEl = document.getElementById("modal-requires-list");
  const backEl = document.getElementById("modal-back");
  let onBack = null;
  // Bumped by every view change, so a source fetch that resolves after the user moved on (Back
  // pressed mid-load) does not overwrite the view now showing.
  let viewSeq = 0;

  document.getElementById("modal-close").addEventListener("click", close);
  portalWireBackdropClose(dialogEl, close);
  backEl.addEventListener("click", () => onBack?.());

  function setBack(handler) {
    onBack = handler || null;
    backEl.hidden = !onBack;
  }

  function setPaths(pathText) {
    const paths = Array.isArray(pathText)
      ? pathText
      : String(pathText || "").split(" + ");
    pathEl.replaceChildren(
      ...paths
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const row = document.createElement("span");
          row.textContent = p;
          return row;
        }),
    );
  }

  // `chips` is an array of { label, spec } — a dedicated row below the path, one labeled chip
  // per moment a cost applies ("Startup:", "When loaded:"), never mixed into the title line.
  function setHeader(title, pathText, chips = []) {
    titleEl.textContent = title || "";
    setPaths(pathText);
    costRowEl.replaceChildren(...chips.map((entry) => tmpl.labeledTokenChip(entry)));
    costRowEl.hidden = chips.length === 0;
  }

  function setContent(data) {
    contentEl.classList.remove("plain-source");
    if (data?.html) {
      contentEl.innerHTML = data.html;
      // Inspected sources are rendered markdown (skills, rules, guides), so any ```mermaid block
      // in them becomes a real diagram instead of raw source text.
      renderMermaidBlocks(contentEl);
    } else {
      contentEl.textContent = data?.content || "(empty)";
    }
  }

  // The inspected package's required packages, each opening its own source via onSelect.
  function setRequires(requires = [], onSelect = null) {
    const refs = onSelect ? requires : [];
    requiresListEl.replaceChildren(...refs.map((ref) => tmpl.requiredReference(ref, onSelect)));
    requiresEl.hidden = refs.length === 0;
  }

  function setFooter(node) {
    if (node) {
      footerEl.replaceChildren(node);
      footerEl.hidden = false;
    } else {
      footerEl.replaceChildren();
      footerEl.hidden = true;
    }
  }

  function open() {
    if (!dialogEl.open) dialogEl.showModal();
  }

  function close() {
    dialogEl.close();
  }

  // fetch-then-show: the source-inspect entry point (inspect-click, config-files grid click).
  async function openSource(inspect, { rules, harnesses, onDefaultClick, chips = [], back = null, requires = [], onRequire = null }) {
    const seq = ++viewSeq;
    setBack(back);
    setRequires(requires, onRequire);
    setHeader(inspect.label || inspect.id, "loading…");
    contentEl.innerHTML = "";
    setFooter(null);
    open();
    try {
      const data = await api.fetchSource(inspect);
      if (seq !== viewSeq) return;
      if (!data.ok) {
        setHeader(inspect.label || inspect.id, "");
        contentEl.textContent = "error: " + (data.error || "failed to load");
        return;
      }
      setHeader(data.title || inspect.label, data.paths || data.path || "", chips);
      setContent(data);
      if (inspect.kind === "live-rules") {
        setFooter(tmpl.modalDefaults(rules, harnesses, onDefaultClick));
      }
    } catch (e) {
      if (seq !== viewSeq) return;
      setHeader(inspect.label || inspect.id, "");
      contentEl.textContent = "error: " + e.message;
    }
  }

  // Contents entries and requirements are already in the snapshot, so nothing is fetched;
  // selecting an entry calls `onSelect(entry)`, which opens that
  // entry's source view with a Back that calls showContents again.
  function showContents(inspect, { chips = [], entryChipSpec, onSelect, back = null, requires = [], onRequire = null }) {
    viewSeq += 1;
    setBack(back);
    setRequires(requires, onRequire);
    setHeader(inspect.label || inspect.id, "", chips);
    contentEl.classList.remove("plain-source");
    contentEl.replaceChildren(tmpl.packageContents(inspect, { entryChipSpec, onSelect }));
    setFooter(null);
    open();
  }

  // show-already-known-data: the defaults-menu entry point (globals baseline/per-harness/packages).
  function openSnapshot(title, pathText, data) {
    viewSeq += 1;
    setBack(null);
    setRequires();
    setHeader(title, pathText);
    setContent(data);
    setFooter(null);
    open();
  }

  // A repo file's popup, laid out like the global page's: title, every location the row stands for,
  // cost chips, then the body the server rendered (Markdown without images, the skill view, or a
  // list of config keys with safe values). Without rendered HTML it falls back to plain text.
  async function openRepositorySource(group, { load, gitLabel }) {
    const { primary, entries } = group;
    const seq = ++viewSeq;
    const title = primary.name || primary.path.split("/").at(-1);
    const locations = entries.map((entry) => (entry.linkTarget ? `${entry.path} → ${entry.linkTarget}` : entry.path));
    setBack(null);
    setRequires();
    setHeader(title, "loading…");
    contentEl.replaceChildren();
    setFooter(null);
    open();
    try {
      const data = await load();
      if (seq !== viewSeq) return;
      const meta = [group.harnessNames.join(" · "), gitLabel(data.git)].join(" — ");
      setHeader(data.title || title, [...locations, meta], repositoryChips(data, primary));
      if (data.html) {
        setContent(data);
      } else if (data.format === "text") {
        setPlainContent(data.truncated ? `${data.content}\n\n… Preview truncated.` : data.content);
      } else {
        const lines = data.sections?.length ? data.sections : ["No recognized sections."];
        setPlainContent([...lines, ...(data.diagnostic ? ["", data.diagnostic] : [])].join("\n"));
      }
    } catch (e) {
      if (seq !== viewSeq) return;
      setHeader(title, locations);
      setPlainContent("error: " + e.message);
    }
  }

  // The global popup's chips: a skill or command costs its description at startup and its body when
  // run; an instruction file costs its size when a session reads it.
  function repositoryChips(data, primary) {
    const chips = [];
    if (data.discoveryTokens != null) {
      chips.push({ label: "Startup", spec: { tokens: data.discoveryTokens, level: null, detail: "Name and description, read at the start of every session." } });
    }
    if (data.tokens != null) {
      // A skill's body is colored nowhere on the global page either: only startup cost is.
      const runnable = data.discoveryTokens != null;
      const label = runnable ? "When run" : data.loading === "root-level" ? "Startup" : "When loaded";
      chips.push({ label, spec: { tokens: data.tokens, level: runnable ? null : primary.tokenLevel || null, detail: "Estimated size of this file alone." } });
    }
    return chips;
  }

  function setPlainContent(text) {
    contentEl.classList.add("plain-source");
    contentEl.textContent = text;
  }

  // A scope change abandons whatever the dialog shows or is still loading.
  function reset() {
    viewSeq += 1;
    if (dialogEl.open) close();
  }

  return { openSource, openSnapshot, showContents, openRepositorySource, reset };
}

// The disable-with-dependents dialog: a package being turned off is included in packages the user
// turned on. `confirm` resolves true when they choose to disable those too, false otherwise
// (Leave them enabled, close, Escape, or the backdrop).
export function createDisableDependentsDialog() {
  const dialogEl = document.getElementById("disable-dependents-modal");
  const titleEl = document.getElementById("disable-dependents-title");
  const leadEl = document.getElementById("disable-dependents-lead");
  const listEl = document.getElementById("disable-dependents-list");
  let settle = null;

  function finish(confirmed) {
    const resolve = settle;
    settle = null;
    if (dialogEl.open) dialogEl.close();
    resolve?.(confirmed);
  }

  document.getElementById("disable-dependents-close").addEventListener("click", () => finish(false));
  document.getElementById("disable-dependents-cancel").addEventListener("click", () => finish(false));
  document.getElementById("disable-dependents-confirm").addEventListener("click", () => finish(true));
  dialogEl.addEventListener("cancel", () => finish(false));
  portalWireBackdropClose(dialogEl, () => finish(false));

  function confirm(packageLabel, includedBy) {
    finish(false);
    titleEl.textContent = `Disable ${packageLabel}`;
    leadEl.textContent = `The following other packages depend on ${packageLabel}:`;
    listEl.replaceChildren(...includedBy.map((pkg) => {
      const li = document.createElement("li");
      li.textContent = pkg.label;
      return li;
    }));
    return new Promise((resolve) => {
      settle = resolve;
      dialogEl.showModal();
    });
  }

  return { confirm };
}

// The recommendations dialog: after an enable that left some recommended packages off, it lists
// them as the page's own rows. Each switch turns its package on or off at once through the page's
// toggle, so the dialog itself enables nothing. The footer reads "No Thanks" until one of them is
// on and "Done" after; either way it only closes. `ask` resolves when the dialog closes.
export function createRecommendationsDialog() {
  const dialogEl = document.getElementById("recommendations-modal");
  const titleEl = document.getElementById("recommendations-title");
  const listEl = document.getElementById("recommendations-list");
  const doneEl = document.getElementById("recommendations-done");
  let current = null; // { ids, rowFor, renderRow, settle }

  function finish() {
    const settle = current?.settle;
    current = null;
    if (dialogEl.open) dialogEl.close();
    settle?.();
  }

  document.getElementById("recommendations-close").addEventListener("click", finish);
  doneEl.addEventListener("click", finish);
  dialogEl.addEventListener("cancel", finish);
  portalWireBackdropClose(dialogEl, finish);

  // Rows come from the latest snapshot, so a switch flipped here, or anywhere else on the page,
  // shows its new state the next time the page re-renders.
  function refresh() {
    if (!current) return;
    const rows = current.ids.map(current.rowFor).filter(Boolean);
    listEl.replaceChildren(...rows.map(current.renderRow));
    const anyOn = rows.some((row) => row.active);
    doneEl.textContent = anyOn ? "Done" : "No Thanks";
    doneEl.dataset.btn = anyOn ? "cta" : "secondary";
  }

  // `rowFor(id)` returns the package's row item from the latest snapshot; `renderRow(item)` builds
  // its row element.
  function ask(packageLabel, recommendations, { rowFor, renderRow }) {
    finish();
    titleEl.textContent = `Additional packages recommended for ${packageLabel}`;
    return new Promise((settle) => {
      current = { ids: recommendations.map((rec) => rec.id), rowFor, renderRow, settle };
      refresh();
      dialogEl.showModal();
    });
  }

  return { ask, refresh };
}
