// <backlog-block> — one movable unit in Backlog's Prioritize mode: a single plan row, or a container of
// linked plans, drawn as a dependency tree, that moves as one. Set .block ({ ids, keys }), .section
// ("ordered" | "needs"), .index, .count, .plans (key -> record), .locked, .held, .dirty, .onOpen, and
// .namespaceAction (see dependencyList) right after creation, then append to the DOM. A locked block shows a badge in place of its controls; a held one keeps them, disabled, while a
// Save settles.
//
// It owns its controls and dispatches a bubbling `block-move` event with { section, index, action };
// the page applies the move to its draft. Each plan in an unprioritized block also offers its own
// `block-archive` with { key }, which commits at once, so it waits until the draft has nothing unsaved
// that the change would make stale. Dragging starts here from the handle and is finished by the
// list the block sits in, which knows where the other blocks are.
import { portalTpl as tpl, portalFillSlots as fill } from "/portal/shared/api.js";
import { ORDERED_ACTIONS, NEEDS_ACTIONS, dependencyTree, isActionEnabled } from "/portal/plans/backlog-model.js";
import { dependencyList, planDependencies } from "/portal/plans/templates.js";
import { renderPlanExcerpt } from "/portal/plans/elements/plan-excerpt.js";
import { renderModifiedTime } from "/portal/plans/elements/plan-status.js";

const CONTROLS = {
  top: { label: "Move to top", icon: "arrow-to-top" },
  up: { label: "Move up", icon: "arrow-up" },
  down: { label: "Move down", icon: "arrow-down" },
  bottom: { label: "Move to bottom", icon: "arrow-to-bottom" },
  return: { label: "Return to unprioritized", icon: "return" },
  // Named for its motion: the block moves down from this section into Prioritized, at its top.
  "place-top": { label: "Move down", icon: "arrow-down" },
};

class BacklogBlockElement extends HTMLElement {
  connectedCallback() {
    this.dataset.blockId = this.block.ids[0];
    const node = tpl("tpl-backlog-row");
    // A position in the list as drawn; the order is the arrangement itself, never an editable number.
    if (this.section === "ordered") fill(node, { position: String(this.index + 1) });
    const rows = dependencyTree(this.block.keys, this.plans).map((row) => this.renderTreeRow(row));
    node.querySelector("[data-slot=plans]").replaceWith(...rows);
    node.querySelector("[data-slot=controls]").replaceWith(this.renderControls());
    this.replaceChildren(node);
  }

  renderTreeRow({ key, parentKey, alsoNeeds, lines }) {
    const row = tpl("tpl-backlog-tree-row");
    const guides = lines.map((line) => {
      const guide = tpl("tpl-backlog-tree-guide");
      guide.dataset.line = line;
      return guide;
    });
    const plan = this.renderPlan(this.plans.get(key), alsoNeeds);
    // The guides are drawn lines, so the relationship is also stated for assistive tech.
    if (parentKey) plan.querySelector("[data-slot=title]").setAttribute("aria-description", `Depends on ${this.plans.get(parentKey).plan.title}`);
    row.append(...guides, plan);
    return row;
  }

  renderPlan(record, alsoNeeds) {
    const { plan } = record;
    const node = fill(tpl("tpl-backlog-plan"), {
      clue: plan.blockers.length ? `blocked by ${plan.blockers.length}` : "",
    });
    node.querySelector("[data-slot=title]").textContent = plan.title;
    // The title stays the keyboard path; a click on the description opens the plan too.
    const doc = node.querySelector(".backlog-plan-doc");
    renderPlanExcerpt(node.querySelector("[data-slot=purpose]"), doc, plan.excerpt || "");
    const modified = node.querySelector("[data-slot=modified]");
    renderModifiedTime(modified, plan.modifiedAt);
    if (this.section === "needs" && !this.locked) modified.after(this.renderArchive(record));
    doc.addEventListener("click", (event) => {
      // Checked here instead of stopped at the button, so a click on it while disabled is covered too.
      if (!event.target.closest(".backlog-archive")) this.onOpen(record.key);
    });
    if (alsoNeeds.length) {
      const items = alsoNeeds.map((key) => ({ key, label: this.plans.get(key).plan.title }));
      node.append(dependencyList("Also needs", items, this.onOpen));
    }
    // Anything else in this block is already drawn by the tree.
    const drawnIds = new Set(this.block.ids);
    const waiting = planDependencies(record, [...this.plans.values()], this.onOpen, { drawnIds, namespaceAction: this.namespaceAction });
    if (waiting) node.append(waiting);
    return node;
  }

  renderControls() {
    const controls = tpl("tpl-backlog-controls");
    if (this.locked) {
      controls.replaceChildren(fill(tpl("tpl-backlog-blocked"), {}));
      return controls;
    }
    const actions = this.section === "needs" ? NEEDS_ACTIONS : ORDERED_ACTIONS;
    controls.append(...actions.map((action) => this.renderControl(action)));
    controls.append(this.renderHandle());
    return controls;
  }

  renderControl(action) {
    const { label, icon } = CONTROLS[action];
    const button = tpl("tpl-backlog-control");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.dataset.action = action;
    button.querySelector("portal-icon").setAttribute("name", icon);
    button.disabled = this.held || !isActionEnabled(this.section, action, this.index, this.count);
    button.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("block-move", {
        bubbles: true,
        detail: { section: this.section, index: this.index, action },
      }));
    });
    return button;
  }

  renderArchive(record) {
    const button = tpl("tpl-backlog-control");
    const disabled = this.held || this.dirty;
    button.classList.add("backlog-archive");
    button.dataset.noExcerpt = "";
    button.setAttribute("aria-label", `Archive ${record.plan.title}`);
    button.title = disabled ? "Save or cancel your order first" : "Archive plan";
    button.querySelector("portal-icon").setAttribute("name", "trash");
    button.disabled = disabled;
    button.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("block-archive", { bubbles: true, detail: { key: record.key } }));
    });
    return button;
  }

  // The move buttons are the keyboard path; dragging is a pointer-only shortcut to the same moves.
  renderHandle() {
    const handle = tpl("tpl-backlog-handle");
    handle.draggable = !this.held;
    handle.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", this.block.ids[0]);
      event.dataTransfer.setDragImage(this, 12, 12);
      this.dispatchEvent(new CustomEvent("block-drag", { bubbles: true, detail: { section: this.section, index: this.index } }));
    });
    handle.addEventListener("dragend", () => {
      this.dispatchEvent(new CustomEvent("block-drag-end", { bubbles: true }));
    });
    return handle;
  }
}

customElements.define("backlog-block", BacklogBlockElement);
