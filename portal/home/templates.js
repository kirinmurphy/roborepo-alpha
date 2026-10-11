import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";
import { mountActionMenu, mountRepositoryRow, repositoryPageUrl } from "/portal/shared/repository-components.js";
import { appendRepositoryDomains } from "./domains.js";
import { matchedPlanIdentity, unmatchedPlanRow } from "./plan-rows.js";
import { worktreeCleanupNotice } from "./worktree-dialogs.js";
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
  return fill(node, { summary: `${items.length} running ${items.length === 1 ? "workspace needs" : "workspaces need"} a repository association.` });
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
    badge.title = "Mock repository used to demonstrate the Home view";
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
  appendRepositoryDomains(node.querySelector("[data-slot=domains]"), repository.domains);
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
  const consumed = new Set();
  const rows = checkouts.length
    ? checkouts.filter((checkout) => !checkout.isWorktree).map((checkout) => checkoutRow(checkout, actions, { hookInstalled }))
    : [noCheckoutRow()];
  for (const plan of domains.plans.data?.active || []) {
    const checkout = byRootId.get(plan.checkoutRootId);
    if (!checkout) {
      rows.push(unmatchedPlanRow(plan, actions.onOpenPlan));
      continue;
    }
    consumed.add(checkout);
    const onRemove = () => actions.onRemoveWorktree({ repositoryId: actions.repositoryId, checkout, plan });
    rows.push(checkoutRow(checkout, actions, { hookInstalled, identity: matchedPlanIdentity(plan, checkout, { onOpenPlan: actions.onOpenPlan, onRemove }) }));
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
      cleanupHookInstalled: hookInstalled,
      repositoryId: actions.repositoryId,
      git: checkout.git,
      primaryEntrypoint: checkout.primaryEntrypoint,
      members: [],
      composeGroups: [],
    },
    repository: { name: "Repository" },
    mode: "home",
    onMountLinks: actions.onMountLinks,
    onMountWorktreeMenu: (slot) => mountWorktreeMenu(slot, checkout, actions),
    identity,
  });
}

// A worktree no plan claims keeps Remove in a ⋮ menu at the end of its row. A running worktree
// cannot pass the removal guards, so the item says why instead of offering a refusal.
function mountWorktreeMenu(slot, checkout, actions) {
  const running = checkout.worktreeState === "running";
  const name = checkout.git?.branch || checkout.worktreeName || "worktree";
  const menu = mountActionMenu(slot, [
    { key: "remove", label: "Remove worktree…", disabled: running, hint: running ? "stop its servers first" : null },
  ], {
    ariaLabel: `Actions for ${name}`,
    onToggle: () => actions.onToggleMenu(menu),
    onSelect: () => actions.onRemoveWorktree({ repositoryId: actions.repositoryId, checkout }),
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
  return [
    { key: knownCheckout ? "hide" : "forget", label: knownCheckout ? "Ignore repository" : "Forget This Repo" },
    { key: "pin", label: repository.pinned ? "Unpin" : "Pin" },
    // Placeholder until repository-scoped agent config exists: shown, but not navigable.
    { key: "agents", label: "Repo Agent Config", hint: "coming soon", disabled: true },
  ];
}
