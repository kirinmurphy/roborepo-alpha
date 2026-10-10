// <plan-status> — set .record (plan record) right after creation, then append to the DOM. Shared
// by <plan-card> and the detail drawer so both surfaces show identical lifecycle/priority
// controls, readiness/blocked/review chips, progress, and next-action.
//
// Progress display is driven by taskProgressDisplay() rather than by lifecycle alone — see that
// function in state.js for why started work is worth showing in backlog and completed too.
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
import { LIFECYCLE_LABELS, taskProgressDisplay } from "/portal/plans/state.js";

const PRIORITY_OPTIONS = [
  ["high", "high"],
  ["medium", "medium"],
  ["low", "low"],
  ["none", "none"],
];

const LIFECYCLES = ["backlog", "active", "completed", "archived"];
const LIFECYCLE_OPTIONS = LIFECYCLES.map((value) => [value, LIFECYCLE_LABELS[value]]);

// Priority no longer applies once a plan is done — completed/archived plans keep the field on
// the record for history, but the control shouldn't offer to edit it.
const LIFECYCLES_WITHOUT_PRIORITY = new Set(["completed", "archived"]);

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

function chip(text, cls = "") {
  const node = tpl("tpl-chip");
  node.textContent = text;
  if (cls) node.classList.add(cls);
  return node;
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

  renderLifecycleDropdown(record) {
    const dropdown = document.createElement("option-dropdown");
    dropdown.options = LIFECYCLE_OPTIONS;
    dropdown.value = record.plan.lifecycle;
    dropdown.onSelect = (value) => {
      dropdown.loading = true;
      dropdown.title = "";
      dropdown.classList.remove("dropdown-error");
      this.emitChange("lifecycle", value);
    };
    return dropdown;
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
    const { total, remaining } = plan.taskCounts;
    const complete = total - remaining;
    const percentComplete = total > 0 ? Math.round((complete / total) * 100) : 0;
    const isBlocked = plan.blockers.length > 0;
    const progress = taskProgressDisplay(plan);

    const node = fill(tpl("tpl-plan-status"), {
      meta: `modified ${formatRelativeTime(plan.modifiedAt)}`,
      "progress-label": total > 0 ? `${percentComplete}%` : "no tasks",
      next: plan.nextAction || "none set",
    });
    node.querySelector("[data-slot=meta]").title = new Date(plan.modifiedAt).toLocaleString();
    const stateBadgeSlot = node.querySelector("[data-slot=state-badge]");
    // Read-only (a page without the Plans mutation orchestrator, e.g. Home): lifecycle and
    // priority render as plain chips and the blocked badge is static, since nothing would handle
    // the plan-change / blocked-click events they dispatch.
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
    node.querySelector("[data-slot=implementation]").hidden = progress === "none" && !plan.nextAction;
    node.querySelector("[data-slot=progress-row]").hidden = progress !== "bar";
    node.querySelector("[data-slot=complete-row]").hidden = progress !== "complete";
    // A next action alongside an "all tasks complete" badge reads as a contradiction, so the badge
    // state suppresses it.
    node.querySelector("[data-slot=next-row]").hidden = progress !== "bar";
    node.querySelector("[data-slot=progress-fill]").style.width = `${percentComplete}%`;
    node.querySelector("[data-slot=status-chips]").append(
      // readiness (draft/ready) only distinguishes actionable-vs-not within backlog; once a plan
      // is active it necessarily already cleared that bar, so the chip is redundant past backlog.
      ...(plan.lifecycle === "backlog"
        ? [chip(plan.readiness, plan.readiness === "ready" ? "ok" : "")]
        : []),
      chip(plan.reviewState, plan.reviewState === "possibly-stale" ? "warn" : ""),
    );
    const showPriority = !LIFECYCLES_WITHOUT_PRIORITY.has(plan.lifecycle);
    if (readonly) {
      node.querySelector("[data-slot=lifecycle]").append(chip(LIFECYCLE_LABELS[plan.lifecycle] || plan.lifecycle));
      if (showPriority) node.querySelector("[data-slot=priority]").append(chip(`${plan.priority} priority`));
    } else {
      node.querySelector("[data-slot=lifecycle]").append(this.renderLifecycleDropdown(record));
      if (showPriority) node.querySelector("[data-slot=priority]").append(this.renderPriorityDropdown(record));
    }
    this.replaceChildren(node);
  }
}

customElements.define("plan-status", PlanStatusElement);
