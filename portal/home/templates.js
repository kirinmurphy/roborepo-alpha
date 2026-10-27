import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";
import { mountActionMenu, mountRepositoryRow, repositoryPageUrl } from "/portal/shared/repository-components.js";
import { hrefWithRepositoryScope } from "/portal/shared/repository-scope.js";
import { appendRepositoryDomains } from "./domains.js";
import { matchedPlanIdentity, unmatchedPlanRow } from "./plan-rows.js";
import { worktreeCleanupNotice } from "./worktree-dialogs.js";
import { isRunning } from "./worktree-details.js";
import { buildRootSection } from "/portal/developer-runtime/repository-root-row.js";

const MOCK_NAMES = {
  "git:github.com/example/shared-stack-fixture": "Mock: Shared Compose stack",
  "git:github.com/example/multi-member-fixture": "Mock: Multi-member app",
  "git:github.com/example/idle-checkout-fixture": "Mock: Idle checkout",
};

export function isHomeMockRepository(repository) {
  return Boolean(repository?.fixture && (MOCK_NAMES[repository.repositoryId] || /-fixture$/i.test(repository.displayName || "")));
}

function homeRepositoryName(repository) {
  if (!isHomeMockRepository(repository)) return repository.displayName;
  return MOCK_NAMES[repository.repositoryId] || `Mock: ${humanizeMockName(repository.displayName)}`;
}

export function repositoryDirectory(repositories, actions) {
  const node = tpl("tpl-repository-directory");
  node.append(...repositories.map((repository) => repositoryCard(repository, actions)));
  return node;
}

export function unresolvedActivity(items) {
  const node = tpl("tpl-unresolved-activity");
  return fill(node, { summary: `${items.length} running ${items.length === 1 ? "workspace needs" : "workspaces need"} a repo association.` });
}

function repositoryCard(repository, actions) {
  const node = fill(tpl("tpl-repository-card"), {
  });
  mountRepositoryRow(node, {
    name: homeRepositoryName(repository),
    href: repositoryPageUrl(repository),
    providerUrl: repository.providerUrl,
    menuItems: homeMenuItems(repository),
    onToggleMenu: actions.onToggleMenu,
    onSelectMenu: (key, item, event) => actions.onSelectMenu(key, repository, item, event),
  });
  if (isHomeMockRepository(repository)) {
    const badge = node.querySelector("[data-slot=mock-badge]");
    badge.hidden = false;
    badge.classList.add("repository-state-badge", "is-mock");
    badge.title = "Mock repo used to demonstrate the Home view";
  }
  const lifecycleState = repository.lifecycle?.state || "active";
  if (lifecycleState !== "active") {
    node.classList.add("is-not-running");
    const badge = node.querySelector("[data-slot=lifecycle-state]");
    badge.hidden = false;
    badge.textContent = lifecycleState;
    badge.classList.add(`is-${lifecycleState}`);
    if (repository.lifecycle?.reason) badge.title = repository.lifecycle.reason;
  }
  node.querySelector("[data-slot=checkouts]").append(...cardRows(repository.domains, { ...actions, repositoryId: repository.repositoryId }));
  appendRepositoryDomains(node.querySelector("[data-slot=domains]"), repository);
  const notice = worktreeCleanupNotice(repository, { onEnable: actions.onEnableCleanup, onDismiss: actions.onDismissCleanup });
  if (notice) node.querySelector("[data-slot=cleanup-notice]").append(notice);
  return node;
}

function humanizeMockName(name) {
  return String(name || "repository")
    .replace(/-fixture$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// Below the repository row: the main checkout(s), then every active plan — a matched plan AS its
// worktree's checkout row — then every worktree no plan claimed, then the plan summary. Matching is
// the server's (`checkoutRootId`); Home only consumes each referenced checkout so none renders twice.
// With no active plans this is exactly the checkout list, in Runtime order.
function cardRows(domains, actions) {
  const checkouts = domains.runtime.data?.checkouts || [];
  const hookInstalled = domains.runtime.data?.worktreeCleanup?.hook === "installed";
  const byRootId = new Map(checkouts.filter((checkout) => checkout.isWorktree && checkout.rootId).map((checkout) => [checkout.rootId, checkout]));
  const mainCheckouts = checkouts.filter((checkout) => !checkout.isWorktree);
  const consumed = new Set();
  const rows = checkouts.length
    ? mainCheckouts.map((checkout) => checkoutRow(checkout, actions, { hookInstalled }))
    : [noCheckoutRow()];
  for (const plan of domains.plans.data?.active || []) {
    const checkout = byRootId.get(plan.checkoutRootId);
    if (!checkout) {
      rows.push(unmatchedPlanRow(plan, actions.onOpenPlan));
      continue;
    }
    consumed.add(checkout);
    const target = { repositoryId: actions.repositoryId, checkout, plan };
    const identity = matchedPlanIdentity(plan, checkout, {
      mainCheckouts,
      nextAction: actions.nextPlanAction(plan),
      onOpenPlan: actions.onOpenPlan,
      onCopyPrompt: actions.onCopyPlanPrompt,
      onStopServers: () => actions.onStopServers(target),
      onDelete: () => actions.onRemoveWorktree(target),
    });
    rows.push(checkoutRow(checkout, actions, { hookInstalled, identity }));
  }
  rows.push(...checkouts.filter((checkout) => checkout.isWorktree && !consumed.has(checkout)).map((checkout) => checkoutRow(checkout, actions, { hookInstalled })));
  return rows;
}

function checkoutRow(checkout, actions, { identity = null, hookInstalled = false } = {}) {
  return buildRootSection({
    root: {
      rootId: checkout.rootId,
      isWorktree: checkout.isWorktree,
      projectRoot: checkout.projectRoot,
      checkoutState: checkout.checkoutState,
      checkoutReason: checkout.checkoutReason,
      worktreeState: checkout.worktreeState,
      worktreeReason: checkout.worktreeReason,
      mergedInto: checkout.mergedInto,
      cleanupHookInstalled: hookInstalled,
      repositoryId: actions.repositoryId,
      git: checkout.git,
      primaryEntrypoint: checkout.primaryEntrypoint,
      members: [],
      composeGroups: [],
    },
    repository: { name: "Repo" },
    mode: "home",
    onMountLinks: actions.onMountLinks,
    onMountWorktreeMenu: (slot) => mountWorktreeMenu(slot, checkout, actions),
    identity,
  });
}

// A worktree no plan claims keeps its actions in a ⋮ menu at the end of its row: Stop Server while
// something runs in it, and Delete Worktree, which stops it as well.
function mountWorktreeMenu(slot, checkout, actions) {
  const name = checkout.git?.branch || checkout.worktreeName || "worktree";
  const target = { repositoryId: actions.repositoryId, checkout };
  const menu = mountActionMenu(slot, [
    { key: "stop-servers", label: "Stop Server", icon: "stop", hidden: !isRunning(checkout) },
    { key: "delete", label: "Delete Worktree", icon: "trash", danger: true },
  ], {
    ariaLabel: `Actions for ${name}`,
    onToggle: () => actions.onToggleMenu(menu),
    onSelect: (key) => (key === "delete" ? actions.onRemoveWorktree(target) : actions.onStopServers(target)),
  });
}

function noCheckoutRow() {
  const row = document.createElement("div");
  row.className = "repository-root repository-root-empty";
  row.textContent = "No known checkout";
  return row;
}

function homeMenuItems(repository) {
  const checkouts = repository.domains.runtime.data?.checkouts || [];
  const knownCheckout = checkouts.length > 0;
  // The page links open each page already filtered to this repo. A repo with no urlKey (a demo
  // card) has nothing to filter by, so they are left out rather than opening an unfiltered page.
  const filtered = (path) => hrefWithRepositoryScope(path, repository.urlKey);
  return [
    { key: "plans", label: "All Plans", icon: "plans", href: filtered("/plans"), hidden: !repository.urlKey },
    { key: "agents", label: "Agent Config", icon: "agents", href: filtered("/agents"), hidden: !repository.urlKey },
    { key: "tokens", label: "Token Activity", icon: "tokens", href: filtered("/tokens"), hidden: !repository.urlKey },
    { key: "pin", label: repository.pinned ? "Unpin" : "Pin", icon: "pin" },
    knownCheckout
      ? { key: "hide", label: "Ignore Repo", icon: "eye-off" }
      : { key: "forget", label: "Forget This Repo", icon: "trash" },
  ];
}
