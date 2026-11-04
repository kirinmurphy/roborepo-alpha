// Backlog's navigation and ordering controller: repositories, then namespaces, then one list shown as
// Details or Ordering. It owns the Ordering draft and everything that protects it. Other lifecycle
// tabs never reach this module.
//
// A draft is local until Save. Every way out of a dirty draft goes through confirmLeave: the mode
// toggle, breadcrumbs, and directory rows directly, and the lifecycle tabs, repo selector, header
// links, and back/forward through the seams app.js wires to it.
import { portalTpl as tpl, portalFillSlots as fill } from "/portal/shared/api.js";
import {
  clearRepositoryScope,
  currentRepositoryScope,
  hrefWithRepositoryScope,
  setRepositoryScope,
} from "/portal/shared/repository-scope.js";
import * as api from "./api.js";
import {
  NO_NAMESPACE,
  createDraft,
  displayTitle,
  dropBlock,
  hrefWithNamespace,
  isDraftDirty,
  moveBlock,
  namespaceDirectory,
  namespaceFromSearch,
  orderedIds,
  repositoryDirectory,
} from "./backlog-model.js";

const GUARD_MESSAGE = "Your prioritization changes have not been saved.";

// deps: { getSnapshot, onRender, onSaved, onOpen, cardGrid, emptyState, copyRepairPrompt }
export function createBacklogController(deps) {
  const guardDialog = document.getElementById("ordering-guard");
  const discardDialog = document.getElementById("ordering-discard");
  let mode = "details";
  let draft = null;
  let draftUrl = null;
  // The repo and namespace the mode and draft belong to; any other selection starts over in Details.
  let selectionKey = null;
  let drag = null;
  let saveError = null;
  let pendingFocus = null;
  // The Save in flight, so a double click or a guard's Save joins it rather than sending a second.
  let saving = null;
  // What the draft was opened from. A stale draft keeps rendering from this, since its namespace or
  // plans may no longer be in the snapshot.
  let draftSource = null;

  bindDialogs();
  window.addEventListener("beforeunload", (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  function isDirty() {
    return mode === "ordering" && isDraftDirty(draft);
  }

  function isOrdering() {
    return mode === "ordering";
  }

  function selectedEntry() {
    const scope = currentRepositoryScope();
    const backlog = deps.getSnapshot().backlog || [];
    return scope ? backlog.find((entry) => entry.urlKey === scope) || null : null;
  }

  function selectedNamespaceView() {
    const entry = selectedEntry();
    const namespace = namespaceFromSearch(location.search);
    if (!entry || !namespace || namespace === NO_NAMESPACE) return null;
    return entry.namespaces.find((view) => view.namespace === namespace) || null;
  }

  // Runs on each render, which is how a new snapshot reaches it. A clean draft follows the server; a
  // dirty one is never overwritten, and is flagged stale when the namespace it was opened from has
  // changed or is gone, so the safeguards still stand until the user discards it.
  function reconcile() {
    const entry = selectedEntry();
    const scope = currentRepositoryScope();
    const namespace = namespaceFromSearch(location.search);
    const key = scope && namespace ? `${scope}\0${namespace}` : null;
    if (key !== selectionKey) {
      selectionKey = key;
      mode = "details";
      draft = null;
      saveError = null;
    }
    const view = selectedNamespaceView();
    if (!view) {
      if (isDirty()) {
        draft = { ...draft, stale: true };
        return;
      }
      mode = "details";
      draft = null;
      return;
    }
    if (mode !== "ordering") return;
    if (!draft || !isDraftDirty(draft)) {
      draft = createDraft(view);
      draftSource = { entry, view, plans: plansByKey() };
    } else if (draft.revision !== view.revision) {
      draft = { ...draft, stale: true };
    }
  }

  // The nodes for the current Backlog level. `matching` is the plans the Filters popup leaves, in
  // this lifecycle only; Ordering ignores it and always shows the whole namespace.
  function render(matching, cardActions) {
    reconcile();
    if (isDirty() && draft.stale) return renderOrdering(draftSource.entry, draftSource.view, draftSource.plans);
    const matchingKeys = new Set(matching.map((record) => record.key));
    const entry = selectedEntry();
    const namespace = namespaceFromSearch(location.search);
    if (!currentRepositoryScope()) return renderRepositories(matchingKeys);
    if (!entry) return [deps.emptyState()];
    if (namespace === NO_NAMESPACE && entry.noNamespace.length) return renderNoNamespace(entry, matchingKeys, cardActions);
    const view = selectedNamespaceView();
    if (!view) return renderNamespaces(entry, matchingKeys);
    return mode === "ordering" ? renderOrdering(entry, view, plansByKey()) : renderDetails(entry, view, matchingKeys, cardActions);
  }

  function renderRepositories(matchingKeys) {
    const rows = repositoryDirectory(deps.getSnapshot().backlog || [], matchingKeys);
    if (!rows.length) return [deps.emptyState()];
    return [breadcrumb([{ label: "All repos" }]), directoryList(rows.map((row) => directoryRow({
      icon: "folder",
      label: row.name,
      planCount: row.planCount,
      unprioritizedCount: row.unprioritizedCount,
      href: row.urlKey ? hrefWithNamespace(hrefWithRepositoryScope(location.href, row.urlKey), null) : null,
      onSelect: () => setRepositoryScope(row.urlKey),
    })))];
  }

  function renderNamespaces(entry, matchingKeys) {
    const rows = namespaceDirectory(entry, matchingKeys);
    const notices = repositoryNotices(entry);
    if (!rows.length) return [...notices, deps.emptyState()];
    return [
      breadcrumb(repositoryCrumbs(entry)),
      ...notices,
      directoryList(rows.map((row) => directoryRow(row.namespace === NO_NAMESPACE
        ? {
          icon: "warning",
          label: "No namespace",
          planCount: row.planCount,
          status: entry.config.state === "declared" ? "Repair needed" : "",
          href: hrefWithNamespace(location.href, NO_NAMESPACE),
          onSelect: () => selectNamespace(NO_NAMESPACE),
        }
        : {
          icon: "plans",
          label: row.namespace.toUpperCase(),
          planCount: row.planCount,
          unprioritizedCount: row.unprioritizedCount,
          href: hrefWithNamespace(location.href, row.namespace),
          onSelect: () => selectNamespace(row.namespace),
        }))),
    ];
  }

  function repositoryNotices(entry) {
    const notices = [];
    if (entry.config.state === "none") notices.push(fill(tpl("tpl-backlog-no-config"), {}));
    for (const item of entry.findings) notices.push(fill(tpl("tpl-backlog-finding"), { message: item.message, resolution: item.resolution }));
    return notices;
  }

  function renderNoNamespace(entry, matchingKeys, cardActions) {
    const plans = plansByKey();
    const records = entry.noNamespace.filter((key) => matchingKeys.has(key)).map((key) => plans.get(key));
    const header = [breadcrumb([...repositoryCrumbs(entry, true), { label: "No namespace" }]), ...repositoryNotices(entry)];
    if (!records.length) return [...header, deps.emptyState()];
    // A repo that never adopted the naming convention has nothing to repair, so its plans stay
    // ordinary cards with their usual actions. Only a declared vocabulary makes a filename wrong.
    if (entry.config.state !== "declared") return [...header, deps.cardGrid(records, cardActions)];
    return [...header, directoryList(records.map((record) => repairRow(record)))];
  }

  function repairRow(record) {
    const node = fill(tpl("tpl-backlog-repair"), { filename: record.plan.relativePath.split("/").pop() });
    const title = node.querySelector("[data-slot=title]");
    title.textContent = record.plan.title;
    title.addEventListener("click", () => deps.onOpen(record.key));
    const list = node.querySelector("[data-slot=findings]");
    list.hidden = false;
    for (const item of record.plan.validation.findings.filter(isNamingFinding)) {
      list.append(fill(tpl("tpl-backlog-finding-line"), { message: item.message, resolution: item.resolution }));
    }
    const repair = node.querySelector("[data-slot=repair]");
    repair.hidden = false;
    repair.addEventListener("click", () => deps.copyRepairPrompt(record.key));
    return node;
  }

  function renderDetails(entry, view, matchingKeys, cardActions) {
    const plans = plansByKey();
    const cards = (keys) => keys.filter((key) => matchingKeys.has(key)).map((key) => plans.get(key));
    const pending = cards([...view.needsPrioritization.flatMap((block) => block.keys), ...view.unrankable]);
    const ordered = cards(view.ordered.flatMap((block) => block.keys));
    const titled = { ...cardActions, titleFor: (record) => displayTitle(record.plan) };
    const sections = [];
    if (pending.length) sections.push(sectionNode(`Needs prioritization (${pending.length})`, deps.cardGrid(pending, titled)));
    if (ordered.length) sections.push(sectionNode("Ordered", deps.cardGrid(ordered, titled)));
    return [namespaceHeader(entry, view), ...(sections.length ? sections : [deps.emptyState()])];
  }

  function renderOrdering(entry, view, plans) {
    const locked = view.locked || !view.writable;
    const blockNode = (block, section, index, count) => {
      const node = document.createElement("backlog-block");
      Object.assign(node, { block, section, index, count, plans, locked, onOpen: deps.onOpen });
      return node;
    };
    const nodes = [namespaceHeader(entry, view)];
    for (const reason of view.reasons) nodes.push(fill(tpl("tpl-backlog-finding"), { message: reason, resolution: "Repair the dependency graph; ordering stays locked until then." }));
    if (!view.writable) nodes.push(...entry.findings.filter((item) => item.severity === "blocking").map((item) => fill(tpl("tpl-backlog-finding"), { message: item.message, resolution: item.resolution })));
    const notice = moveNotice(view, plans);
    if (notice) nodes.push(notice);
    if (draft.needs.length || view.unrankable.length) {
      const list = document.createElement("div");
      list.className = "backlog-order-list";
      list.append(...draft.needs.map((block, index) => blockNode(block, "needs", index, draft.needs.length)));
      for (const key of view.unrankable) list.append(unrankableRow(plans.get(key)));
      nodes.push(sectionNode(`Needs prioritization (${draft.needs.length + view.unrankable.length})`, list));
    }
    const orderedList = document.createElement("div");
    orderedList.className = "backlog-order-list";
    orderedList.dataset.dropTarget = "ordered";
    orderedList.append(...draft.ordered.map((block, index) => blockNode(block, "ordered", index, draft.ordered.length)));
    if (!draft.ordered.length) orderedList.append(tpl("tpl-backlog-drop-empty"));
    wireDropTarget(orderedList);
    nodes.push(sectionNode("Ordered", orderedList));
    if (isDirty()) nodes.push(actionBar());
    const container = document.createElement("div");
    container.className = "backlog-ordering";
    container.append(...nodes);
    container.addEventListener("block-move", (event) => {
      if (saving) return;
      const { section, index, action } = event.detail;
      const block = (section === "needs" ? draft.needs : draft.ordered)[index];
      pendingFocus = { id: block.ids[0], action };
      updateDraft(moveBlock(draft, section, index, action));
    });
    container.addEventListener("block-drag", (event) => { drag = event.detail; });
    // A cancelled drag ends with no drop, and must not leave its block armed for the next one.
    container.addEventListener("block-drag-end", () => {
      drag = null;
      for (const node of container.querySelectorAll(".drop-before, .drop-after")) node.classList.remove("drop-before", "drop-after");
    });
    queueMicrotask(restoreFocus);
    return [container];
  }

  // Automatic regrouping needs no approval and reaches the file at the next write, so the only thing
  // owed to the user is seeing what moved and why.
  function moveNotice(view, plans) {
    if (!view.moves.length) return null;
    const attached = view.moves.filter((move) => move.kind === "attached").map((move) => plans.get(move.key).plan.title);
    const moved = view.moves.filter((move) => move.kind === "moved").map((move) => plans.get(move.key).plan.title);
    const parts = [];
    if (attached.length) parts.push(`Joined a ranked group: ${attached.join(", ")}.`);
    if (moved.length) parts.push(`Moved to stay with linked plans: ${moved.join(", ")}.`);
    return fill(tpl("tpl-backlog-move-notice"), { text: parts.join(" ") });
  }

  function unrankableRow(record) {
    const reason = record.plan.id ? `Duplicate id: ${record.plan.id}` : "No id";
    const node = fill(tpl("tpl-backlog-repair"), { filename: reason });
    const title = node.querySelector("[data-slot=title]");
    title.textContent = displayTitle(record.plan);
    title.addEventListener("click", () => deps.onOpen(record.key));
    return node;
  }

  function wireDropTarget(list) {
    const insertionIndex = (event) => {
      const blocks = [...list.querySelectorAll(":scope > backlog-block")];
      const found = blocks.findIndex((block) => {
        const box = block.getBoundingClientRect();
        return event.clientY < box.top + box.height / 2;
      });
      return found === -1 ? blocks.length : found;
    };
    const clearMarker = () => {
      for (const node of list.querySelectorAll(".drop-before, .drop-after")) node.classList.remove("drop-before", "drop-after");
    };
    list.addEventListener("dragover", (event) => {
      if (!drag) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearMarker();
      const blocks = list.querySelectorAll(":scope > backlog-block");
      const index = insertionIndex(event);
      if (index < blocks.length) blocks[index].classList.add("drop-before");
      else blocks[blocks.length - 1]?.classList.add("drop-after");
    });
    list.addEventListener("dragleave", (event) => {
      if (!list.contains(event.relatedTarget)) clearMarker();
    });
    list.addEventListener("drop", (event) => {
      if (!drag || saving) return;
      event.preventDefault();
      const { section, index } = drag;
      const before = insertionIndex(event);
      drag = null;
      updateDraft(dropBlock(draft, section, index, before));
    });
  }

  function updateDraft(next) {
    draft = next;
    saveError = null;
    deps.onRender();
  }

  // A re-render replaces the buttons, so focus returns to the same control on the moved block, or to
  // its first enabled control when that one no longer applies at the new position.
  function restoreFocus() {
    if (!pendingFocus) return;
    const { id, action } = pendingFocus;
    pendingFocus = null;
    const block = document.querySelector(`backlog-block[data-block-id="${CSS.escape(id)}"]`);
    if (!block) return;
    const target = block.querySelector(`button[data-action="${action}"]:not(:disabled)`) || block.querySelector("button[data-action]:not(:disabled)");
    target?.focus();
  }

  function namespaceHeader(entry, view) {
    const node = tpl("tpl-backlog-namespace-header");
    node.querySelector("[data-slot=breadcrumb]").replaceWith(breadcrumb([...repositoryCrumbs(entry, true), { label: view.namespace.toUpperCase() }]));
    for (const button of node.querySelectorAll("[data-mode]")) {
      const selected = button.dataset.mode === mode;
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", () => selectMode(button.dataset.mode));
    }
    return node;
  }

  function selectMode(next) {
    if (next === mode) return;
    if (next === "ordering") {
      draft = null;
      draftUrl = location.href;
      mode = "ordering";
      deps.onRender();
      return;
    }
    confirmLeave(() => {
      mode = "details";
      draft = null;
      saveError = null;
      deps.onRender();
    });
  }

  function selectNamespace(namespace) {
    history.pushState(null, "", hrefWithNamespace(location.href, namespace));
    window.scrollTo(0, 0);
    deps.onRender();
  }

  function repositoryCrumbs(entry, linked = false) {
    const all = { label: "All repos", onSelect: clearRepositoryScope, href: hrefWithNamespace(hrefWithRepositoryScope(location.href, null), null) };
    const repository = linked
      ? { label: entry.name, onSelect: () => confirmLeave(() => selectNamespace(null)), href: hrefWithNamespace(location.href, null) }
      : { label: entry.name };
    return [all, repository];
  }

  function actionBar() {
    const node = tpl("tpl-backlog-action-bar");
    const status = node.querySelector("[data-slot=status]");
    status.textContent = draft.stale
      ? "This namespace changed elsewhere. Cancel to load the current order, then make your changes again."
      : saveError || "Unsaved changes";
    status.classList.toggle("is-error", Boolean(draft.stale || saveError));
    const save = node.querySelector("[data-slot=save]");
    save.disabled = draft.stale;
    save.addEventListener("click", () => {
      save.disabled = true;
      void saveDraft();
    });
    node.querySelector("[data-slot=cancel]").addEventListener("click", () => discardDialog.showModal());
    return node;
  }

  // Resolves true once the order is saved and the page holds the new snapshot. A failure keeps the
  // draft, says why, and resolves false, so a navigation waiting on it never goes ahead.
  function saveDraft() {
    saving ??= submitDraft().finally(() => { saving = null; });
    return saving;
  }

  async function submitDraft() {
    const entry = selectedEntry();
    if (!entry) return false;
    try {
      await api.saveBacklogOrder({
        repositoryId: entry.repositoryId,
        namespace: draft.namespace,
        order: orderedIds(draft),
        revision: draft.revision,
      });
    } catch (err) {
      if (err.code === "STALE_ORDER") draft = { ...draft, stale: true };
      saveError = [err.message, err.resolution].filter(Boolean).join(" ");
      deps.onRender();
      return false;
    }
    draft = null;
    saveError = null;
    await deps.onSaved();
    return true;
  }

  // Runs `proceed` now when there is nothing to lose; otherwise asks first. Save and continue only
  // proceeds after a successful Save, and Cancel leaves the draft and the page as they are.
  function confirmLeave(proceed) {
    if (!isDirty()) {
      proceed();
      return;
    }
    guardDialog.querySelector("[data-slot=message]").textContent = GUARD_MESSAGE;
    guardDialog.querySelector("[data-slot=error]").textContent = draft.stale ? "This namespace changed elsewhere, so this order can't be saved." : "";
    const save = guardDialog.querySelector("[data-slot=save]");
    save.disabled = draft.stale;
    save.onclick = async () => {
      save.disabled = true;
      const saved = await saveDraft();
      save.disabled = Boolean(draft?.stale);
      if (saved) {
        guardDialog.close();
        proceed();
      } else {
        guardDialog.querySelector("[data-slot=error]").textContent = saveError;
      }
    };
    guardDialog.showModal();
  }

  function bindDialogs() {
    guardDialog.querySelector("[data-slot=cancel]").addEventListener("click", () => guardDialog.close());
    discardDialog.querySelector("[data-slot=keep]").addEventListener("click", () => discardDialog.close());
    discardDialog.querySelector("[data-slot=discard]").addEventListener("click", () => {
      discardDialog.close();
      draft = null;
      saveError = null;
      void deps.onSaved();
    });
  }

  function plansByKey() {
    return new Map(deps.getSnapshot().plans.map((record) => [record.key, record]));
  }

  return {
    render,
    isDirty,
    isOrdering: () => {
      reconcile();
      return isOrdering();
    },
    confirmLeave,
    draftUrl: () => draftUrl,
  };
}

function isNamingFinding(item) {
  return ["INVALID_PLAN_FILENAME", "FORBIDDEN_PLAN_FILENAME_SUFFIX", "UNKNOWN_PLAN_NAMESPACE"].includes(item.code);
}

function sectionNode(title, content) {
  const node = fill(tpl("tpl-backlog-section"), { title });
  node.append(content);
  return node;
}

function directoryList(rows) {
  const list = tpl("tpl-backlog-directory");
  list.append(...rows);
  return list;
}

function directoryRow({ icon, label, planCount, unprioritizedCount = 0, status = "", href, onSelect }) {
  const node = fill(tpl("tpl-backlog-directory-row"), {
    label,
    count: `${planCount} ${planCount === 1 ? "plan" : "plans"}`,
    unprioritized: status || (unprioritizedCount ? `${unprioritizedCount} unprioritized` : ""),
  });
  node.querySelector("portal-icon[data-slot=icon]").setAttribute("name", icon);
  if (href) {
    node.href = href;
    node.addEventListener("click", (event) => {
      // Modified clicks open the level in a new tab or window as usual.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onSelect();
    });
  } else {
    node.setAttribute("aria-disabled", "true");
  }
  return node;
}

function breadcrumb(crumbs) {
  const nav = tpl("tpl-backlog-breadcrumb");
  crumbs.forEach((crumb, index) => {
    if (index) nav.append(fill(tpl("tpl-backlog-breadcrumb-separator"), {}));
    if (crumb.onSelect) {
      const link = fill(tpl("tpl-backlog-breadcrumb-link"), { label: crumb.label });
      link.href = crumb.href;
      link.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        crumb.onSelect();
      });
      nav.append(link);
    } else {
      nav.append(fill(tpl("tpl-backlog-breadcrumb-current"), { label: crumb.label }));
    }
  });
  return nav;
}
