// <plan-status> — set .merge (optional, see below) and .record (plan record) right after creation,
// then append to the DOM. Shared by <plan-card> and the detail drawer so both surfaces show the same
// document metadata above an actions/work row. Set .actionContent to the page's action nodes before
// mounting; record updates move those same nodes into the fresh row to preserve their handlers.
//
// Completion is the shared planCompletion() ring/badge, at the far right. `.merge` is the plan's
// `{ into }` when its worktree has merged (state.js's mergedPlanBranches), which adds the
// `merged` badge alongside task progress; leave it null otherwise.
//
// Lifecycle is not a control here: the plan suite's commands move plans between lifecycle folders
// and commit those moves, and the page's tabs already say which lifecycle a card is in.
//
// It does not call APIs, inspect filters, render global toasts, or decide whether it remains
// visible — those are page (app.js) responsibilities.
import { portalTpl as tpl, portalFillSlots as fill } from "/portal/shared/api.js";
import { planCompletion } from "/portal/plans/plan-completion.js";
import { chip } from "/portal/plans/templates.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

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

  render() {
    const record = this._record;
    const plan = record.plan;
    const isBlocked = plan.blockers.length > 0;

    const node = tpl("tpl-plan-status");
    renderModifiedTime(node.querySelector("[data-slot=modified]"), plan.modifiedAt);
    node.querySelector("[data-slot=actions]").append(...(this.actionContent || []));
    const warnings = plan.validation.warnings.length;
    if (warnings) node.querySelector("[data-slot=warnings]").replaceWith(chip(`${warnings} warning${warnings === 1 ? "" : "s"}`, "warn"));
    const stateBadgeSlot = node.querySelector("[data-slot=state-badge]");
    // Read-only (a page that opens no blockers popover, e.g. Home): the blocked badge is static,
    // since nothing would handle the blocked-click event it dispatches.
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
    const openFindings = plan.qa?.openFindings || 0;
    if (plan.lifecycle === "review" && openFindings > 0) {
      node.querySelector("[data-slot=findings]").replaceWith(chip(`${openFindings} open finding${openFindings === 1 ? "" : "s"}`, "warn"));
    }
    this.replaceChildren(node);
  }
}

customElements.define("plan-status", PlanStatusElement);

// Fills a <time> holding a [data-slot=meta] span, the clock-and-age label a card and a Prioritize row share.
export function renderModifiedTime(time, value) {
  const age = formatModifiedAge(value);
  time.querySelector("[data-slot=meta]").textContent = age;
  const date = new Date(value);
  const known = !Number.isNaN(date.getTime());
  time.title = known ? `Modified ${date.toLocaleString()}` : "Modified time unknown";
  time.setAttribute("aria-label", known ? `Modified ${age}${age === "now" ? "" : " ago"}` : "Modified time unknown");
  if (known) time.dateTime = date.toISOString();
}

function formatModifiedAge(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";

  const elapsed = Math.max(0, Date.now() - date.getTime());
  if (elapsed < MINUTE_MS) return "now";
  const units = [[MINUTE_MS, "min"], [HOUR_MS, "hr"], [DAY_MS, "day"], [7 * DAY_MS, "week"], [30 * DAY_MS, "month"]];
  const [duration, unit] = units.find((_, index) => index === units.length - 1 || elapsed < units[index + 1][0]);
  const count = Math.floor(elapsed / duration);
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
