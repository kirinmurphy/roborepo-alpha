// <plan-status> — set .merge (optional, see below) and .record (plan record) right after creation,
// then append to the DOM. Shared by <plan-card> and the detail drawer so both surfaces show the same
// priority control, structure/QA/blocked chips, modified time, and completion.
//
// Completion is the shared planCompletion() ring/badge, at the far right. `.merge` is the plan's
// `{ into }` when its worktree has merged (state.js's mergedPlanBranches), which turns it into the
// `merged` badge; leave it null otherwise.
//
// Lifecycle is not a control here: the plan suite's commands move plans between lifecycle folders
// and commit those moves, and the page's tabs already say which lifecycle a card is in.
//
// It does not call APIs, inspect filters, render global toasts, or decide whether it remains
// visible — those are page (app.js) responsibilities. On a dropdown select it dispatches a
// bubbling `plan-change` event with the mutation intent; it never awaits the mutation itself.
// Because there's no imperative ack channel, loading/error state is a pure function of the last
// `record` this element received: `onSelect` sets `loading = true` and repaints immediately, and
// the *next* `record` property set (same record on failure, new record on success — the
// orchestrator re-sets it either way once the mutation settles) clears it. This keeps the element
// a pure function of its `record` prop rather than needing app.js to call back into it.
import { portalTpl as tpl, portalFillSlots as fill } from "/portal/shared/api.js";
import { planCompletion } from "/portal/plans/plan-completion.js";
import { showsPriority } from "/portal/plans/lifecycle.js";
import { STRUCTURE_LABELS } from "/portal/plans/state.js";
import { chip } from "/portal/plans/templates.js";

const PRIORITY_OPTIONS = [
  ["high", "high"],
  ["medium", "medium"],
  ["low", "low"],
  ["none", "none"],
];

// The QA outcome of a plan under review, kept apart from its task progress (the completion ring):
// finishing the tasks moved it here, and only review findings and a human's approval move it on.
function qaChip(plan) {
  const open = plan.qa?.openFindings || 0;
  if (open > 0) return chip(`${open} open finding${open === 1 ? "" : "s"}`, "warn");
  if (plan.qa?.decision === "approved") return chip("approved", "ok");
  return chip("awaiting review");
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatRelativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "modified: unknown";

  const now = new Date();
  const elapsedMs = now.getTime() - date.getTime();
  const elapsedMinutes = elapsedMs / MINUTE_MS;
  const elapsedHours = elapsedMs / HOUR_MS;
  const elapsedDays = elapsedMs / DAY_MS;

  if (elapsedMinutes < 5) return "just now";
  if (elapsedMinutes < 60) return "a few minutes ago";
  if (elapsedHours < 5) return "a few hours ago";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCalendarDay(date, now)) return "earlier today";
  if (isSameCalendarDay(date, yesterday)) return "yesterday";

  if (elapsedDays < 5) return "a few days ago";
  if (elapsedDays < 11) return "a week ago";
  if (elapsedDays < 28) return "a few weeks ago";
  if (elapsedDays < 45) return "a month ago";
  if (elapsedDays < 330) return "a few months ago";
  if (elapsedDays < 550) return "a year ago";
  return "a few years ago";
}

class PlanStatusElement extends HTMLElement {
  connectedCallback() {
    if (this.record) this.render();
  }

  set record(value) {
    this._record = value;
    if (this.isConnected) this.render();
  }
  get record() {
    return this._record;
  }

  emitChange(property, value) {
    this.dispatchEvent(new CustomEvent("plan-change", {
      bubbles: true,
      composed: true,
      detail: { property, value, record: this._record },
    }));
  }

  renderPriorityDropdown(record) {
    const dropdown = document.createElement("option-dropdown");
    dropdown.options = PRIORITY_OPTIONS;
    dropdown.value = record.plan.priority;
    dropdown.onSelect = (value) => {
      dropdown.loading = true;
      dropdown.title = "";
      dropdown.classList.remove("dropdown-error");
      this.emitChange("priority", value);
    };
    return dropdown;
  }

  render() {
    const record = this._record;
    const plan = record.plan;
    const isBlocked = plan.blockers.length > 0;

    const node = fill(tpl("tpl-plan-status"), {
      meta: `modified ${formatRelativeTime(plan.modifiedAt)}`,
    });
    node.querySelector("[data-slot=meta]").title = new Date(plan.modifiedAt).toLocaleString();
    const stateBadgeSlot = node.querySelector("[data-slot=state-badge]");
    // Read-only (a page without the Plans mutation orchestrator, e.g. Home): priority renders as a
    // plain chip and the blocked badge is static, since nothing would handle the plan-change /
    // blocked-click events they dispatch.
    const readonly = this.hasAttribute("readonly");
    if (isBlocked && readonly) {
      stateBadgeSlot.textContent = `blocked by ${plan.blockers.length}`;
      stateBadgeSlot.classList.add("warn");
      stateBadgeSlot.hidden = false;
    } else if (isBlocked) {
      const badgeBtn = document.createElement("button");
      badgeBtn.type = "button";
      badgeBtn.className = "state-badge warn state-badge-blocked";
      badgeBtn.textContent = `blocked by ${plan.blockers.length}`;
      badgeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent("blocked-click", {
          bubbles: true,
          composed: true,
          detail: { record, anchor: badgeBtn },
        }));
      });
      stateBadgeSlot.replaceWith(badgeBtn);
    }
    const completion = planCompletion(plan, { merge: this.merge || null });
    if (completion) node.querySelector("[data-slot=completion]").replaceWith(completion);
    // Structure (complete/draft) only distinguishes actionable-vs-not within backlog; promotion to
    // Ready requires a complete structure, so the chip is redundant past backlog.
    const chips = node.querySelector("[data-slot=status-chips]");
    if (plan.lifecycle === "backlog") {
      chips.append(chip(STRUCTURE_LABELS[plan.readiness] || plan.readiness, plan.readiness === "ready" ? "ok" : ""));
    }
    if (plan.lifecycle === "review") chips.append(qaChip(plan));
    // Priority no longer applies once a plan is done; those plans keep the field for history, but
    // the control does not offer to edit it.
    if (showsPriority(plan.lifecycle)) {
      node.querySelector("[data-slot=priority]").append(
        readonly ? chip(`${plan.priority} priority`) : this.renderPriorityDropdown(record),
      );
    }
    this.replaceChildren(node);
  }
}

customElements.define("plan-status", PlanStatusElement);
