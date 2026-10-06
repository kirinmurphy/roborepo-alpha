import { portalCopyText, portalFillSlots as fill, portalMiddleEllipsis, portalTpl as tpl } from "/portal/shared/api.js";
import { configureLinksTrigger, mountRepositoryRow, repositoryPageUrl } from "/portal/shared/repository-components.js";
import { healthState, provenanceLabel, statusDetail, statusText, UNMATCHED_PROJECT_NAME } from "./state.js";
import { buildRootSection } from "./repository-root-row.js";

export function emptyState(title, body) {
  return fill(tpl("tpl-empty"), { title, body });
}

export function notice(text) {
  return fill(tpl("tpl-notice"), { text });
}

export function noticeWithDoc(text) {
  return fill(tpl("tpl-notice-with-doc"), { text });
}

export function group(title, headerEnd, nodes) {
  const node = fill(tpl("tpl-group"), { title });
  const headerEndSlot = node.querySelector("[data-slot=meta]");
  if (headerEnd instanceof Node) headerEndSlot.append(headerEnd);
  else if (headerEnd != null) headerEndSlot.textContent = headerEnd;
  node.querySelector("[data-slot=items]").append(...nodes);
  return node;
}

export function toolbarActions() {
  return tpl("tpl-toolbar-actions");
}

export function collapsibleGroup(title, meta, nodes) {
  const node = fill(tpl("tpl-collapsible-group"), { meta, "expanded-title": title });
  node.querySelector("[data-slot=items]").append(...nodes);
  node.querySelector("[data-action=collapse]").addEventListener("click", (event) => {
    event.preventDefault();
    node.open = false;
  });
  return node;
}

// Well under the shared default (28). The git row's other content — the remote link and, past
// threshold, a drift phrase — is either fixed-width or the thing actually worth reading, so the
// branch name is what yields space when the row gets crowded.
const BRANCH_NAME_MAX_LENGTH = 20;

// The default branches. Two uses: they are not worth a copy button (nobody pastes "main" into a
// checkout), and they are named by role — "main branch" rather than a bare "main", which would
// read as just another branch name.
export const DEFAULT_BRANCHES = new Set(["main", "master"]);

// How a compose project's repository was established, weakest last. "auto-bind" is called out as
// inferred because, unlike a compose working_dir (which Compose guarantees is the project
// directory), it is derived from a container's bind-mount path — see collectGitForComposeProjects.
const REPO_PROVENANCE = {
  manual: "repo set manually",
  auto: "repo from compose working dir",
  "auto-bind": "repo inferred from mount path",
};

// How the stack's PLACEMENT was decided — which checkout it belongs to, a separate question from
// REPO_PROVENANCE's "which repository". Keyed by ownershipEvidence.kind (classifyComposeOwnership).
//
// `shared` and `unverified` render in the same region but make different claims, and the wording
// keeps them apart: "conflict"/"repo-root" are positive findings that the stack is not checkout-
// specific, while "none" is an absence of evidence. Saying "shared" for a named-volumes-only stack
// would assert something never observed.
const OWNERSHIP_EVIDENCE = {
  "bind-mount": "placed by bind mount into this checkout",
  conflict: "mounts span several checkouts",
  "repo-root": "mounts resolve to no checkout",
  none: "no bind mounts to judge by",
  manual: "placement set manually",
};

// One card per Docker Compose project, its containers listed as compact rows rather than each
// getting its own top-level card — a Compose stack (app, db, proxy, mailhog...) is one logical
// operation, not N unrelated ones. Each container is its own row (not each published port) since a
// single container publishing several host ports (e.g. one Traefik proxy on 80/443/8080) is one
// operational unit, not three. See docs/plans/active/developer-runtime-compose-project-grouping.md.
// `hideProviderLink` covers the shared-services case, which is neither of the two the isMember flag
// distinguishes: the card is standalone (no owning checkout to inherit git context from, so it keeps
// its own badge) but it is NOT top-level, so the repository header above it already carries the one
// provider link this repository gets. Without this it rendered a second, identical GitHub link a few
// rows under the first.
export function composeProjectCard(composeProject, actions, { isMember = false, repositoryName = null, hideProviderLink = false } = {}) {
  const allInstances = composeProject.containers.flatMap((c) => c.instances);
  const portCount = allInstances.length;
  // One CPU reading per container (not per port — a container's ports would otherwise multiply
  // its own CPU into the sum), same de-dup as composeContainerRow's own metrics line.
  //
  // Sums cpuPercentOfHost, never cpuPercent: docker stats reports percent of ONE core, so adding
  // those across an 11-container project produced numbers like 161% that meant nothing (neither a
  // share of the machine nor of a core). Percent-of-machine is the only figure that survives a sum.
  const aggregateCpu = composeProject.containers.reduce((sum, c) => {
    const cpu = c.instances.find((i) => i.processMetrics)?.processMetrics?.cpuPercentOfHost;
    return cpu != null ? sum + cpu : sum;
  }, 0);
  // CPU is deliberately absent from the persistent meta line: in practice these sit well under 1%,
  // so printing the number every time spends permanent space on a fact that almost never warrants
  // action. It moves to the tooltip, and only re-earns a persistent slot as a badge once it crosses
  // the concern threshold (see applyResourceConcernBadge).
  const metaParts = [`${composeProject.containers.length} container${composeProject.containers.length === 1 ? "" : "s"}`, `${portCount} port${portCount === 1 ? "" : "s"}`];
  // Compose names its project after the directory, so the stack name almost always repeats the
  // repository heading it sits under ("menugoats" inside menugoats). Nothing guarantees that —
  // COMPOSE_PROJECT_NAME can be anything — so the real name shows when it differs, and a generic
  // label stands in when it would just be an echo. Members name what they do, not where they live.
  const echoesRepository = repositoryName && composeProject.name === repositoryName;
  const node = fill(tpl("tpl-compose-project-card"), {
    title: isMember && echoesRepository ? "Docker" : composeProject.name,
    meta: metaParts.join(" · "),
  });
  if (isMember) {
    node.classList.add("is-member");
    // Containers are already visible on open — a second collapse toggle inside an expanded
    // repository card is a drill-in with nothing behind it.
    node.querySelector(".compose-project-chevron")?.remove();
    node.open = true;
    // Hide describes the whole repository and now lives on its menu; leaving a copy here would
    // offer two controls for one setting. Repo association stays: it is specific to this stack, not
    // to the repository it resolved into. (Favorite is gone entirely — pinning is repository-level.)
    node.querySelector("[data-action=hide]")?.remove();
  }
  const tooltip = node.querySelector(".info-wrap > template").content;
  const aggregateMemoryKb = composeProject.containers.reduce((sum, c) => {
    const kb = c.instances.find((i) => i.processMetrics)?.processMetrics?.residentMemoryKb;
    return kb != null ? sum + kb : sum;
  }, 0);
  fill(tooltip, {
    containers: composeProject.containers.map((c) => c.name).join(", ") || "none",
    "ports-detail": String(portCount),
    resources: aggregateCpu > 0 || aggregateMemoryKb > 0
      ? `${aggregateCpu.toFixed(1)}% of machine CPU · ${formatMemory(aggregateMemoryKb)} RSS`
      : "unavailable",
    // Two independent facts: which repository this stack resolved to, and which checkout of it the
    // stack was placed in. The second only shows when the classifier actually ran — an older
    // snapshot, or a stack it never reached, carries no evidence and says nothing rather than
    // implying a verdict.
    identity: [
      "compose",
      REPO_PROVENANCE[composeProject.resolvedFrom] || "repo unresolved",
      OWNERSHIP_EVIDENCE[composeProject.ownershipEvidence?.kind],
    ].filter(Boolean).join(" · "),
  });
  // Git context belongs to the repository, which already shows it once above; a member repeating it
  // is the same branch and dirty state a few lines apart.
  if (!isMember) {
    applyGitBadge(node, tooltip, composeProject.git, hideProviderLink ? null : composeProject.providerUrl, { hideProviderLink });
    wireCopyBranchButton(node, composeProject.git);
  }
  applyResourceConcernBadge(node, aggregateCpu);
  const rows = node.querySelector("[data-slot=rows]");
  for (const container of composeProject.containers) {
    rows.append(composeContainerRow(container, actions));
  }
  wireComposeCardActions(node, composeProject, actions);
  return node;
}

// A trigger with nothing behind it is a control that lies: it looks actionable, and clicking it
// opens an empty panel. Menus are assembled subtractively — items are removed or hidden per card
// kind (favorite/hide move to the repository menu on members, history needs an opaqueKey) — so a
// card kind that loses every item ends up with a live trigger and no actions. That is the state a
// Compose card nested in a repository card is in: favorite and hide are its only two entries and
// both get removed.
//
// The menu ships hidden in the template and is revealed here, rather than shipping visible and
// being retracted: a missed call site then renders no menu instead of an empty one. Same
// correct-or-absent discipline the cards follow elsewhere — a control has to earn its way onto the
// page. (It is not about flashing; cards are built detached and inserted already-resolved.)
//
// Called at the END of each wire function, after every removal and every `.hidden` assignment, so
// it sees the menu's final contents. Counts hidden buttons as absent — items disappear both ways
// here, and a menu holding only hidden items is just as empty to the operator.
function revealActionMenuIfUsable(node) {
  // Scoped to THIS card's own menu. A repository card contains member cards that have menus of
  // their own, and a bare querySelector would find whichever comes first in the subtree. That is
  // currently the card's own — members are appended after wiring — but relying on that ordering
  // would make this quietly reveal a member's menu the day the calls are reordered.
  const menu = ownActionMenu(node);
  if (!menu) return;
  if (!menu.querySelector("button:not([hidden])")) return;
  // Reveals the whole .action-menu, not just the panel: the panel has its own `hidden`, toggled by
  // the open/close handlers, and must stay hidden until the trigger is actually clicked.
  menu.closest(".action-menu")?.removeAttribute("hidden");
}

// The card's own action menu, never a nested card's. All three card kinds place the menu as a
// direct child of a .card-head, at varying depths (a plain card heads itself; a compose card wraps
// it in <summary>; a repository card adds a .repository-disclosure above that). The card's own
// .card-head is always the first in document order, since nested member cards come after it.
function ownActionMenu(node) {
  const header = node.querySelector(".card-head");
  // A member menu mounted straight into a checkout row (mountMemberMenu) has no .card-head: the
  // host element holds the menu directly.
  return header?.querySelector(":scope > .action-menu [data-menu], :scope > .checkout-actions .action-menu [data-menu]")
    || node.querySelector(":scope > .action-menu [data-menu]")
    || null;
}

// A member card's ⋮ menu, without the card. Used when a checkout row folds its only member into
// itself (repository-root-row.js): the row already shows everything else the card would, so the
// menu is the one part that has to come along. Cloned from tpl-card and wired by the same
// wireCardActions, so the row's menu and a card's can never offer different actions.
export function mountMemberMenu(host, project, instance, actions) {
  const menu = tpl("tpl-card").querySelector(".action-menu");
  // Hide is repository-scoped for members — see instanceCard.
  menu.querySelector("[data-action=hide]")?.remove();
  host.append(menu);
  mountInstanceCopyPid(host, instance);
  wireCardActions(host, project, instance, { ...actions, onMountRoutesTrigger: null });
}

// The action-menu trigger lives inside <summary> (the only child a closed <details> keeps
// rendered — everything else gets force-hidden by the UA stylesheet). Without preventDefault +
// stopPropagation, any click on it would also toggle the details open/closed via the native
// summary click behavior.
function wireComposeCardActions(node, composeProject, actions) {
  // The card stays open: its containers are the reason it exists, and collapsing it left a header
  // that said nothing the repository card above it did not already say. Suppressing the summary's
  // native toggle is what makes the missing chevron honest rather than a hidden interaction.
  node.querySelector("summary")?.addEventListener("click", (event) => {
    // Nested controls (menu trigger, copy, links) handle and stop their own clicks before this
    // runs, so only a click on the summary's own surface reaches here.
    event.preventDefault();
  });
  const trigger = node.querySelector("[data-action=menu]");
  const menu = node.querySelector("[data-menu]");
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    actions.onToggleMenu(node);
  });
  // "Associate repo" now lives on the repository card's menu because it
  // binds a path to the whole repository rather than to this one stack. Optional-chained rather
  // than deleted outright so a standalone Compose card — one with no repository card above it —
  // still wires the action if its template ever carries the button again.
  node.querySelector("[data-action=repo]")?.addEventListener("click", (event) => {
    event.preventDefault();
    actions.onCloseMenus();
    actions.onAssociateRepo(composeProject);
  });
  // Optional for the same reason as wireCardActions: hide is removed on a compose card nested
  // inside a repository card, where it belongs to the repository.
  node.querySelector("[data-action=hide]")?.addEventListener("click", (event) => {
    event.preventDefault();
    actions.onCloseMenus();
    actions.onHide(composeProject);
  });
  menu.addEventListener("click", (event) => event.stopPropagation());
  revealActionMenuIfUsable(node);
}

function composeContainerRow(container, actions) {
  const node = fill(tpl("tpl-compose-container-row"), {
    name: container.name,
  });
  // One PID serves every port a container publishes, so metrics are read off the first instance
  // that has them rather than repeated/recomputed per port.
  const metricsSource = container.instances.find((i) => i.processMetrics)?.processMetrics;
  const metricsParts = [];
  // Both figures, because they answer different questions and `docker stats` only ever shows the
  // per-core one — printing only percent-of-machine would not match what the CLI reports.
  if (metricsSource?.cpuPercent != null) {
    metricsParts.push(metricsSource.cpuPercentOfHost != null
      ? `${metricsSource.cpuPercent}% of a core (${metricsSource.cpuPercentOfHost.toFixed(1)}% of machine)`
      : `${metricsSource.cpuPercent}% CPU`);
  }
  if (metricsSource?.residentMemoryKb != null) metricsParts.push(`${formatMemory(metricsSource.residentMemoryKb)} RSS`);
  if (metricsSource?.elapsedSeconds != null) metricsParts.push(`up ${formatElapsed(metricsSource.elapsedSeconds)}`);
  const tooltip = node.querySelector(".info-wrap > template").content;
  fill(tooltip, {
    image: container.image || "unknown",
    state: container.state || "unknown",
    // Raw numbers live here rather than on the row — see composeProjectCard for why a sub-1% CPU
    // reading does not earn permanent space.
    resources: metricsParts.join(" · ") || "unavailable",
  });
  applyResourceConcernBadge(node, metricsSource?.cpuPercentOfHost);
  applyTechGlyph(node, glyphForImage(container.image), container.image);
  const ports = node.querySelector("[data-slot=ports]");
  for (const instance of container.instances) {
    const port = fill(tpl("tpl-compose-container-port"), {
      status: `${statusText(instance)} (${statusDetail(instance)})`,
    });
    const origin = port.querySelector("[data-slot=origin]");
    if (instance.origin) {
      origin.textContent = displayOrigin(instance.origin);
      origin.href = instance.origin;
    } else {
      origin.textContent = `:${instance.bind.port}`;
      origin.removeAttribute("href");
    }
    const state = healthState(instance);
    if (state) port.dataset.health = state;
    applyPortHealthBadge(port, instance, state);
    const tooltip = port.querySelector(".info-wrap > template").content;
    fill(tooltip, {
      latency: instance.latencyMs == null ? "unknown" : `${instance.latencyMs}ms`,
      bind: `${instance.bind.address}:${instance.bind.port}`,
    });
    const warning = tooltip.querySelector("[data-slot=warning]");
    if (instance.bind.warning) {
      warning.hidden = false;
      warning.textContent = instance.bind.warning;
    }
    const history = port.querySelector("[data-action=history]");
    if (!instance.opaqueKey || !actions?.onHistory) history.hidden = true;
    else history.addEventListener("click", () => actions.onHistory(null, instance));
    ports.append(port);
  }
  return node;
}

// One card per repository, holding every instance that resolves to it however discovery found it —
// a Compose stack, a dev server, and a tunnel launched from one repo previously rendered as three
// unrelated cards in three page sections (developer-runtime-repository-card-merge).
//
// Members keep their existing card kinds rather than being flattened into a new compact row: a
// listener stays a full instance card (quick links, association, alias, history all keep working)
// and a Compose stack stays its own sub-card, since `docker compose down` stops those containers as
// one unit. Merging is a grouping change, not a redesign of what a member is.
export function repositoryCard(repository, { instanceActions, composeActions, repositoryActions, departedMembers = [] }) {
  // A Compose stack is ONE member that happens to contain containers, not N members. Counting its
  // containers made menugoats read "4 members" while expanding to a single entry — the count has to
  // match what the expanded card actually lists.
  // Shared stacks count here, at repository level: they are genuinely members of this repository,
  // just not of any one checkout of it. The count still matches what the expanded card lists,
  // because the Shared services region below lists them.
  //
  // repository.composeGroups is the flat cross-root array and ALREADY contains the shared stacks
  // (snapshot.mjs pushes every group into it before routing a null-rootId one to sharedComposeGroups
  // as well), so they must not be added again here.
  const memberCount = repository.members.length + repository.composeGroups.length;
  const lifecycleState = repository.lifecycle?.state || "active";
  const isRunning = lifecycleState === "active";
  // Member count only. The container count was a second number competing with it in the collapsed
  // view, and it answers a question you only have once the card is open — where the containers are
  // listed anyway.
  // "N members" describes a running repository. An idle one has none by definition, so it reports
  // when it was last seen instead — the fact that actually distinguishes two idle repositories, and
  // the one the 30-day ageing rule acts on.
  const node = fill(tpl("tpl-repository-card"), {
    title: repository.name,
    meta: isRunning
      ? `${memberCount} member${memberCount === 1 ? "" : "s"}`
      : lastSeenLabel(repository.lastSeenAt),
  });
  if (!isRunning) {
    node.classList.add("is-not-running");
    const badge = node.querySelector("[data-slot=lifecycle-state]");
    if (badge) {
      badge.hidden = false;
      badge.textContent = lifecycleState;
      badge.classList.add(`is-${lifecycleState}`);
      // The reason is the useful half of `stale` — "checkout missing" vs "drive unreadable" are
      // different problems with different fixes — and it is absent for an ordinary idle repository.
      if (repository.lifecycle?.reason) badge.title = repository.lifecycle.reason;
    }
  }
  // A dev fixture (local/dev-fixtures) looks exactly like a real project otherwise.
  if (repository.fixture) {
    const fixtureBadge = node.querySelector("[data-slot=fixture-badge]");
    fixtureBadge.hidden = false;
    fixtureBadge.title = "Test fixture started by roborepo dev fixture start";
  }
  // No repository-level git badge: git is per-checkout now (see the roots loop below), and the
  // repository header itself — name, provider link — never depends on which root is running.
  applyResourceConcernBadge(node, repository.cpuPercentOfHost);

  // One provider link per repository (not per root): a repository has exactly one canonical
  // remote, however many checkouts run it, so it belongs at the header rather than repeated in
  // every root section's git row.
  mountRepositoryRow(node, {
    name: repository.name,
    href: repositoryPageUrl(repository),
    providerUrl: repository.providerUrl,
    providerLabel: repository.providerUrl ? providerHostLabel(repository.providerUrl) : null,
    menuItems: repositoryMenuItems(repository, repositoryActions),
    onToggleMenu: repositoryActions?.onToggleMenu,
    onSelectMenu: (key) => {
      repositoryActions?.onCloseMenus();
      if (key === "pin") repositoryActions?.onTogglePinned(repository);
      else if (key === "hide") repositoryActions?.onHide(repository);
      else if (key === "ignore") repositoryActions?.onIgnore(repository);
      else if (key === "repo") repositoryActions?.onAssociateRepo(repository.composeGroups?.[0]);
    },
  });
  const providerLinkSlot = node.querySelector("[data-slot=provider-link]");
  if (providerLinkSlot && repository.providerUrl) providerLinkSlot.title = repoNameFromProviderUrl(repository.providerUrl);

  // No URL in the header: each checkout row carries its own promoted app link, main checkout
  // included, so every link sits in the same place (see repository-root-row.js).
  const mainRoot = repository.roots.find((root) => !root.isWorktree);

  // Distinct processes serving the same thing — the real stale-instance case. Same-PID multi-port
  // listeners are folded into one member upstream and deliberately do not warn: one process holding
  // a main port plus an HMR socket is correct, not leftover.
  const duplicateNotice = node.querySelector("[data-slot=duplicate-notice]");
  if (repository.duplicateGroups?.length) {
    duplicateNotice.hidden = false;
    duplicateNotice.textContent = repository.duplicateGroups
      .map((group) => `Duplicate members found: ${group.name} is running on ports ${group.ports.join(", ")}. You may have stale instances running.`)
      .join(" ");
  }

  const rootsSlot = node.querySelector("[data-slot=roots]");
  const worktreeRoots = repository.roots.filter((root) => root.isWorktree);
  // The main section always renders, even with no rootId resolved at all (no member has ever
  // reported one) — canonical repository identity must never appear to depend on which root
  // happens to be running. departedMembers with no matching root fall back here too.
  const departedByRoot = new Map();
  for (const member of departedMembers) {
    const key = member.rootId || null;
    if (!departedByRoot.has(key)) departedByRoot.set(key, []);
    departedByRoot.get(key).push(member);
  }
  const mainDeparted = [
    ...(departedByRoot.get(mainRoot?.rootId ?? null) || []),
    ...(mainRoot ? [] : departedByRoot.get(null) || []),
  ];
  // No heading between the main row and the worktrees: each row's glyph (home or tree) already
  // says which kind of checkout it is.
  rootsSlot.append(buildRootSection({
    root: mainRoot,
    departed: mainDeparted,
    repository,
    composeActions,
    instanceActions,
  }));
  for (const root of worktreeRoots) {
    rootsSlot.append(buildRootSection({
      root,
      departed: departedByRoot.get(root.rootId) || [],
      repository,
      composeActions,
      instanceActions,
    }));
  }

  // Stacks that back the repository as a whole rather than any one checkout of it. Last, below every
  // checkout, because that is the containment they describe: a Postgres shared by three worktrees is
  // not a member of the first one, and putting it there was the bug this region fixes.
  //
  // Rendered as full (non-member) compose cards: without an owning checkout there is no root section
  // to inherit git context from, so each stack keeps its own name, association control, and tooltip.
  const sharedGroups = repository.sharedComposeGroups || [];
  if (sharedGroups.length) {
    const heading = document.createElement("div");
    // The only divider left in the roots list: checkouts are told apart by their row glyphs, but
    // shared stacks are not checkouts at all. The class name predates that — it once also styled a
    // "Worktrees" heading.
    heading.className = "repository-worktrees-heading";
    heading.textContent = "Shared services";
    rootsSlot.append(heading);
    for (const group of sharedGroups) {
      const card = composeProjectCard(group, composeActions, {
        repositoryName: repository.name,
        hideProviderLink: true,
      });
      card.classList.add("repository-shared-service");
      rootsSlot.append(card);
    }
  }
  return node;
}

function repositoryMenuItems(repository, actions) {
  return [
    { key: "repo", label: "Associate repo", hidden: !repository.composeGroups?.[0] || !actions?.onAssociateRepo },
    { key: "pin", label: repository.pinned ? "Unpin" : "Pin" },
    // Ignore is the registry-wide decision Home offers too; Hide from Runtime only tucks this
    // repository's running members away on this page (pljvmyh §8).
    { key: "ignore", label: "Ignore repository", hidden: !repository.repositoryId || !actions?.onIgnore },
    { key: "hide", label: "Hide from Runtime" },
  ];
}

export function instanceCard(project, instance, actions) {
  const node = fill(tpl("tpl-card"), {
    title: instanceTitle(project, instance),
  });
  // Nested inside a repository card: styling hook for the lighter heading treatment, since a member
  // should not compete visually with the repository name above it.
  if (project.isMember) {
    node.classList.add("is-member");
    // Hide is repository-scoped and lives on the repository menu; the actions left here (links,
    // copy, open, history, association, alias) genuinely describe this one listener. (Favorite is
    // gone entirely — pinning is repository-level.)
    node.querySelector("[data-action=hide]")?.remove();
    layOutMemberCard(node);
  }
  // A listener no repository claims keeps only what still works for it: Copy PID, View history,
  // and Hide. Change association no longer reliably moves it into a repository card (the card only
  // forms around it when another process of that repository is scanned first), and an alias never
  // applies to the low-confidence process: identity these listeners carry.
  if (project.unrecognized) {
    node.querySelector("[data-action=associate]")?.remove();
    node.querySelector("[data-action=alias]")?.remove();
  }
  const tooltip = node.querySelector(".info-wrap > template").content;
  fill(tooltip, {
    status: `${statusText(instance)} (${statusDetail(instance)})`,
    latency: instance.latencyMs == null ? "unknown" : `${instance.latencyMs}ms`,
    process: provenanceText(instance),
    identity: `${instance.project?.evidence || project.evidence || "runtime"} · ${instance.project?.confidence || project.confidence || "low"}`,
    bind: `${instance.bind.address}:${instance.bind.port}`,
  });
  // Shown only when it adds something the heading does not already say.
  const pageTitleDetail = tooltip.querySelector("[data-slot=page-title-detail]");
  if (pageTitleDetail && instance.title && instance.title !== instanceTitle(project, instance)) {
    pageTitleDetail.hidden = false;
    tooltip.querySelector("[data-slot=page-title-text]").textContent = instance.title;
  }
  const state = healthState(instance);
  if (state) node.dataset.health = state;
  // `suppressGit` is set when this card is a member of a repository card, which already shows the
  // git row once. Without it every member repeated the same branch/dirty/ahead marks — the git
  // context belongs to the repository, not to each listener inside it. A standalone instance card
  // (unmatched, or a repo-less project) still renders its own.
  const gitInfo = project.suppressGit ? null : instance.project?.git || project.git || null;
  applyGitBadge(node, tooltip, gitInfo, project.providerUrl || instance.project?.providerUrl || null);
  wireCopyBranchButton(node, gitInfo);
  applyDockerBadge(node, tooltip, instance.docker);
  applyProcessMetricsBadge(tooltip, instance.processMetrics);
  applyResourceConcernBadge(node, instance.processMetrics?.cpuPercentOfHost);
  const origin = node.querySelector("[data-slot=origin]");
  if (instance.origin) {
    // Display without the scheme (the href keeps it) — every origin on this page is http(s) by
    // construction, so the prefix is noise. Same treatment the compose port rows already used.
    origin.textContent = displayOrigin(instance.origin);
    origin.href = instance.origin;
    // The display is port-only, so the full origin lives here for identification and copying.
    origin.title = instance.origin;
  } else {
    origin.textContent = "origin unavailable";
    origin.removeAttribute("href");
  }
  mountInstanceCopyPid(node, instance);
  const warning = tooltip.querySelector("[data-slot=warning]");
  if (instance.bind.warning) {
    warning.hidden = false;
    warning.textContent = instance.bind.warning;
  }
  const duplicateNotice = node.querySelector("[data-slot=duplicate-notice]");
  if (instance.duplicatePorts?.length > 1) {
    duplicateNotice.hidden = false;
    duplicateNotice.textContent = `It looks like this project is running on multiple ports: ${instance.duplicatePorts.join(", ")}. You may have a leftover process to stop.`;
  }
  const links = node.querySelector("[data-slot=links]");
  for (const link of instance.app?.links || []) {
    const a = fill(tpl("tpl-quick-link"), { label: link.label });
    a.href = link.url;
    links.append(a);
  }
  if (!links.childElementCount) links.append(fill(tpl("tpl-no-links"), { text: "No saved links" }));
  wireCardActions(node, project, instance, actions);
  return node;
}

// A member card inside a checkout's list takes the checkout row's shape: its name and info icon are
// one tooltip trigger, and its port, Links, and ⋮ move into the same right-hand cells the row uses
// (checkout-actions), so a member's port sits in the same column as the row's promoted port above
// it. Standalone cards keep the "name - :port" title row.
function layOutMemberCard(node) {
  const title = node.querySelector(".card-title");
  const trigger = title.querySelector(":scope > .info-wrap");
  trigger.classList.add("member-trigger");
  trigger.prepend(title.querySelector("h3"));
  title.prepend(trigger);
  title.querySelector(".title-separator")?.remove();

  const origin = node.querySelector("[data-slot=origin]");
  origin.classList.add("repository-entrypoint", "link-cta");
  const linksCell = document.createElement("span");
  linksCell.className = "checkout-links-cell";
  linksCell.append(node.querySelector("[data-slot=routes-trigger]"));
  const controlCell = document.createElement("span");
  controlCell.className = "checkout-control-cell";
  controlCell.append(node.querySelector(".card-head > .action-menu"));
  const actions = document.createElement("div");
  actions.className = "checkout-actions";
  actions.append(origin, linksCell, controlCell);
  node.querySelector(".card-head").append(actions);
}

export function inactiveCard(project, actions) {
  const node = fill(tpl("tpl-card"), {
    title: project.name || project.app.name || "localhost app",
  });
  fill(node.querySelector(".info-wrap > template").content, {
    status: "Inactive",
    latency: "not running",
    process: "not running",
    identity: project.identity,
    bind: "no active listener",
  });
  node.querySelector("[data-slot=origin]").hidden = true;
  node.querySelector("[data-action=associate]").hidden = true;
  wireCardActions(node, { identity: project.identity, name: project.name }, { app: project.app, origin: null }, actions);
  return node;
}

export function linkRow(link = {}) {
  const node = tpl("tpl-link-row");
  node.querySelector("[data-field=id]").value = link.id || "";
  node.querySelector("[data-field=label]").value = link.label || "";
  node.querySelector("[data-field=path]").value = link.path || "";
  return node;
}

export function linkEmpty() {
  return tpl("tpl-link-empty");
}

export function settingsSection(title, rows) {
  const node = fill(tpl("tpl-settings-section"), { title });
  const container = node.querySelector("[data-slot=rows]");
  if (rows.length) container.append(...rows);
  else container.append(fill(tpl("tpl-no-links"), { text: "None" }));
  return node;
}

export function settingsRow(title, meta, label, onClick) {
  const node = fill(tpl("tpl-settings-row"), { title, meta, action: label });
  node.querySelector("[data-slot=action]").addEventListener("click", onClick);
  return node;
}

// Render Git context, distinguishing "no uncommitted changes" from "we could not tell". A dirty
// marker only appears for an explicit true; null means the subprocess could not answer, and drawing
// nothing there is the honest choice — a card that implied "clean" would be acted on.
// The row itself is cloned from the shared tpl-git-row rather than pre-authored inside each card
// template: both card kinds expose only an empty [data-slot=git-row] container, so there is exactly
// one authored copy of this markup and the two cards cannot drift apart again.
// hideProviderLink skips both the link AND the "local repo" fallback text — used for shared-service
// cards, where the repository-level header already shows the one provider link once and a "local
// repo" label would be a false negative on an actual git-backed repository.
function applyGitBadge(node, tooltip, git, providerUrl, { hideProviderLink = false } = {}) {
  const row = node.querySelector("[data-slot=git-row]");
  if (!row || !git?.provider?.ok || (!git.branch && !git.shortHead)) return;

  const badge = tpl("tpl-git-row");
  row.append(badge);
  badge.hidden = false;
  const branchSlot = badge.querySelector("[data-slot=git-branch]");
  // The default branch is named by its role, not its label: "main branch" reads as a fact about
  // where you are, while a bare "main" reads as just another branch name among many.
  const branchName = git.detached ? "detached" : git.branch || "";
  const branchLabel = !git.detached && DEFAULT_BRANCHES.has(branchName)
    ? `${branchName} branch`
    : branchName;
  // No separate worktree icon/slot exists in tpl-git-row today, and a repository with two branches
  // running side-by-side is rare enough that adding new markup for it isn't worth the churn — the
  // branch name itself already disambiguates in the common case (main vs. a feature branch). This
  // covers the one gap that leaves: two worktrees that happen to share a branch name would otherwise
  // both read as plain "<branch>" with nothing marking either as the non-primary checkout.
  // Checkout rows on a repository card do not use this row at all (repository-root-row.js): their
  // tree glyph already says "worktree".
  const worktreeSuffix = git.isWorktree ? " (worktree)" : "";
  // Long branch names (ticket-prefixed, or a full feature description) would otherwise push the
  // rest of the row off. Middle-truncated because the tail of a branch name is usually the part
  // that identifies it — the shared helper's default cap is tuned for repo paths, so this passes
  // its own cap.
  branchSlot.textContent = portalMiddleEllipsis(branchLabel, BRANCH_NAME_MAX_LENGTH) + worktreeSuffix;
  if (branchSlot.textContent !== branchName + worktreeSuffix) branchSlot.title = branchName + worktreeSuffix;

  const repoLink = badge.querySelector("[data-slot=git-repo-link]");
  const repoName = badge.querySelector("[data-slot=git-repo-name]");
  if (providerUrl) {
    repoLink.hidden = false;
    repoLink.href = providerUrl;
    // Named by where it goes. Not the repo name (already the card's heading a few pixels above),
    // and deliberately not a ref like "origin/main" — this URL is the repository's landing page,
    // not a branch view, so naming a branch would promise something the link does not do.
    repoLink.querySelector("[data-slot=git-repo-label]").textContent = providerHostLabel(providerUrl);
    repoLink.title = repoNameFromProviderUrl(providerUrl);
  } else if (!hideProviderLink) {
    repoName.hidden = false;
    repoName.textContent = "local repo";
  }

  applyGitDrift(badge, git);
  pruneSeparators(badge);

  badge.title = gitTooltip(git);
  applyGitTooltipFields(tooltip, git);
}

// The middots are authored into the template between fixed positions, but most of what they
// separate is conditional — a clean repo has no sync cluster, a local-only repo has no link. Rather
// than making each dot's visibility a special case of its neighbours, drop any that no longer sits
// between two visible things. Keeps the markup declarative and the row free of trailing dots.
function pruneSeparators(badge) {
  const visible = (el) => el && !el.hidden && el.textContent.trim() !== "";
  for (const sep of badge.querySelectorAll(".git-sep")) {
    let before = sep.previousElementSibling;
    while (before && !visible(before)) before = before.previousElementSibling;
    let after = sep.nextElementSibling;
    while (after && !visible(after)) after = after.nextElementSibling;
    // The branch icon is decorative and never counts as content worth separating from.
    if (!before || before.classList.contains("git-badge-icon") || !after) sep.remove();
  }
}

// Past these ages the drift is worth interrupting for; under them the card stays silent. Silence
// being the healthy state is the point — a badge that renders always is a badge nobody reads.
const UNPUSHED_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const BASE_DRIFT_THRESHOLD_MS = 4 * 24 * 60 * 60 * 1000;

// The one thing this row says about sync state, chosen from a severity ladder. Everything the
// ladder does not select — uncommitted files, commits ahead, exact counts — is available in the
// tooltip. Those facts are real but rarely change what you do next: uncommitted work is normal
// mid-task, and commits ahead are only a problem once they have sat unpushed for a while.
//
// Time triggers and count qualifies, deliberately. Being 40 commits behind a branch that moved this
// morning is a trivial rebase; being 2 commits behind a branch point from last week is where things
// get moved out from under you. Age predicts conflict pain, so age decides whether to speak at all
// and the count only colors what is said.
//
// Ranked most severe first. Each entry returns null when it does not apply, so the first non-null
// wins and nothing below it renders.
const DRIFT_RULES = [
  // Someone else pushed to your branch, or you pushed from another machine. Structurally impossible
  // on solo work, which is exactly why it deserves the loudest treatment when it does happen: it is
  // rare, it always means something, and the conflict is with your own work.
  (git) => {
    if (!git.behind) return null;
    return {
      level: "danger",
      text: `${git.behind} behind remote`,
      title: `${git.upstream || "The remote branch"} has ${git.behind} commit${git.behind === 1 ? "" : "s"} you do not have locally — pull before continuing`,
    };
  },
  // The common case: a branch point old enough that main has likely moved underneath it.
  (git, now) => {
    const age = baseDriftAge(git, now);
    if (age == null) return null;
    const base = baseName(git);
    const suffix = fetchOlderThan(git, age, now) ? "+" : "";
    return git.baseBehind
      ? {
          level: "warn",
          text: `${formatDuration(age)}${suffix} behind ${base} (${git.baseBehind} commit${git.baseBehind === 1 ? "" : "s"})`,
          title: driftTitle(git, base, now),
        }
      // Nothing landed on the base, so there is no merge to do — only a branch point that is
      // getting old. Worth saying, but it is not the same warning as real divergence.
      : {
          level: "warn",
          text: `${formatDuration(age)}${suffix} since ${base}`,
          title: driftTitle(git, base, now),
        };
  },
  // Work that exists only on this machine. Measured from the remote tip, since the question is how
  // long the remote has been missing it, not when you last committed.
  (git, now) => {
    if (!git.ahead || !git.upstreamTipAt) return null;
    const age = now - git.upstreamTipAt * 1000;
    if (age <= UNPUSHED_THRESHOLD_MS) return null;
    return {
      level: "warn",
      text: `${formatDuration(age)} unpushed`,
      title: `${git.ahead} commit${git.ahead === 1 ? "" : "s"} not on ${git.upstream || "the remote"} — last shared commit was ${formatDuration(age)} ago`,
    };
  },
];

export function applyGitDrift(badge, git) {
  const slot = badge.querySelector("[data-slot=git-drift]");
  if (!slot) return;
  const now = Date.now();
  for (const rule of DRIFT_RULES) {
    const hit = rule(git, now);
    if (!hit) continue;
    slot.hidden = false;
    slot.textContent = `⚠ ${hit.text}`;
    slot.title = hit.title;
    slot.dataset.level = hit.level;
    return;
  }
}

// Age of the branch point, or null when there is no base to compare against or it is still fresh.
function baseDriftAge(git, now) {
  if (!git.baseMergeBaseAt || !git.baseBranch) return null;
  const age = now - git.baseMergeBaseAt * 1000;
  return age > BASE_DRIFT_THRESHOLD_MS ? age : null;
}

export function baseName(git) {
  return String(git.baseBranch || "").replace(/^origin\//, "");
}

// Nothing in the snapshot pipeline contacts a remote, so every comparison is only as fresh as the
// last fetch. When the fetch is older than the gap being reported, the gap is a lower bound.
function fetchOlderThan(git, ageMs, now = Date.now()) {
  if (!git.fetchedAt) return true;
  return now - git.fetchedAt * 1000 > ageMs;
}

function driftTitle(git, base, now = Date.now()) {
  const parts = [];
  parts.push(git.baseBehind
    ? `${git.baseBehind} commit${git.baseBehind === 1 ? "" : "s"} on ${base} not in this branch`
    : `nothing new on ${base}; only the branch point is old`);
  parts.push(git.fetchedAt
    ? `fetched ${formatDuration(now - git.fetchedAt * 1000)} ago`
    : "never fetched — counts may understate");
  return parts.join(" · ");
}

// Coarse on purpose: at dashboard glance-level "5d" and "5d 4h" mean the same thing, and the extra
// precision would imply the underlying refs are fresher than a fetch-bound measurement can be.
function formatDuration(ms) {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "under 1h";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

// Branch, commit, and working-tree state are three independent facts; crammed onto one
// "main · b4c373f · no uncommitted changes · tracking origin/main" line they read as noise. Each
// gets its own labeled row, and any field the provider could not answer stays hidden rather than
// rendering an empty or guessed value.
export function applyGitTooltipFields(tooltip, git) {
  const branch = tooltip.querySelector("[data-slot=git-detail]");
  if (branch) {
    // The branch name is already on the card's git row, so repeating it here would be the same
    // fact twice in two places a few pixels apart. Only what the row cannot show survives: the
    // upstream it tracks, and whether this root is a linked worktree.
    const parts = [];
    if (git.isWorktree) parts.push("linked worktree");
    if (git.upstream) parts.push(`tracking ${git.upstream}`);
    if (parts.length) {
      branch.hidden = false;
      tooltip.querySelector("[data-slot=git-detail-text]").textContent = parts.join(" · ");
    }
  }
  const commit = tooltip.querySelector("[data-slot=git-commit-detail]");
  if (commit && git.shortHead) {
    commit.hidden = false;
    const marks = [];
    if (git.ahead) marks.push(`${git.ahead} ahead`);
    if (git.behind) marks.push(`${git.behind} behind`);
    tooltip.querySelector("[data-slot=git-commit-text]").textContent = marks.length
      ? `${git.shortHead} · ${marks.join(", ")}`
      : git.shortHead;
  }
  const status = tooltip.querySelector("[data-slot=git-status-detail]");
  if (status) {
    status.hidden = false;
    tooltip.querySelector("[data-slot=git-status-text]").textContent = git.dirty === null
      ? "dirty state unavailable"
      : git.dirty
        ? "uncommitted changes"
        : "no uncommitted changes";
  }
  // The full arithmetic behind the card's single drift phrase. The card shows only the worst
  // relationship past threshold; here both the count and the age are always available.
  const drift = tooltip.querySelector("[data-slot=git-drift-detail]");
  if (drift && git.baseBranch && git.baseMergeBaseAt) {
    const base = git.baseBranch.replace(/^origin\//, "");
    const age = formatDuration(Date.now() - git.baseMergeBaseAt * 1000);
    drift.hidden = false;
    tooltip.querySelector("[data-slot=git-drift-text]").textContent = git.baseBehind
      ? `${age} behind ${base} (${git.baseBehind} commit${git.baseBehind === 1 ? "" : "s"})`
      : `up to date with ${base}`;
  }
  // Stated outright rather than implied: every number above is measured against remote-tracking
  // refs, so this timestamp is the bound on how much any of them can be trusted.
  const fetched = tooltip.querySelector("[data-slot=git-fetch-detail]");
  if (fetched) {
    fetched.hidden = false;
    tooltip.querySelector("[data-slot=git-fetch-text]").textContent = git.fetchedAt
      ? `${formatDuration(Date.now() - git.fetchedAt * 1000)} ago`
      : "never — counts may understate";
  }
}

// How long "Copied" stays before the control returns to its resting state.
const COPY_FEEDBACK_MS = 3000;

// One copy affordance, used by both the branch button and the container port rows. All three states
// live on one element and swap by data-attribute rather than by rewriting the label: the resting
// text keeps its own width, so the row does not reflow when the hover or copied label replaces it.
//
// The overlay is absolutely positioned over the resting label rather than replacing it, which is
// what keeps the control's width stable across all three states.
function wireCopyAffordance(button, { getText, hoverLabel, copiedLabel = "copied" }) {
  if (!button) return;
  // The overlay covers the label only, not the whole button: the button also holds the trailing
  // icon, and an overlay spanning both would right-align its text underneath that icon. Wrapping
  // the label gives the overlay a box that ends exactly where the icon begins.
  const label = button.querySelector(".copy-affordance-label");
  if (!label) return;
  const slot = document.createElement("span");
  slot.className = "copy-affordance-slot";
  label.replaceWith(slot);
  slot.append(label);
  const overlay = document.createElement("span");
  overlay.className = "copy-overlay";
  slot.append(overlay);

  let timer = null;
  const reset = () => {
    button.dataset.copyState = "idle";
    overlay.textContent = "";
  };
  const setHover = () => {
    // A hover arriving while "Copied" is showing must not preempt it: the success message is the
    // more important of the two, and it is on a timer the user did not ask to interrupt.
    if (button.dataset.copyState === "copied") return;
    button.dataset.copyState = "hover";
    overlay.textContent = hoverLabel;
  };

  button.addEventListener("mouseenter", setHover);
  button.addEventListener("focus", setHover);
  button.addEventListener("mouseleave", () => {
    if (button.dataset.copyState === "copied") return;
    reset();
  });
  button.addEventListener("blur", () => {
    if (button.dataset.copyState === "copied") return;
    reset();
  });

  button.addEventListener("click", (event) => {
    // Both call sites sit inside a <summary>, where an unhandled click would toggle the card.
    event.preventDefault();
    event.stopPropagation();
    const text = getText();
    if (!text) return;
    portalCopyText(text);
    button.dataset.copyState = "copied";
    overlay.textContent = copiedLabel;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Clear the copied state FIRST. setHover() deliberately refuses to preempt "Copied", so
      // calling it while still in that state would be a no-op and the message would never expire
      // under a stationary cursor.
      reset();
      // Then return to hover rather than idle if the pointer never left, so the label does not
      // flash to the resting state under a cursor that is still on the control.
      if (button.matches(":hover")) setHover();
    }, COPY_FEEDBACK_MS);
  });

  reset();
}

function wireCopyBranchButton(node, git) {
  const button = node.querySelector("[data-action=copy-branch]");
  if (!button) return;
  if (!git?.detached && DEFAULT_BRANCHES.has(git?.branch)) {
    // The branch name itself stays visible; only the copy affordance and its icons go. Plural:
    // the button holds both the copy glyph and the copied-state check, so removing just the first
    // would leave the check behind on a control that can never reach that state.
    for (const icon of button.querySelectorAll("portal-icon")) icon.remove();
    button.classList.add("is-static");
    // Stripping the icons only makes it LOOK inert. Left enabled it is still focusable, still
    // clickable, and still announces "Copy branch name" from the markup's aria-label — a control that
    // tells assistive technology it does something it no longer does. Sighted users see plain text;
    // keyboard and screen-reader users find a button that does nothing.
    button.disabled = true;
    button.removeAttribute("aria-label");
    return;
  }
  wireCopyAffordance(button, {
    getText: () => (git?.detached ? git.shortHead || "" : git?.branch || ""),
    hoverLabel: "copy branch",
  });
}

// Per-instance copy actions. The row already opens its URL on click, so what this adds is the
// values you cannot get by clicking: the address as text, the bare port, and the PID (the one thing
// here you reach for when a process needs killing rather than visiting).
//
// Assembled from what this instance actually has — an inactive card with no origin still offers its
// PID — and the whole control stays hidden if that leaves nothing, matching the correct-or-absent
// discipline the badges follow.
// Copy PID as a menu entry rather than a dropdown on the row.
//
// The dropdown this replaces offered three values, two of which the row already gave you: the
// origin is a link you click, and the port is the visible half of it. A caret guarding one genuinely
// useful value is a click that asks a question with one answer — the same reasoning mountCopyDropdown
// applies to the root rows. The PID keeps its place because it is the one value here you cannot
// reach any other way.
//
// Absent, not disabled, when there is no PID: a container member reports none, and an entry that
// copies an empty string reports success while writing nothing.
function mountInstanceCopyPid(node, instance) {
  const button = node.querySelector("[data-action=copy-pid]");
  if (!button) return;
  const pid = instance.process?.pid;
  if (!pid) {
    button.remove();
    return;
  }
  button.hidden = false;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    portalCopyText(String(pid));
  });
}

// Maps a container image to one of the tech glyphs in portal/shared/icon.js. Matched against the
// image reference, which is the only field that reliably names the software: container and Compose
// service names are user-chosen ("db", "api") and say nothing about what is running.
//
// Patterns are anchored on the image *path* rather than a bare substring so a registry host cannot
// produce a false positive — every Supabase image here is published as `public.ecr.aws/supabase/*`,
// which a naive /supabase/ test would also match on an unrelated registry path.
//
// Ordered: the first match wins, so more specific patterns belong before general ones.
const IMAGE_GLYPHS = [
  [/(^|\/)supabase\//i, "supabase"],
  // Tunnels expose a local port publicly. Grouped because they answer the same question on a card
  // ("this address is reachable from outside"), not because the tools are otherwise alike.
  [/(^|\/)(ngrok|cloudflare\/cloudflared|cloudflared|tailscale)\b/i, "tunnel"],
  [/(^|\/)(node|nodejs)(:|$)/i, "node"],
];

// Null when nothing matches — most images are not one of the four we have glyphs for, and an
// unrecognized image gets no icon rather than a generic placeholder that would add noise to every
// row without distinguishing anything.
export function glyphForImage(image) {
  if (!image) return null;
  for (const [pattern, name] of IMAGE_GLYPHS) {
    if (pattern.test(image)) return name;
  }
  return null;
}

// Renders a tech glyph into a card's [data-slot=tech-glyph], or leaves the slot hidden when the
// thing was not recognized. Titled with what it was inferred from, so the icon is never a claim the
// user cannot check.
function applyTechGlyph(node, glyph, source) {
  const slot = node.querySelector("[data-slot=tech-glyph]");
  if (!slot || !glyph) return;
  const icon = document.createElement("portal-icon");
  icon.setAttribute("name", glyph);
  slot.append(icon);
  slot.hidden = false;
  slot.title = source ? `${glyph} — inferred from ${source}` : glyph;
}

// Docker/process fields are current-snapshot facts only — real provider data or nothing, never a
// placeholder. A card for an instance the Docker/process provider never observed shows no badge at
// all, matching the git badge's correct-or-absent discipline.
function applyDockerBadge(node, tooltip, docker) {
  const badge = node.querySelector("[data-slot=docker]");
  if (!badge || !docker) return;

  badge.hidden = false;
  node.querySelector("[data-slot=docker-label]").textContent = docker.composeService || docker.name || "container";

  const detail = tooltip.querySelector("[data-slot=docker-detail]");
  const parts = [docker.name || docker.containerId];
  if (docker.image) parts.push(docker.image);
  if (docker.composeProject) parts.push(`compose: ${docker.composeProject}${docker.composeService ? `/${docker.composeService}` : ""}`);
  if (docker.state) parts.push(docker.state);
  detail.hidden = false;
  tooltip.querySelector("[data-slot=docker-detail-text]").textContent = parts.join(" · ");
}

function applyProcessMetricsBadge(tooltip, metrics) {
  const detail = tooltip.querySelector("[data-slot=process-metrics-detail]");
  if (!detail || !metrics) return;

  const parts = [];
  if (metrics.cpuPercent != null) parts.push(`${metrics.cpuPercent}% CPU`);
  if (metrics.residentMemoryKb != null) parts.push(`${formatMemory(metrics.residentMemoryKb)} RSS`);
  if (metrics.elapsedSeconds != null) parts.push(`up ${formatElapsed(metrics.elapsedSeconds)}`);
  if (!parts.length) return;

  detail.hidden = false;
  tooltip.querySelector("[data-slot=process-metrics-detail-text]").textContent = parts.join(" · ");
}

// Thresholds are percent of the WHOLE machine, so they mean the same thing for a single native
// process and for an 11-container Compose project. Measured against per-core percentages these
// would have fired on container count rather than real load.
//
// CPU only earns persistent space once it is worth acting on; below the warn threshold the number
// stays in the tooltip. Provisional fixed defaults — the plan doc's resource-threshold follow-up
// covers spike detection and per-project overrides, which this intentionally does not attempt.
const CPU_WARN_PERCENT_OF_HOST = 25;
const CPU_ALERT_PERCENT_OF_HOST = 60;

export function applyResourceConcernBadge(node, cpuPercentOfHost) {
  const badge = node.querySelector("[data-slot=resource-concern]");
  if (!badge || cpuPercentOfHost == null || cpuPercentOfHost < CPU_WARN_PERCENT_OF_HOST) return;
  badge.hidden = false;
  badge.textContent = `${cpuPercentOfHost.toFixed(0)}% CPU`;
  const alert = cpuPercentOfHost >= CPU_ALERT_PERCENT_OF_HOST;
  badge.dataset.tone = alert ? "danger" : "warn";
  badge.title = `${cpuPercentOfHost.toFixed(1)}% of total machine CPU — ${alert ? "very high" : "elevated"}`;
}

// `unknown` deliberately maps to neutral, not warn: an unconfigured listener answering a 4xx is not
// a fault worth coloring, matching the same decision the card-level health accent already makes.
const PORT_HEALTH_TONES = {
  healthy: "ok",
  degraded: "warn",
  starting: "warn",
  unhealthy: "danger",
};

// Leading column of a port row: the HTTP status code when the probe actually returned one, and an
// explicit "No healthcheck" otherwise. A container port that never answers HTTP (Postgres, Redis)
// is not unhealthy — it was never checked — so it gets a neutral badge rather than a red one or a
// silently empty cell.
function applyPortHealthBadge(port, instance, state) {
  const badge = port.querySelector("[data-slot=health-badge]");
  if (!badge) return;
  if (instance.status) {
    badge.textContent = String(instance.status);
    badge.dataset.tone = PORT_HEALTH_TONES[state] || "neutral";
    badge.title = `${statusText(instance)} · ${statusDetail(instance)}`;
    return;
  }
  // "N/A", not "Not Found": this column also renders real 404s, and "Not Found" would make a
  // never-probed listener read as a failed one. Kept to status-code width so the badge column stays
  // aligned instead of one long label pushing every address out of line — full wording in the title.
  badge.textContent = "N/A";
  badge.dataset.tone = "neutral";
  badge.title = `No HTTP healthcheck · ${statusDetail(instance)}`;
}

// A repository with no lastSeenAt is not "seen infinitely long ago" — such records exist (registered
// by a source that never resolved a root) and the ageing rule deliberately never hides them, so the
// card must not imply an age the registry does not claim.
function lastSeenLabel(lastSeenAt) {
  if (!lastSeenAt) return "not running";
  const elapsed = Date.now() - Date.parse(lastSeenAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "not running";
  return `last seen ${formatDuration(elapsed)} ago`;
}

function formatMemory(kb) {
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1)}GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)}MB`;
  return `${kb}KB`;
}

function formatElapsed(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Every localhost origin is http(s) by construction (see http-probe.mjs) — the scheme is never
// informative here, only visual noise, so the link keeps its real href but displays without it.
// Command and PID, plus who launched it when ancestry resolved. Several instances of one repo
// started by hand usually means stale processes; one started by a coding agent is a working test
// environment, and the page cannot tell those apart from ports alone.
function provenanceText(instance) {
  const base = `${instance.process.command} (${instance.process.pid})`;
  const label = provenanceLabel(instance.provenance);
  return label ? `${base} · ${label}` : base;
}

// Just the port. Every origin on this page is loopback by construction, so "localhost:" and
// "127.0.0.1:" are the same prefix repeated on every row — the port is the only part that
// identifies anything. The full origin stays on the link's href and title for copying and for the
// rare case where the host actually differs.
export function displayOrigin(origin) {
  try {
    const url = new URL(origin);
    // A non-loopback host is genuinely distinguishing, so it survives.
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
      return origin.replace(/^https?:\/\//, "");
    }
    return url.port ? `:${url.port}` : origin.replace(/^https?:\/\//, "");
  } catch {
    return origin.replace(/^https?:\/\//, "");
  }
}

function repoNameFromProviderUrl(providerUrl) {
  try {
    const path = new URL(providerUrl).pathname.replace(/^\/|\/$/g, "");
    return path.split("/").pop() || path || "repo";
  } catch {
    return "repo";
  }
}

// Known forges, so the link is labeled by where it actually goes. Derived from the host rather than
// hardcoded to "GitHub": a self-hosted GitLab or a Bitbucket remote should not claim to be GitHub.
const PROVIDER_LABELS = [
  [/(^|\.)github\.com$/i, "GitHub"],
  [/(^|\.)gitlab\.com$/i, "GitLab"],
  [/(^|\.)bitbucket\.org$/i, "Bitbucket"],
];

function providerHostLabel(providerUrl) {
  try {
    const host = new URL(providerUrl).hostname;
    for (const [pattern, label] of PROVIDER_LABELS) {
      if (pattern.test(host)) return label;
    }
    // An unrecognized forge (self-hosted GitLab, Gitea, an internal mirror) is named by its host,
    // which is more informative than a generic "remote repo" and never claims the wrong vendor.
    return host.replace(/^www\./i, "");
  } catch {
    return "remote repo";
  }
}

function gitTooltip(git) {
  const parts = [git.detached ? `detached at ${git.shortHead}` : `${git.branch} · ${git.shortHead}`];
  if (git.isWorktree) parts.push("linked worktree");
  parts.push(git.dirty === null ? "dirty state unavailable" : git.dirty ? "uncommitted changes" : "no uncommitted changes");
  if (git.upstream) parts.push(`tracking ${git.upstream}`);
  return parts.join(" · ");
}

function wireCardActions(node, project, instance, actions) {
  const trigger = node.querySelector("[data-action=menu]");
  const menu = node.querySelector("[data-menu]");
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    actions.onToggleMenu(node);
  });
  // No link wiring here any more: Add link / Edit links moved into the Links panel, where
  // user-added links sit alongside discovered ones as another source. No copy/open wiring either —
  // those entries were removed because the origin link in the same row already opens on click and
  // the row carries its own copy affordance.
  const history = node.querySelector("[data-action=history]");
  // Only an instance the current snapshot minted a key for has readable history.
  if (!instance.opaqueKey || !actions.onHistory) history.hidden = true;
  else {
    history.addEventListener("click", () => {
      actions.onCloseMenus();
      actions.onHistory(project, instance);
    });
  }
  // Discovered-routes trigger lives outside the three-dot menu (see index.html's routes-trigger
  // slot comment) — mounting a live widget is app.js's job (it owns the fetch/mutation calls this
  // needs), templates.js only reveals the reserved slot and hands off. Same key requirement as
  // history: suggestions are fetched live against the app's current origin.
  const routesTrigger = node.querySelector("[data-slot=routes-trigger]");
  if (routesTrigger && instance.opaqueKey && actions.onMountRoutesTrigger) {
    routesTrigger.hidden = false;
    actions.onMountRoutesTrigger(routesTrigger, project, instance);
  }
  // Optional, like hide below: an unrecognized listener's card has had both removed.
  node.querySelector("[data-action=associate]")?.addEventListener("click", () => {
    actions.onCloseMenus();
    actions.onAssociate(project, instance);
  });
  node.querySelector("[data-action=alias]")?.addEventListener("click", () => {
    actions.onCloseMenus();
    actions.onAlias(project, instance);
  });
  // Optional: hide is repository-scoped, so a card nested inside a repository card has had this
  // button removed before wiring runs. A standalone card still has it.
  node.querySelector("[data-action=hide]")?.addEventListener("click", () => {
    actions.onCloseMenus();
    actions.onHide(project, instance);
  });
  menu.addEventListener("click", (event) => event.stopPropagation());
  revealActionMenuIfUsable(node);
}

// Inside a repository card the project name is already the card's own heading, so leading with it
// again made every member read "roborepo — roborepo — :4317". A member names itself: its app label,
// its page title, or failing both the process that owns it.
function instanceTitle(project, instance) {
  if (project.isMember) {
    // Command name before page title, for the same reason memberName prefers it: a <title> is
    // written for site visitors ("localhostr — one config, every agentic coding harness") and names
    // nothing an operator is looking at. The full title moves to the tooltip.
    return instance.app?.name || instance.process.command || shortPageTitle(instance.title) || `Port ${instance.bind.port}`;
  }
  const projectName = project.name === UNMATCHED_PROJECT_NAME ? null : project.name;
  return projectName || instance.app?.name || instance.title || instance.process.command;
}

// Leading segment of a page title, before the separator sites use to append a tagline.
function shortPageTitle(title) {
  if (typeof title !== "string") return null;
  return title.split(/\s+[—–|·:]\s+/)[0]?.trim() || null;
}
