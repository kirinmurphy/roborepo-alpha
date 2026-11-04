// <backlog-block> — one movable unit in Backlog's Ordering mode: a single plan row, or a container of
// linked plans that moves as one. Set .block ({ ids, keys }), .section ("ordered" | "needs"), .index,
// .count, .plans (key -> record), .locked, .held, and .onOpen right after creation, then append to the
// DOM. Locked blocks show why they cannot move; held ones keep their controls, disabled, while a Save settles.
//
// It owns its controls and dispatches a bubbling `block-move` event with { section, index, action };
// the page applies the move to its draft. Dragging starts here from the handle and is finished by the
// list the block sits in, which knows where the other blocks are.
import { portalTpl as tpl, portalFillSlots as fill } from "/portal/shared/api.js";
import { ORDERED_ACTIONS, NEEDS_ACTIONS, displayTitle, isActionEnabled } from "/portal/plans/backlog-model.js";

const CONTROLS = {
  top: { label: "Move to top", icon: "arrow-to-top" },
  up: { label: "Move up", icon: "arrow-up" },
  down: { label: "Move down", icon: "arrow-down" },
  bottom: { label: "Move to bottom", icon: "arrow-to-bottom" },
  // Named for its motion: the block moves down from this section into Ordered, at its top.
  "place-top": { label: "Move down", icon: "arrow-down" },
};
const PURPOSE_LENGTH = 110;

class BacklogBlockElement extends HTMLElement {
  connectedCallback() {
    this.dataset.blockId = this.block.ids[0];
    const linked = this.block.keys.length > 1;
    const node = tpl(linked ? "tpl-backlog-group" : "tpl-backlog-row");
    if (linked) fill(node, { count: `${this.block.keys.length} linked plans` });
    // A position in the list as drawn; the order is the arrangement itself, never an editable number.
    if (this.section === "ordered") fill(node, { position: String(this.index + 1) });
    const rows = this.block.keys.map((key) => this.renderPlan(this.plans.get(key)));
    node.querySelector("[data-slot=plans]").replaceWith(...rows);
    node.querySelector("[data-slot=controls]").replaceWith(this.renderControls());
    this.replaceChildren(node);
  }

  renderPlan(record) {
    const { plan } = record;
    const node = fill(tpl("tpl-backlog-plan"), {
      purpose: truncate(plan.excerpt || "", PURPOSE_LENGTH),
      clue: planClue(record, this.plans),
    });
    const title = node.querySelector("[data-slot=title]");
    title.textContent = displayTitle(plan);
    title.addEventListener("click", () => this.onOpen(record.key));
    return node;
  }

  renderControls() {
    const controls = tpl("tpl-backlog-controls");
    if (this.locked) {
      controls.replaceChildren(fill(tpl("tpl-backlog-blocked"), {}));
      return controls;
    }
    const actions = this.section === "needs" ? NEEDS_ACTIONS : ORDERED_ACTIONS;
    controls.append(...actions.map((action) => this.renderControl(action)), this.renderHandle());
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

// Real prerequisites only: adjacency in a block never implies one. A prerequisite outside Backlog
// names its lifecycle, since it may still be blocking this plan.
function planClue(record, plans) {
  const clues = [];
  const requires = (record.plan.dependencies || []).map((id) => {
    const target = [...plans.values()].find((item) => item.plan.id === id);
    if (!target) return id;
    return target.plan.lifecycle === "backlog" ? target.plan.title : `${target.plan.title} (${target.plan.lifecycle})`;
  });
  if (requires.length) clues.push(`Requires: ${requires.join(", ")}`);
  if (record.plan.blockers.length) clues.push(`blocked by ${record.plan.blockers.length}`);
  return clues.join(" · ");
}

function truncate(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength).trimEnd()}…`;
}
