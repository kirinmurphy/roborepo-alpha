// Backlog's navigation and ordering controller: repositories, then namespaces, then one list shown as
// Details or Prioritize. It owns the Prioritize draft and everything that protects it. Other lifecycle
// tabs never reach this module.
//
// A draft is local until Save. Every way out of a dirty draft goes through confirmLeave: the mode
// toggle and the repo breadcrumb directly, and the All repos breadcrumb, repo selector, lifecycle
// tabs, links outside the board, and back/forward through the seams app.js wires to it.
import { portalTpl as tpl, portalFillSlots as fill } from "/portal/shared/api.js";
import {
  clearRepositoryScope,
  currentRepositoryScope,
  hrefWithRepositoryScope,
  setRepositoryScope,
} from "/portal/shared/repository-scope.js";
import "/portal/shared/option-dropdown.js";
import * as api from "./api.js";
import { planDependencies } from "./templates.js";
import { createArchiveDialog } from "./archive-dialog.js";
import {
  NO_NAMESPACE,
  createDraft,
  dependencyTree,
  dependentsOf,
  dropBlock,
  hrefWithNamespace,
  isDraftDirty,
  moveBlock,
  namespaceDirectory,
  namespaceFromSearch,
  namespaceOptions,
  nextUp,
  orderedIds,
  repositoryDirectory,
  repositoryOptions,
  returnBlock,
  unprioritizedIds,
} from "./backlog-model.js";

const GUARD_MESSAGE = "Your prioritization changes have not been saved.";

// deps: { getSnapshot, onRender, onSaved, onOpen, cardGrid, emptyState, copyRepairPrompt, onError }
// onSaved reloads the snapshot after a change has landed and resolves whether that worked. It never
// rejects, because a failed reload does not mean the change failed; the page keeps saying so meanwhile.
export function createBacklogController(deps) {
  const guardDialog = document.getElementById("ordering-guard");
  let mode = "details";
  let draft = null;
  let draftUrl = null;
  // The repo and namespace the mode and draft belong to; any other selection starts over in Details.
  let selectionKey = null;
  // A newly selected namespace still owes its opening mode, which needs its view from the snapshot.
  let openingModeOwed = false;
  let drag = null;
  let saveError = null;
  let pendingFocus = null;
  // The Save in flight, so a double click or a guard's Save joins it rather than sending a second.
  let saving = null;
  // What the draft was opened from. A stale draft keeps rendering from this, since its namespace or
  // plans may no longer be in the snapshot.
  let draftSource = null;

  const archiveDialog = createArchiveDialog();
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

  // A sent Save, or a saved order the page has not been able to reload yet. Either way a move made now
  // would start from an order the server has already replaced.
  function isHeld() {
    return Boolean(saving || draft?.heldFor);
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

  // The page runs this before each render, which is how a new snapshot reaches it. A clean draft follows the server; a
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
      openingModeOwed = true;
    }
    if (draft?.heldFor) {
      // Only a newer snapshot releases a saved order that could not be reloaded.
      if (deps.getSnapshot() === draft.heldFor) return;
      mode = "details";
      draft = null;
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
    if (openingModeOwed) {
      openingModeOwed = false;
      // With nothing ordered yet, Details would be just the banner, so open where the work is. Only on
      // arrival: the Details toggle still works from here.
      if (!view.ordered.length && (view.needsPrioritization.length || view.unrankable.length)) {
        mode = "ordering";
        draft = null;
        draftUrl = location.href;
      }
    }
    if (mode !== "ordering") return;
    // The draft stands until its Save settles: what the snapshot says meanwhile is older than the Save.
    if (saving && draft) return;
    if (!draft || !isDraftDirty(draft)) {
      draft = createDraft(view);
      draftSource = { entry, view, plans: plansByKey() };
    } else if (draft.revision !== view.revision) {
      draft = { ...draft, stale: true };
    }
  }

  // The nodes for the current Backlog level. `matching` is the plans the Filters popup leaves, in
  // this lifecycle only; Prioritize ignores it and always shows the whole namespace.
  function render(matching, cardActions) {
    if (isDirty() && draft.stale) return renderOrdering(draftSource.entry, draftSource.view, draftSource.plans);
    const matchingKeys = new Set(matching.map((record) => record.key));
    const entry = selectedEntry();
    const namespace = namespaceFromSearch(location.search);
    if (!currentRepositoryScope()) return renderRepositories(matchingKeys);
    if (!entry) return [deps.emptyState()];
    if (namespace === NO_NAMESPACE && entry.noNamespace.length) return renderNoNamespace(entry, matchingKeys, cardActions);
    const view = selectedNamespaceView();
    if (!view) return renderNamespaces(entry, matchingKeys, cardActions);
    return mode === "ordering" ? renderOrdering(entry, view, plansByKey()) : renderDetails(entry, view, matchingKeys, cardActions);
  }

  function renderRepositories(matchingKeys) {
    const rows = repositoryDirectory(deps.getSnapshot().backlog || [], matchingKeys, deps.getSnapshot().plans);
    if (!rows.length) return [deps.emptyState()];
    return [breadcrumb([{ label: "All repos" }]), directoryList(rows.map((row) => directoryRow({
      icon: "folder",
      label: row.name,
      readyCount: row.readyCount,
      unprioritizedCount: row.unprioritizedCount,
      planCount: row.planCount,
      href: row.urlKey ? hrefWithNamespace(hrefWithRepositoryScope(location.href, row.urlKey), null) : null,
      onSelect: () => setRepositoryScope(row.urlKey),
    })))];
  }

  function renderNamespaces(entry, matchingKeys, cardActions) {
    const rows = namespaceDirectory(entry, matchingKeys, deps.getSnapshot().plans);
    const notices = repositoryNotices(entry);
    if (!rows.length) return [...notices, deps.emptyState()];
    return [
      breadcrumb(repositoryCrumbs(entry)),
      ...notices,
      ...nextUpSection(entry, matchingKeys, cardActions),
      sectionNode("All Plans", directoryList(rows.map((row) => directoryRow(row.namespace === NO_NAMESPACE
        ? {
          icon: "warning",
          label: "No namespace",
          chevron: false,
          planCount: row.planCount,
          status: entry.config.state === "declared" ? "Repair needed" : "",
          href: hrefWithNamespace(location.href, NO_NAMESPACE),
          onSelect: () => selectNamespace(NO_NAMESPACE),
        }
        : {
          icon: "plans",
          label: row.namespace.toUpperCase(),
          chevron: false,
          readyCount: row.readyCount,
          unprioritizedCount: row.unprioritizedCount,
          planCount: row.planCount,
          href: hrefWithNamespace(location.href, row.namespace),
          onSelect: () => selectNamespace(row.namespace),
          pin: { pinned: row.pinned, onToggle: () => togglePin(entry, row) },
        })))),
    ];
  }

  async function togglePin(entry, row) {
    try {
      await api.setNamespacePinned({ repositoryId: entry.repositoryId, namespace: row.namespace, pinned: !row.pinned });
      await deps.onSaved();
    } catch (err) {
      deps.onError(err);
    }
  }

  // The cards Details shows, plus a badge that goes to the plan's namespace. Nothing here changes an order.
  function nextUpSection(entry, matchingKeys, cardActions) {
    const records = nextUp(entry, deps.getSnapshot().plans, matchingKeys);
    if (!records.length) return [];
    const section = sectionNode("Next up", deps.cardGrid(records, { ...cardActions, onSelectNamespace: selectNamespace, namespaceAction: namespaceActionFor(entry) }));
    section.setAttribute("aria-label", "Next up");
    const title = section.querySelector(".backlog-section-title");
    const header = tpl("tpl-backlog-next-up-header");
    title.replaceWith(header);
    header.prepend(title);
    return [section];
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
    const header = [breadcrumb([...repositoryCrumbs(entry, true), namespaceCrumb(entry, NO_NAMESPACE)]), ...repositoryNotices(entry)];
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
    const pendingCount = [...view.needsPrioritization.flatMap((block) => block.keys), ...view.unrankable].filter((key) => matchingKeys.has(key)).length;
    // The tree's order, so a card sits in the same place as its row in Prioritize.
    const ordered = view.ordered
      .flatMap((block) => dependencyTree(block.keys, plans).map((row) => row.key))
      .filter((key) => matchingKeys.has(key))
      .map((key) => plans.get(key));
    const content = [];
    if (pendingCount) content.push(prioritizeBanner(pendingCount));
    if (ordered.length) content.push(deps.cardGrid(ordered, { ...cardActions, namespaceAction: namespaceActionFor(entry) }));
    return [namespaceHeader(entry, view), ...graphNotices(view), ...(content.length ? content : [deps.emptyState()])];
  }

  function prioritizeBanner(count) {
    const node = fill(tpl("tpl-backlog-prioritize-banner"), { text: `${count} new ${count === 1 ? "plan needs" : "plans need"} prioritization` });
    node.querySelector("[data-slot=prioritize]").addEventListener("click", () => selectMode("ordering"));
    return node;
  }

  function renderOrdering(entry, view, plans) {
    const locked = view.locked || !view.writable;
    const namespaceAction = namespaceActionFor(entry);
    const blockNode = (block, section, index, count) => {
      const node = document.createElement("backlog-block");
      Object.assign(node, { block, section, index, count, plans, locked, held: isHeld(), dirty: isDirty(), onOpen: deps.onOpen, namespaceAction });
      return node;
    };
    const nodes = [namespaceHeader(entry, view), ...graphNotices(view)];
    if (!view.writable) nodes.push(...entry.findings.filter((item) => item.severity === "blocking").map((item) => fill(tpl("tpl-backlog-finding"), { message: item.message, resolution: item.resolution })));
    const notice = draft.heldFor ? savedNotice() : moveNotice(view, plans);
    if (notice) nodes.push(notice);
    if (draft.needs.length || view.unrankable.length) {
      const list = document.createElement("div");
      list.className = "backlog-order-list";
      list.append(...draft.needs.map((block, index) => blockNode(block, "needs", index, draft.needs.length)));
      for (const key of view.unrankable) list.append(unrankableRow(plans.get(key), namespaceAction));
      nodes.push(sectionNode("Needs prioritization", list));
    }
    const orderedList = document.createElement("div");
    orderedList.className = "backlog-order-list";
    orderedList.dataset.dropTarget = "ordered";
    orderedList.setAttribute("role", "group");
    orderedList.setAttribute("aria-label", "Prioritized plans");
    orderedList.append(...draft.ordered.map((block, index) => blockNode(block, "ordered", index, draft.ordered.length)));
    if (!draft.ordered.length) orderedList.append(tpl("tpl-backlog-drop-empty"));
    wireDropTarget(orderedList);
    const prioritized = sectionNode("Prioritized", orderedList);
    const returnZone = draft.ordered.length && !locked ? tpl("tpl-backlog-drop-return") : null;
    if (returnZone) {
      wireReturnZone(returnZone);
      prioritized.append(returnZone);
    }
    nodes.push(prioritized);
    if (isDirty()) nodes.push(actionBar());
    const container = document.createElement("div");
    container.className = "backlog-ordering";
    container.append(...nodes);
    container.addEventListener("block-move", (event) => {
      if (isHeld()) return;
      const { section, index, action } = event.detail;
      const block = (section === "needs" ? draft.needs : draft.ordered)[index];
      pendingFocus = { id: block.ids[0], action };
      updateDraft(moveBlock(draft, section, index, action));
    });
    container.addEventListener("block-archive", (event) => openArchive(entry, plans.get(event.detail.key)));
    container.addEventListener("block-drag", (event) => { drag = event.detail; });
    // A cancelled drag ends with no drop, and must not leave its block armed for the next one.
    container.addEventListener("block-drag-end", () => {
      drag = null;
      for (const node of container.querySelectorAll(".drop-before, .drop-after")) node.classList.remove("drop-before", "drop-after");
      orderedList.classList.remove("is-drop-over");
      returnZone?.classList.remove("is-drop-over");
    });
    queueMicrotask(restoreFocus);
    return [container];
  }

  function openArchive(entry, record) {
    const dependents = dependentsOf(record, deps.getSnapshot().plans);
    const titles = (bound) => dependents.filter((item) => Boolean(item.plan.worktree) === bound).map((item) => item.plan.title);
    archiveDialog.open({
      title: record.plan.title,
      released: titles(false),
      kept: titles(true),
      onConfirm: async (reason) => {
        try {
          await api.archiveBacklogPlan({ repositoryId: entry.repositoryId, id: record.plan.id, reason });
        } catch (err) {
          // The plan did move, so the list behind the dialog must stop offering it.
          if (err.code === "MOVE_NOT_COMMITTED") await deps.onSaved();
          throw err;
        }
        // The dialog stays up until then, so the archived plan's controls are never offered again.
        await deps.onSaved();
      },
    });
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

  function savedNotice() {
    return fill(tpl("tpl-backlog-move-notice"), { text: "Your order was saved. You can change it again once the page loads the latest plans." });
  }

  function unrankableRow(record, namespaceAction) {
    const reason = record.plan.id ? `Duplicate id: ${record.plan.id}` : "No id";
    const node = fill(tpl("tpl-backlog-repair"), { filename: reason });
    const title = node.querySelector("[data-slot=title]");
    title.textContent = record.plan.title;
    title.addEventListener("click", () => deps.onOpen(record.key));
    const waiting = planDependencies(record, deps.getSnapshot().plans, deps.onOpen, { namespaceAction });
    if (waiting) node.append(waiting);
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
      list.classList.remove("is-drop-over");
    };
    list.addEventListener("dragover", (event) => {
      if (!drag) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearMarker();
      const blocks = list.querySelectorAll(":scope > backlog-block");
      const index = insertionIndex(event);
      if (index < blocks.length) blocks[index].classList.add("drop-before");
      else if (blocks.length) blocks[blocks.length - 1].classList.add("drop-after");
      // No row to mark a position against, so the empty list itself lights up.
      else list.classList.add("is-drop-over");
    });
    list.addEventListener("dragleave", (event) => {
      if (!list.contains(event.relatedTarget)) clearMarker();
    });
    list.addEventListener("drop", (event) => {
      if (!drag || isHeld()) return;
      event.preventDefault();
      const { section, index } = drag;
      const before = insertionIndex(event);
      drag = null;
      updateDraft(dropBlock(draft, section, index, before));
    });
  }

  // Only a block already in Prioritized has anywhere to return from.
  function wireReturnZone(zone) {
    zone.addEventListener("dragover", (event) => {
      if (drag?.section !== "ordered") return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      zone.classList.add("is-drop-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-drop-over"));
    zone.addEventListener("drop", (event) => {
      if (drag?.section !== "ordered" || isHeld()) return;
      event.preventDefault();
      const { index } = drag;
      drag = null;
      updateDraft(returnBlock(draft, index));
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
    node.querySelector("[data-slot=breadcrumb]").replaceWith(breadcrumb([...repositoryCrumbs(entry, true), namespaceCrumb(entry, view.namespace)]));
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

  // A Waiting on badge does what the namespace filter does: it asks before leaving unsaved changes,
  // and it only leads to a namespace the filter offers. A prerequisite's namespace may have no plans
  // in Backlog, and so no screen to open.
  function namespaceActionFor(entry) {
    const offered = new Set(namespaceOptions(entry).map(([value]) => value));
    return (namespace) => (offered.has(namespace) ? (next) => confirmLeave(() => selectNamespace(next)) : null);
  }

  function repositoryCrumbs(entry, linked = false) {
    const all = { label: "All repos", onSelect: clearRepositoryScope, href: hrefWithNamespace(hrefWithRepositoryScope(location.href, null), null) };
    if (linked) return [all, { label: entry.name, onSelect: () => confirmLeave(() => selectNamespace(null)), href: hrefWithNamespace(location.href, null) }];
    const options = repositoryOptions(deps.getSnapshot().backlogRepositories);
    if (options.length < 2) return [all, { label: entry.name }];
    return [all, { options, value: entry.urlKey, name: "Repo", onChoose: (next) => { if (next !== entry.urlKey) setRepositoryScope(next); } }];
  }

  function namespaceCrumb(entry, namespace) {
    return {
      name: "Namespace",
      options: namespaceOptions(entry),
      value: namespace,
      onChoose: (next) => {
        if (next !== namespace) confirmLeave(() => selectNamespace(next));
      },
    };
  }

  function actionBar() {
    const node = tpl("tpl-backlog-action-bar");
    const status = node.querySelector("[data-slot=status]");
    status.textContent = draft.stale
      ? "This namespace changed elsewhere. Cancel to load the current order, then make your changes again."
      : saveError || "Unsaved changes";
    status.classList.toggle("is-error", Boolean(draft.stale || saveError));
    const save = node.querySelector("[data-slot=save]");
    // A Save already sent cannot be taken back, so Cancel waits for its outcome too, through any
    // re-render that happens meanwhile.
    save.disabled = draft.stale || Boolean(saving);
    const cancel = node.querySelector("[data-slot=cancel]");
    cancel.disabled = Boolean(saving);
    save.addEventListener("click", () => {
      save.disabled = true;
      cancel.disabled = true;
      void saveDraft();
    });
    cancel.addEventListener("click", () => {
      draft = null;
      saveError = null;
      // Show the committed order now rather than leaving the discarded rows live until the refresh.
      deps.onRender();
      void deps.onSaved();
    });
    return node;
  }

  // Resolves true once the order is saved. A failed Save keeps the draft, says why, and resolves false,
  // so a navigation waiting on it never goes ahead.
  function saveDraft() {
    saving ??= submitDraft(selectedEntry());
    return saving;
  }

  async function submitDraft(entry) {
    const order = orderedIds(draft);
    try {
      await api.saveBacklogOrder({
        repositoryId: entry.repositoryId,
        namespace: draft.namespace,
        order,
        unprioritized: unprioritizedIds(draft),
        revision: draft.revision,
      });
    } catch (err) {
      if (err.code === "STALE_ORDER") draft = { ...draft, stale: true };
      saveError = [err.message, err.resolution].filter(Boolean).join(" ");
      saving = null;
      deps.onRender();
      return false;
    }
    // Saved, so nothing is unsaved any more, but the snapshot still holds the old order. The saved
    // order stays on screen with its controls held until the new snapshot arrives; a draft opened from
    // the old one could only fail its own Save.
    draft = { ...draft, committedIds: order };
    saveError = null;
    deps.onRender();
    const reloaded = await deps.onSaved();
    saving = null;
    if (!reloaded) {
      // Details would show the old order as if it were current, so the saved one stays on screen, held.
      draft = { ...draft, heldFor: deps.getSnapshot() };
      deps.onRender();
      return true;
    }
    // Prioritizing is finished, so the page returns to reading the list.
    mode = "details";
    draft = null;
    deps.onRender();
    return true;
  }

  // Runs `proceed` now when there is nothing to lose; otherwise asks first. Save and Continue only
  // proceeds after a successful Save, Discard Changes proceeds without one, and Keep Editing leaves the draft
  // and the page as they are.
  function confirmLeave(proceed) {
    if (saving) {
      void saving.then(() => confirmLeave(proceed));
      return;
    }
    if (!isDirty()) {
      proceed();
      return;
    }
    guardDialog.querySelector("[data-slot=message]").textContent = GUARD_MESSAGE;
    guardDialog.querySelector("[data-slot=error]").textContent = draft.stale ? "This namespace changed elsewhere, so this order can't be saved." : "";
    const save = guardDialog.querySelector("[data-slot=save]");
    save.disabled = draft.stale;
    const stayOrDiscard = [guardDialog.querySelector("[data-slot=keep]"), guardDialog.querySelector("[data-slot=discard]")];
    guardDialog.querySelector("[data-slot=discard]").onclick = () => {
      guardDialog.close();
      mode = "details";
      draft = null;
      saveError = null;
      proceed();
      deps.onRender();
    };
    save.onclick = async () => {
      // A Save already sent is going to land, so the dialog stays until its outcome decides the move.
      save.disabled = true;
      for (const button of stayOrDiscard) button.disabled = true;
      const saved = await saveDraft();
      save.disabled = Boolean(draft?.stale);
      for (const button of stayOrDiscard) button.disabled = false;
      if (saved) {
        guardDialog.close();
        proceed();
      } else {
        guardDialog.querySelector("[data-slot=error]").textContent = saveError;
      }
    };
    guardDialog.showModal();
    // A stale draft disables Save, and the dialog must not then open with its focus on Discard Changes.
    if (draft.stale) stayOrDiscard[0].focus();
  }

  function bindDialogs() {
    guardDialog.querySelector("[data-slot=keep]").addEventListener("click", () => guardDialog.close());
    // Esc is the same as Keep Editing, so it waits for a Save in flight too.
    guardDialog.addEventListener("cancel", (event) => {
      if (saving) event.preventDefault();
    });
  }

  function plansByKey() {
    return new Map(deps.getSnapshot().plans.map((record) => [record.key, record]));
  }

  return {
    reconcile,
    render,
    isDirty,
    isOrdering,
    confirmLeave,
    draftUrl: () => draftUrl,
  };
}

// Why a namespace's dependency graph needs repair, shown in both modes.
function graphNotices(view) {
  return view.reasons.map((reason) => fill(tpl("tpl-backlog-finding"), {
    message: reason,
    resolution: "Repair the dependency graph; prioritizing stays locked until then.",
  }));
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

function directoryCounts(status, readyCount, unprioritizedCount, planCount) {
  const count = (number, label) => number && fill(tpl("tpl-backlog-count"), { number: String(number), label });
  const parts = [status, count(readyCount, "ready"), count(unprioritizedCount, "unprioritized"), count(planCount, "total")].filter(Boolean);
  return parts.flatMap((part, index) => (index ? [" · ", part] : [part]));
}

function directoryRow({ icon, label, chevron = true, readyCount = 0, unprioritizedCount = 0, planCount = 0, status = "", href, onSelect, pin = null }) {
  const node = fill(tpl("tpl-backlog-directory-row"), { label });
  if (!chevron) {
    node.querySelector(".backlog-directory-chevron").remove();
    node.classList.add("has-no-chevron");
  }
  node.querySelector("[data-slot=counts]").append(...directoryCounts(status, readyCount, unprioritizedCount, planCount));
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
  return pin ? pinnableRow(node, label, pin) : node;
}

// The pin sits beside the row's link rather than inside it, since a link cannot hold a button.
function pinnableRow(row, label, { pinned, onToggle }) {
  const item = tpl("tpl-backlog-directory-item");
  const button = item.querySelector("[data-slot=pin]");
  const action = `${pinned ? "Unpin" : "Pin"} ${label}`;
  button.setAttribute("aria-label", action);
  button.setAttribute("aria-pressed", String(pinned));
  button.title = action;
  button.addEventListener("click", async () => {
    button.disabled = true;
    await onToggle();
    // A success has already replaced this row; after a failure this button is the way to retry.
    button.disabled = false;
  });
  item.prepend(row);
  return item;
}

function breadcrumb(crumbs) {
  const nav = tpl("tpl-backlog-breadcrumb");
  crumbs.forEach((crumb, index) => {
    if (index) nav.append(fill(tpl("tpl-backlog-breadcrumb-separator"), {}));
    if (crumb.options) {
      const dropdown = document.createElement("option-dropdown");
      Object.assign(dropdown, { options: crumb.options, value: crumb.value, onSelect: crumb.onChoose, name: crumb.name });
      nav.append(dropdown);
    } else if (crumb.onSelect) {
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
