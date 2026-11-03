import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";
import { mountRepositoryRow, repositoryPageUrl } from "/portal/shared/repository-components.js";
import { matchedPlanIdentity, unmatchedPlanRow } from "./plan-rows.js";
import { mountRepositoryShortcuts } from "./repository-shortcuts.js";
import { worktreeCleanupNotice } from "./worktree-dialogs.js";
import { worktreeDetailsButton } from "./worktree-details.js";
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
  const node = tpl("tpl-repository-card");
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
  // A repo with open work (a live worktree or a recently touched Active/Review plan) is not idle just
  // because nothing is running in it, so it keeps the running look and carries no badge.
  const lifecycleState = repository.lifecycle?.state || "active";
  if (lifecycleState !== "active" && !(lifecycleState === "idle" && repository.inProgress)) {
    node.classList.add("is-not-running");
    const badge = node.querySelector("[data-slot=lifecycle-state]");
    badge.hidden = false;
    badge.textContent = lifecycleState;
    badge.classList.add(`is-${lifecycleState}`);
    if (repository.lifecycle?.reason) badge.title = repository.lifecycle.reason;
  }
  node.querySelector("[data-slot=checkouts]").append(...cardRows(repository.domains, { ...actions, repositoryId: repository.repositoryId }));
  mountRepositoryShortcuts(node.querySelector("[data-slot=repository-shortcuts]"), repository);
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
  const row = buildRootSection({
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
    onMountWorktreeDetails: (slot) => slot.append(unclaimedWorktreeDetails(checkout, actions)),
    identity,
  });
  // Home's row glyphs match the repo header's shortcut icons; Runtime keeps the shared default.
  row.querySelector(".repository-root-glyph")?.setAttribute("size", "lg");
  return row;
}

// A worktree no plan claims gets the same dropdown as a plan's worktree, minus the plan file.
function unclaimedWorktreeDetails(checkout, actions) {
  const target = { repositoryId: actions.repositoryId, checkout };
  return worktreeDetailsButton(null, checkout, {
    mainCheckouts: [],
    onStopServers: () => actions.onStopServers(target),
    onDelete: () => actions.onRemoveWorktree(target),
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
  // The page links (Plans, Agents, Tokens) sit beside this menu as icons; see repository-shortcuts.js.
  return [
    { key: "pin", label: repository.pinned ? "Unpin" : "Pin", icon: "pin" },
    knownCheckout
      ? { key: "hide", label: "Ignore Repo", icon: "eye-off" }
      : { key: "forget", label: "Forget This Repo", icon: "trash" },
  ];
}
