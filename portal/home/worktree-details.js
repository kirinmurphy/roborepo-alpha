import { portalFillSlots as fill, portalMiddleEllipsis, portalTpl as tpl } from "/portal/shared/api.js";
import { checkoutStateText } from "/portal/developer-runtime/repository-root-row.js";
import { gitDriftWarnings } from "/portal/developer-runtime/templates.js";

// Worktree and plan paths are long; the dropdown middle-truncates them like the checkout rows do,
// and copies (and titles) the full path.
const WORKTREE_PATH_MAX_LENGTH = 50;

// The worktree behind a matched plan row: the identity its branch label and copy control used to
// show, each value with its own copy action, plus the Git facts worth a glance. The full checkout
// tooltip stays on Runtime and on unmatched worktree rows. Stop Server and Delete Worktree sit at the
// foot of the panel, so neither is ever the row's most prominent action.
export function worktreeDetailsButton(plan, checkout, { onStopServers = null, onDelete = null } = {}) {
  const button = document.createElement("portal-menu-button");
  button.setAttribute("icon", "tree");
  button.setAttribute("aria-label", `Worktree details for ${plan.title}`);
  button.title = "Worktree details";
  const closing = (action) => action && (() => {
    button.close();
    action();
  });
  button.panelContent = worktreeDetailsPanel(plan, checkout, { onStopServers: closing(onStopServers), onDelete: closing(onDelete) });
  return button;
}

function worktreeDetailsPanel(plan, checkout, actions) {
  const panel = tpl("tpl-worktree-details");
  // The shared menu button closes on any document click; copying a value must leave it open so the
  // in-place Copied confirmation is visible.
  panel.addEventListener("click", (event) => event.stopPropagation());
  panel.querySelector("[data-slot=identity]").append(...identityRows(plan, checkout).map(detailRow));
  const facts = panel.querySelector("[data-slot=facts]");
  facts.append(...summaryFacts(checkout).map(factItem));
  facts.hidden = !facts.childElementCount;
  if (actions.onDelete) mountActions(panel.querySelector("[data-slot=actions]"), checkout, actions);
  return panel;
}

// Stop Server appears only while something runs in the worktree; Delete Worktree stops it as well.
function mountActions(slot, checkout, { onStopServers, onDelete }) {
  slot.hidden = false;
  const stop = slot.querySelector("[data-action=stop-servers]");
  stop.hidden = !(isRunning(checkout) && onStopServers);
  if (!stop.hidden) stop.addEventListener("click", onStopServers);
  slot.querySelector("[data-action=delete-worktree]").addEventListener("click", onDelete);
}

export function isRunning(checkout) {
  return checkout.worktreeRunning ?? checkout.worktreeState === "running";
}

function identityRows(plan, checkout) {
  const git = checkout.git;
  const rows = [];
  if (git?.detached) {
    rows.push({ icon: "git-branch", value: git.shortHead ? `detached at ${git.shortHead}` : "detached", copy: git.shortHead, label: "Copy commit SHA" });
  } else if (git?.branch) {
    rows.push({ icon: "git-branch", value: git.branch, copy: git.branch, label: "Copy branch name" });
  }
  // Git's worktree name is almost always the path's last segment, so the path alone identifies it;
  // the name stands in only when the path did not resolve. Copy only when
  // the path resolved: a copy that writes nothing would still report success.
  const path = checkout.projectRoot;
  rows.push(path
    ? { icon: "tree", value: portalMiddleEllipsis(path, WORKTREE_PATH_MAX_LENGTH), title: path, copy: path, label: "Copy worktree path" }
    : { icon: "tree", value: checkout.worktreeName });
  // The plan file inside this worktree, not the main checkout's copy: the worktree is where the plan
  // is being worked on and its tasks ticked off.
  const planPath = path && plan.relativePath ? joinPath(path, plan.relativePath) : null;
  if (planPath) rows.push({ icon: "plans", value: portalMiddleEllipsis(planPath, WORKTREE_PATH_MAX_LENGTH), title: planPath, copy: planPath, label: "Copy plan path" });
  return rows;
}

// Joins with the separator the checkout path already uses, so a Windows path stays backslashed.
function joinPath(root, relativePath) {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/[\\/]/g, separator)}`;
}

function detailRow({ icon, value, title, copy, label }) {
  const row = fill(tpl("tpl-worktree-detail-row"), { icon: { name: icon }, value });
  if (title && title !== value) row.querySelector("[data-slot=value]").title = title;
  const button = row.querySelector("portal-copy-button");
  if (!copy) {
    button.remove();
    return row;
  }
  button.setAttribute("aria-label", label);
  button.copySource = copy;
  return row;
}

// One status line — checkout state, dirty, ahead and behind the remote — then every drift warning
// the row's own Git warning is chosen from, so the dropdown and the row never disagree. Being behind
// the remote is itself a warning, so when it applies the warning says it and the status line does
// not repeat it. A present, clean checkout level with its upstream and base shows none. The status
// line carries the GitHub glyph and each warning the warning glyph, in the same gutter as the identity
// rows' icons.
function summaryFacts(checkout) {
  const git = checkout.git || {};
  const drift = gitDriftWarnings(git);
  const behindWarned = drift.some((warning) => warning.kind === "remote");
  const tracking = git.ahead || git.behind ? [`${git.ahead || 0} ahead`, ...(behindWarned ? [] : [`${git.behind || 0} behind remote`])] : [];
  const status = [checkoutStateText(checkout), git.dirty ? "dirty" : null, ...tracking].filter(Boolean);
  const warnings = drift.map((warning) => ({ icon: "warning", text: warning.text, title: warning.title, level: warning.level }));
  return [...(status.length ? [{ icon: "github", text: status.join(" · ") }] : []), ...warnings];
}

function factItem({ icon, text, title = null, level = null }) {
  const item = fill(tpl("tpl-worktree-detail-fact"), { icon: { name: icon }, text });
  if (title) item.title = title;
  if (level) {
    item.classList.add("git-drift");
    item.dataset.level = level;
  }
  return item;
}
