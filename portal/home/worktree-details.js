import { portalFillSlots as fill, portalMiddleEllipsis, portalTpl as tpl } from "/portal/shared/api.js";
import { checkoutStateText } from "/portal/developer-runtime/repository-root-row.js";
import { baseName } from "/portal/developer-runtime/templates.js";

// Worktree paths are long; the dropdown middle-truncates them like the checkout rows do, and copies
// (and titles) the full path.
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
  button.panelContent = worktreeDetailsPanel(checkout, { onStopServers: closing(onStopServers), onDelete: closing(onDelete) });
  return button;
}

function worktreeDetailsPanel(checkout, actions) {
  const panel = tpl("tpl-worktree-details");
  // The shared menu button closes on any document click; copying a value must leave it open so the
  // in-place Copied confirmation is visible.
  panel.addEventListener("click", (event) => event.stopPropagation());
  panel.querySelector("[data-slot=identity]").append(...identityRows(checkout).map(detailRow));
  const facts = panel.querySelector("[data-slot=facts]");
  facts.append(...summaryFacts(checkout).map((text) => fill(tpl("tpl-worktree-detail-fact"), { text })));
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

function identityRows(checkout) {
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
  return rows;
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

// Only facts that differ from the quiet default: a present, clean checkout level with its upstream
// and base shows none.
function summaryFacts(checkout) {
  const git = checkout.git || {};
  const facts = [];
  const state = checkoutStateText(checkout);
  if (state) facts.push(state);
  if (git.dirty) facts.push("dirty");
  if (git.ahead || git.behind) facts.push(`${git.ahead || 0} ahead, ${git.behind || 0} behind ${git.upstream || "upstream"}`);
  if (git.baseBehind) facts.push(`${git.baseBehind} ${git.baseBehind === 1 ? "commit" : "commits"} behind ${baseName(git) || "base"}`);
  return facts;
}
