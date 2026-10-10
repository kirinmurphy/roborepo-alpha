// All markup construction for the Plans page. Every export takes plain data (plus callbacks for
// the handful of elements that need a listener) and returns a DOM node or a set of nodes to
// insert. Nothing here reads or writes app state directly — app.js wires results into the page
// and back into state.

import {
  portalTpl as tpl,
  portalFillSlots as fill,
} from "/portal/shared/api.js";
import { FILTER_LABELS, LIFECYCLE_LABELS, formatDate, completionBadgeColor } from "./state.js";

export function rootChip(root, onRemove) {
  const node = fill(tpl("tpl-root-chip"), { path: root });
  node
    .querySelector("[data-slot=remove]")
    .addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove(root);
    });
  return node;
}

export function filterChip({ id, label, chipValue }) {
  const chip = document.createElement("filter-chip");
  chip.setAttribute("filter-id", id);
  chip.setAttribute("label", label);
  chip.setAttribute("value", chipValue);
  return chip;
}

export function filterChipDescriptors(filters, defaults, optionLabelFor) {
  const chips = [];
  for (const id of Object.keys(defaults)) {
    const value = filters[id];
    if (value === defaults[id]) continue;
    const label = id === "search" ? "search" : FILTER_LABELS[id];
    const chipValue =
      id === "search" ? `"${value}"` : optionLabelFor(id, value);
    chips.push({ id, label, chipValue });
  }
  return chips;
}

// <select> children are trivial and a <template> adds no value here, so this builds the native
// element directly rather than through tpl()/fill() — mirrors telemetry/templates.js's selectOption.
export function selectOption([value, label]) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  return opt;
}

// Which §7 onboarding step the page is on once plan-write is enabled. "plans" means there is a plan
// board to render; the other steps each show a single call to action instead.
export function plansOnboardingStep(snapshot) {
  const scans = snapshot.repositoryScans || [];
  if (scans.length === 0) return "no-repositories";
  if (!scans.some((scan) => scan.state === "scanned")) return "not-scanned";
  return snapshot.plans.length === 0 ? "no-plans" : "plans";
}

// Never "0 plans" for a repository Plans has not read: a known repository with no readable
// checkout is reported as not scanned.
export function plansNoRepositories(onManage) {
  const node = tpl("tpl-plans-no-repositories");
  node.querySelector("[data-slot=manage]").addEventListener("click", onManage);
  return node;
}

export function plansOnboardingState(snapshot, step, onManage) {
  const scans = snapshot.repositoryScans || [];
  const scanned = scans.filter((scan) => scan.state === "scanned").length;
  const fills = step === "not-scanned"
    ? {
      title: `Not scanned yet: ${repositoryCount(scans.length)}`,
      body: "Plans reads each known repository's checkouts. None of them has a checkout Plans can read right now.",
    }
    : {
      title: `No plans found in ${repositoryCount(scanned)}`,
      body: "Plans looks for Markdown files under docs/plans in every checkout of each known repository.",
    };
  const node = fill(tpl("tpl-empty-state"), { ...fills, action: "Manage Repos" });
  node.classList.add("empty-state--with-action");
  const action = node.querySelector("[data-slot=action]");
  action.hidden = false;
  action.addEventListener("click", (event) => {
    event.preventDefault();
    onManage();
  });
  return node;
}

export function emptyState() {
  return fill(tpl("tpl-empty-state"), {
    title: "No matching plans",
    body: "Adjust search or filters to show more results.",
  });
}

function repositoryCount(count) {
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

export function warningLine(text) {
  return fill(tpl("tpl-warning-line"), { text });
}

export function listItem(text) {
  return fill(tpl("tpl-list-item"), { text });
}

export function spinner() {
  return tpl("tpl-spinner");
}

export function packageBanner(pkg, onEnable, skillModal) {
  // The explanatory copy and the command list live statically in the tpl-package-banner template;
  // each command's details button carries its skill id, so only the wiring happens here.
  const node = tpl("tpl-package-banner");
  for (const details of node.querySelectorAll("[data-slot=details]")) {
    const skill = details.dataset.skill;
    details.setAttribute("aria-label", `View /${skill} details`);
    details.addEventListener("click", () => skillModal.open(skill, skill));
  }
  const action = node.querySelector("[data-slot=action]");
  action.disabled = !pkg.available;
  action.addEventListener("click", onEnable);
  return node;
}

export function lifecycleTab(lifecycle, count, isSelected, onSelect) {
  const btn = fill(tpl("tpl-lifecycle-tab"), {
    label: `${LIFECYCLE_LABELS[lifecycle] || lifecycle} (${count})`,
  });
  btn.classList.toggle("selected", isSelected);
  btn.setAttribute("aria-selected", String(isSelected));
  btn.addEventListener("click", () => onSelect(lifecycle));
  return btn;
}

// cardActions: { onOpen, onCopyPath, onCopyContext, onCopyPortableContext, onPlanAction,
//                 planWriteEnabled, planWritePackage, skillModal,
//                 onEnablePackage, onError }
export function cardGrid(plans, cardActions) {
  const grid = document.createElement("div");
  grid.className = "card-grid";
  grid.append(...plans.map((record) => planCardElement(record, cardActions)));
  return grid;
}

function planCardElement(record, cardActions) {
  const node = document.createElement("plan-card");
  node.record = record;
  node.actions = cardActions;
  return node;
}

// The plan-suite actions offered for each lifecycle. Each is one atomic command and produces a
// clipboard prompt — the portal never runs a command or moves a file for it; the agent does both
// after you paste. Label is the plain, in-context verb; description is the one-line effect.
// `/plan-start` appears twice because it both begins a backlog plan and resumes an active one.
const PLAN_ACTIONS = [
  ["plan-promote", "Promote", "Review and prepare this plan for development.", "backlog"],
  ["plan-start", "Start", "Implement this plan in an isolated worktree.", "backlog"],
  ["plan-start", "Continue", "Resume implementation in this plan's worktree.", "active"],
  ["plan-write", "Update", "Revise this plan or sync it with the repository.", "active"],
  ["plan-close", "Close", "Verify the work and move the plan to completed or archived.", "active"],
];

function actionsForLifecycle(lifecycle) {
  return PLAN_ACTIONS.filter(([, , , actionLifecycle]) => actionLifecycle === lifecycle);
}

// Best-effort single recommended next command, derived from plan state. Returns null when no rule
// clearly applies (e.g. blocked, or mid-progress with no strong signal) rather than guessing.
export function recommendedPlanCommand(plan) {
  if (plan.blockers.length > 0) return null;
  if (plan.lifecycle === "backlog") return "plan-start";
  if (plan.lifecycle !== "active") return null;
  const { complete, total } = plan.taskCounts;
  if (total > 0 && complete === total) return "plan-close";
  if (plan.reviewState === "possibly-stale" || plan.reviewState === "never-reviewed") return "plan-write";
  return null;
}

// The one command a card or drawer leads with: the recommendation when there is one, otherwise the
// lifecycle's default way forward (Start a backlog plan, Continue an active one). Completed and
// archived plans have none. Returns { command, label } or null.
export function primaryPlanAction(plan) {
  const actions = actionsForLifecycle(plan.lifecycle);
  const command = recommendedPlanCommand(plan) || (actions.some(([item]) => item === "plan-start") ? "plan-start" : null);
  const action = actions.find(([item]) => item === command);
  return action ? { command, label: action[1] } : null;
}

// One clickable menu item (icon + label + optional description) that runs copyFn on click. `run`
// wraps copyFn so a copy failure surfaces via onError instead of an unhandled rejection.
function menuItem({ icon = "copy", label, description, run }) {
  const item = fill(tpl("tpl-menu-item"), { label });
  item.querySelector("[data-slot=icon]").setAttribute("name", icon);
  const descSlot = item.querySelector("[data-slot=description]");
  if (description) {
    descSlot.textContent = description;
    descSlot.hidden = false;
  }
  item.addEventListener("click", async (event) => {
    event.stopPropagation();
    await run();
  });
  return item;
}

// The unified ⋯ menu body, shared by the drawer and the card. When plan-write is installed it shows
// the lifecycle's suite commands (each copies its prompt), then a portable prompt — a
// self-contained summary for a chat without repo access. Copy path is always last. The recommended action gets
// its own dedicated CTA button outside this menu (see primaryPlanAction/cardPrimaryAction) — it is
// deliberately not called out again inside the menu, to avoid a second, redundant highlight.
// When plan-write is NOT installed there are no lifecycle actions, so it falls back to the generic
// repo-aware / portable prompts plus the enable-skill banner.
//
// api: { installed, lifecycle, planWritePackage, skillModal, onError,
//        copyPath, copyPrompt(command), copyRepoPrompt, copyPortablePrompt, onEnablePackage }
function planMenuBody(api) {
  const wrap = tpl("tpl-plan-menu");
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (err) {
      api.onError?.(err);
    }
  };

  const note = wrap.querySelector("[data-slot=note]");
  const group = wrap.querySelector("[data-slot=group]");
  const fallbackActions = wrap.querySelector("[data-slot=fallback-actions]");

  if (api.installed) {
    note.textContent = "Copies a prompt to run in an agent chat.";
    group.hidden = false;
    for (const [command, label, description] of actionsForLifecycle(api.lifecycle)) {
      group.append(
        menuItem({ icon: "agent-prompt", label, description, run: run(() => api.copyPrompt(command)) }),
      );
    }
    group.append(
      menuItem({ icon: "agent-prompt", label: "Portable prompt", description: "Self-contained — works without repo access", run: run(() => api.copyPortablePrompt()) }),
    );
  } else {
    // No lifecycle actions available — offer the generic prompts the actions would otherwise cover.
    note.textContent = "Enable the plan suite for lifecycle actions. For now:";
    fallbackActions.hidden = false;
    fallbackActions.append(
      menuItem({ icon: "agent-prompt", label: "Repo-aware prompt", description: "For an agent that already has this repo open", run: run(() => api.copyRepoPrompt()) }),
      menuItem({ icon: "agent-prompt", label: "Portable prompt", description: "Self-contained — works without repo access", run: run(() => api.copyPortablePrompt()) }),
    );
  }

  wrap.querySelector("[data-slot=copy-path]").append(
    menuItem({ icon: "copy", label: "Copy path", run: run(() => api.copyPath()) }),
  );

  if (api.installed === false && api.planWritePackage) {
    const banner = wrap.querySelector("[data-slot=package-banner]");
    banner.hidden = false;
    banner.append(packageBanner(api.planWritePackage, api.onEnablePackage, api.skillModal));
  }
  return wrap;
}

// drawerActions: { onCopyPath, onCopyRepoContext, onCopyPortableContext, onPlanAction,
//                   onEnablePackage, planWritePackage, skillModal, onError }
export function drawerContent(doc, drawerActions) {
  const plan = doc.plan.plan;
  const pkg = drawerActions.planWritePackage || {};
  const key = doc.plan.key;
  const menu = planMenuBody({
    installed: Boolean(pkg.enabled),
    lifecycle: plan.lifecycle,
    planWritePackage: pkg,
    skillModal: drawerActions.skillModal,
    onError: drawerActions.onError,
    onEnablePackage: drawerActions.onEnablePackage,
    copyPath: () => drawerActions.onCopyPath(plan.relativePath),
    copyPrompt: (command) => drawerActions.onPlanAction(key, command),
    copyRepoPrompt: () => drawerActions.onCopyRepoContext(doc.plan),
    copyPortablePrompt: () => drawerActions.onCopyPortableContext(key),
  });
  return {
    title: plan.title,
    path: `${doc.plan.repository.name} / ${plan.relativePath}`,
    html: doc.html,
    // Lifecycle, priority, next action, review, and task progress now render in the shared
    // <plan-status> section mounted alongside this metadata list, not as static rows here.
    meta: [
      dtdd("id", plan.id || "(missing)"),
      dtdd("repository", doc.plan.repository.name),
    ],
    warnings: plan.validation.warnings,
    tasks: doc.parsed?.tasks || [],
    cta: primaryPlanAction(plan),
    menu,
  };
}

// The plan card's ⋯ menu — the same unified body as the drawer, wired to the card's cardActions.
// record is a plan record (record.plan is the plan). Returns a configured <portal-menu-button>.
export function cardActionMenu(record, cardActions) {
  const plan = record.plan;
  const menu = document.createElement("portal-menu-button");
  menu.setAttribute("icon", "copy");
  menu.setAttribute("aria-label", "Plan actions");
  menu.panelContent = planMenuBody({
    installed: Boolean(cardActions.planWriteEnabled),
    lifecycle: plan.lifecycle,
    planWritePackage: cardActions.planWritePackage,
    skillModal: cardActions.skillModal,
    onError: cardActions.onError,
    onEnablePackage: cardActions.onEnablePackage,
    copyPath: () => cardActions.onCopyPath(plan.relativePath),
    copyPrompt: (command) => cardActions.onPlanAction(record.key, command),
    copyRepoPrompt: () => cardActions.onCopyContext(record),
    copyPortablePrompt: () => cardActions.onCopyPortableContext(record.key),
  });
  return menu;
}

// The card's primary command button (see primaryPlanAction), or null. It copies that command's
// prompt; nothing on the card moves a plan between lifecycle folders, since `/plan-start` and
// `/plan-close` own those moves and commit them.
export function cardPrimaryAction(record, cardActions) {
  const action = primaryPlanAction(record.plan);
  if (!action) return null;
  const btn = fill(tpl("tpl-recommended-cta"), { label: action.label });
  btn.title = `Copy the /${action.command} prompt`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await cardActions.onPlanAction(record.key, action.command);
    } catch (err) {
      cardActions.onError?.(err);
    }
  });
  return btn;
}

export function drawerTaskItems(tasks) {
  if (!tasks.length) return [fill(tpl("tpl-task-item"), { text: "none" })];
  return tasks.map((task) => {
    const node = fill(tpl("tpl-task-item"), { text: `${task.done ? "[x]" : "[ ]"} ${task.text}` });
    node.classList.add(task.done ? "task-done" : "task-open");
    return node;
  });
}

export function dtdd(term, value) {
  return fill(tpl("tpl-dtdd-row"), { term, value });
}

// One entry in the drawer's Blocked by / Blocking sections (see state.js's resolveBlockers /
// resolveBlocking) — a link for a resolved blocker, plain unclickable text otherwise. Shares the
// same tpl-blocker-link/tpl-blocker-unresolved templates as blockers-popover.js's card popup.
export function blockerLink(blocker, onOpenPlan) {
  if (!blocker.resolved) return fill(tpl("tpl-blocker-unresolved"), { title: blocker.title });
  const link = fill(tpl("tpl-blocker-link"), { title: blocker.title });
  link.addEventListener("click", () => onOpenPlan(blocker.key));
  return link;
}

// One project block in the All Open Tasks dialog: a completion header, then either the plan's open
// tasks or the not-started line with its View Story escape hatch.
//
// A not-started plan still lists its open tasks when it has any. "Project Not Started" answers
// "has anything happened here", which a 0/10 plan and a 0/0 plan answer identically; the task list
// answers "what is left", which only the first can. Suppressing the list for 0/10 would hide ten
// real items behind a label. View Story is the only route to detail for the 0/0 case, where there
// is no checklist to show.
export function allTasksProject(record, { notStarted, percent, onViewStory }) {
  const plan = record.plan;
  const { complete, total } = plan.taskCounts;
  const node = fill(tpl("tpl-all-tasks-project"), {
    title: plan.title,
    repo: record.repository.name,
    percent: percent === null ? "—" : `${Math.round(percent * 100)}%`,
    count: total === 0 ? "no checklist" : `${complete}/${total}`,
  });
  const percentEl = node.querySelector("[data-slot=percent]");
  percentEl.style.background = completionBadgeColor(percent);

  const notStartedEl = node.querySelector("[data-slot=notstarted]");
  notStartedEl.hidden = !notStarted;
  const viewStoryEl = node.querySelector("[data-slot=view-story]");
  if (notStarted) viewStoryEl.addEventListener("click", () => onViewStory(record.key));
  else viewStoryEl.remove();

  const tasks = plan.openTasks || [];
  node
    .querySelector("[data-slot=tasks]")
    .replaceChildren(...tasks.map((task) => fill(tpl("tpl-all-tasks-item"), { text: task.text })));
  return node;
}

// One problem in the blocked-move dialog: what is wrong, and how to fix it. Findings that predate
// the structured shape carry only a message, so the resolution line is dropped rather than
// rendered empty.
export function lifecycleFinding(item) {
  const node = fill(tpl("tpl-lifecycle-finding"), { message: item.message });
  const resolution = node.querySelector("[data-slot=resolution]");
  if (item.resolution) resolution.textContent = item.resolution;
  else resolution.remove();
  return node;
}
