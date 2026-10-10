import { portalHideLoading, portalSetUpdatedAt } from "/portal/shared/api.js";
import * as api from "./api.js";
import * as state from "./state.js";
import * as tmpl from "./templates.js";
import { isCheckoutRowOpen, setCheckoutRowOpen } from "./repository-root-row.js";
import * as fields from "./form-fields.js";
import { createHistoryView } from "./history-view.js";
import { buildRoutesDropdown, fillApiRouteDialog } from "./suggestions-view.js";
import { configureLinksTrigger } from "/portal/shared/repository-components.js";
import { createRepositorySourcesDialog } from "/portal/shared/repository-sources-dialog.js";
import { autoDiscoveryPrompt } from "/portal/shared/repository-sources-templates.js";
import { fetchSetupState } from "/portal/shared/setup-api.js";
import "/portal/shared/notice.js";
import "/portal/shared/menu-button.js";
import "/portal/shared/copy-menu.js";
// The API-route rows in the Links panel use <portal-copy-button> for their curl commands.
import "/portal/shared/copy-button.js";

// A stale opaque key (the app moved ports since this render) resolves by reloading the snapshot
// rather than surfacing an error.
const historyView = createHistoryView({ onStale: () => load({ force: true }) });

// Enabling auto-discovery starts the first process scan server-side; the forced load then waits on
// that same in-flight scan, so the page fills in as soon as it lands.
const sourcesDialog = createRepositorySourcesDialog({
  onPending: (isPending) => { if (isPending) setRuntimeSyncStatus(true, true); },
  onChange: () => load({ force: true }),
  onAutoDiscoveryEnabled: () => sourcesDialog.refresh(),
});
const autoDiscoveryCta = document.getElementById("auto-discovery-cta");
autoDiscoveryCta.append(autoDiscoveryPrompt({ onEnable: () => sourcesDialog.enableAutoDiscovery() }));

// Built once and reused across every render/reconcile — the Active apps header holds this same
// node for the page's lifetime so refresh/settings listeners and live spinner state never get
// torn down by a rebuild.
const toolbarActionsNode = tmpl.toolbarActions();
const syncStatusNode = tmpl.syncStatus();
const syncStatusText = syncStatusNode.querySelector("[data-slot=text]");
const runtimeHeaderNode = document.createElement("div");
runtimeHeaderNode.className = "runtime-group-header";
runtimeHeaderNode.append(syncStatusNode, toolbarActionsNode);

const refs = {
  refresh: toolbarActionsNode.querySelector("#refresh"),
  refreshSpinner: toolbarActionsNode.querySelector(".spinner"),
  // <portal-icon> draws its <svg> only once connected, so the detached toolbar has none yet; hide
  // the element itself (base.css's [hidden] wins over portal-icon's display).
  refreshIcon: toolbarActionsNode.querySelector("portal-icon"),
  settings: toolbarActionsNode.querySelector("#settings"),
  warnings: document.getElementById("warnings"),
  content: document.getElementById("content"),
  linkDialog: document.getElementById("link-dialog"),
  linkForm: document.getElementById("link-form"),
  linkList: document.getElementById("link-list"),
  linkAdd: document.getElementById("link-add"),
  appDialog: document.getElementById("app-dialog"),
  appForm: document.getElementById("app-form"),
  appRemoveAssociation: document.getElementById("app-remove-association"),
  aliasDialog: document.getElementById("alias-dialog"),
  aliasForm: document.getElementById("alias-form"),
  composeRepoDialog: document.getElementById("compose-repo-dialog"),
  composeRepoForm: document.getElementById("compose-repo-form"),
  settingsDialog: document.getElementById("settings-dialog"),
  settingsBody: document.getElementById("settings-body"),
  apiRouteDialog: document.getElementById("api-route-dialog"),
};

let lastSnapshot = null;
let lastHash = null;
let pollTimer = null;
// Cards the auto-poll last rendered, by stable key, so a poll can update/add/mark-offline
// in place instead of tearing down DOM the user may be interacting with (open <details>,
// open action menu, a link about to be clicked).
const renderedCards = new Map();

// force: true is a user-clicked refresh, not the silent background poll. A user click is a good
// moment to clear any cards marked offline by earlier polls — the user just took an action and
// expects the view to reflect current reality, so a full rebuild (reconcile: false) is fine here
// even though the background poll must never do that on its own.
async function load({ force = false } = {}) {
  setRuntimeSyncStatus(true, runtimeAutoDiscoveryEnabled(lastSnapshot));
  if (force) setRefreshing(true);
  try {
    const [snap, setup] = await Promise.all([
      force ? api.refreshDeveloperRuntime() : api.fetchDeveloperRuntime(),
      fetchSetupState(),
    ]);
    snap.setup = setup;
    applySnapshot(snap, { reconcile: !force });
  } catch (err) {
    showError(err.message);
    setRuntimeSyncStatus(false, runtimeAutoDiscoveryEnabled(lastSnapshot));
  } finally {
    portalHideLoading();
    if (force) setRefreshing(false);
  }
}

function setRefreshing(refreshing) {
  refs.refresh.disabled = refreshing;
  refs.refresh.setAttribute("aria-busy", refreshing ? "true" : "false");
  refs.refreshSpinner.hidden = !refreshing;
  refs.refreshIcon.hidden = refreshing;
}

function setRuntimeSyncStatus(syncing, visible = true) {
  syncStatusNode.hidden = !visible;
  syncStatusNode.classList.toggle("is-syncing", syncing);
  syncStatusNode.classList.toggle("is-synced", !syncing);
  syncStatusText.textContent = syncing ? "Syncing" : "Synced";
}

// `reconcile: true` (background poll) patches existing cards in place and never removes a
// card that disappeared from the snapshot — it's marked offline instead. User-triggered
// mutations (hide/favorite/associate/alias/settings) pass reconcile: false (the default) and
// get an immediate full rebuild, since the user just took an action and expects it reflected
// right away.
function applySnapshot(snapshot, { reconcile = false } = {}) {
  lastSnapshot = snapshot;
  setRuntimeSyncStatus(snapshot.refresh?.state === "refreshing", runtimeAutoDiscoveryEnabled(snapshot));
  autoDiscoveryCta.hidden = runtimeAutoDiscoveryEnabled(snapshot);
  const hash = state.snapshotHash(snapshot);
  // The hash-skip only makes sense for the reconcile path, where "nothing changed" really does
  // mean nothing to do. A full rebuild (reconcile: false) can be the only thing that clears
  // offline-marked cards — that's client-only DOM state the server-side hash knows nothing
  // about — so a full rebuild must always render even when the snapshot itself looks unchanged.
  if (hash !== lastHash || !reconcile) {
    lastHash = hash;
    render(snapshot, { reconcile });
  }
  portalSetUpdatedAt(snapshot.generatedAt, { cadenceMs: 10000 });
}

function render(snapshot, { reconcile }) {
  renderWarnings(snapshot);
  pruneDepartedTracking(snapshot);

  // Keep the first-run Runtime surface focused on its one actionable banner. The full empty state
  // remains available once discovery is enabled, and all repository/member rendering stays intact
  // for real data (or when the retained mock-view flag is turned back on).
  if (!runtimeAutoDiscoveryEnabled(snapshot) && !hasRuntimeContent(snapshot)) {
    renderedCards.clear();
    refs.content.replaceChildren();
    return;
  }

  const sections = [
    {
      id: "active",
      kind: "group",
      title: "Running now",
      headerEnd: runtimeHeaderNode,
      // Refresh/Settings live in this header, so it must always render even with zero active
      // apps — otherwise those controls would vanish along with the empty-state fallback.
      alwaysShow: true,
      cards: [
        // One card per repository, holding every instance that resolved to it however discovery
        // found it. What used to be two separate card sources here — per-app instance cards and
        // per-Compose-project cards — are now members inside these.
        ...snapshot.repositories.map((repository) => ({
          key: repository.repositoryId,
          hash: JSON.stringify(repository),
          build: () => tmpl.repositoryCard(repository, {
            instanceActions: cardActions(),
            composeActions: composeProjectActions(),
            repositoryActions: repositoryActions(),
            // Members that were present on the previous render but are gone from this snapshot.
            // The top-level offline sweep keys on card id, and a repository card outlives its
            // members — without this, a stopped member vanished silently instead of getting the
            // greyed-out treatment every other card kind gets when its process exits.
            departedMembers: departedMembersFor(repository),
          }),
        })),
        // Instances with no repositoryId (a `process:` identity, or a Compose project whose repo
        // never resolved) still get their own card — they have no repository to be a member of.
        ...snapshot.projects
          .filter((project) => !project.repositoryId)
          .flatMap((project) =>
            project.instances.map((instance) => ({
              key: instance.associationKey,
              hash: JSON.stringify(instance) + JSON.stringify(project),
              build: () => tmpl.instanceCard(project, instance, cardActions()),
            })),
          ),
        ...snapshot.composeProjects
          .filter((composeProject) => !composeProject.repositoryId)
          .map((composeProject) => ({
            key: `compose:${composeProject.name}`,
            hash: JSON.stringify(composeProject),
            build: () => tmpl.composeProjectCard(composeProject, composeProjectActions()),
          })),
      ],
    },
    {
      id: "unmatched",
      kind: "collapsible",
      title: "Unrecognized listeners",
      meta: (n) => `${n} other hidden/noisy listeners`,
      // An unmatched instance that resolved to a repository is already rendered as a member of that
      // repository's card; only the genuinely unattributable ones stay here.
      cards: snapshot.unmatchedInstances.filter((instance) => !instance.project?.repositoryId).map((instance) => ({
        key: instance.associationKey,
        hash: JSON.stringify(instance),
        build: () =>
          tmpl.instanceCard(
            {
              name: state.UNMATCHED_PROJECT_NAME,
              identity: instance.project?.identity,
              unrecognized: true,
            },
            instance,
            // No Links: saved links belong to an app slot these listeners do not have, and adding one
            // would create a stray saved app. See instanceCard for the menu entries dropped too.
            { ...cardActions(), onMountRoutesTrigger: null },
          ),
      })),
    },
    {
      // What remains of the old "Inactive saved projects" list. Repositories are no longer here —
      // they render in the main list above with their own lifecycle state, which is the whole point
      // of persisting them: a repository you ran once and stopped stays listed, where before only
      // ones you had explicitly configured an app slot for appeared at all.
      //
      // Saved app slots that have never resolved to a repository have nowhere to go, so they stay.
      // They are configuration the user deliberately created — names, quick links, health checks —
      // and dropping them because discovery has not yet matched them would lose real work. The
      // section empties itself as they resolve.
      id: "inactive",
      kind: "group",
      title: "Saved apps",
      meta: (n) => `${n} not yet matched to a repository`,
      cards: snapshot.inactiveProjects
        .filter((project) => !project.repositoryId)
        .map((project) => ({
          key: `${project.identity}#${project.app?.id || ""}`,
          hash: JSON.stringify(project),
          build: () => tmpl.inactiveCard(project, cardActions()),
        })),
    },
  ];

  if (!reconcile) {
    renderedCards.clear();
    const visible = sections.filter(
      (section) => section.cards.length || section.alwaysShow,
    );
    refs.content.replaceChildren(...visible.map(buildSection));
    if (!sections.some((section) => section.cards.length)) {
      refs.content.append(emptyStateNode(snapshot));
    }
    return;
  }

  reconcileSections(sections, snapshot);
}

function hasRuntimeContent(snapshot) {
  return [
    snapshot.repositories,
    snapshot.projects,
    snapshot.composeProjects,
    snapshot.unmatchedInstances,
    snapshot.inactiveProjects,
  ].some((items) => Array.isArray(items) && items.length > 0);
}

function emptyStateNode(snapshot) {
  if (snapshot.capabilities.discovery === "supported") {
    return tmpl.emptyState(
      "No active HTTP apps found",
      // While auto-discovery is off no refresh can find anything; the Enable prompt above is the way.
      !runtimeAutoDiscoveryEnabled(snapshot)
        ? "Runtime is not watching running apps while auto-discovery is off."
        : "Refresh after starting a local development server.",
    );
  }
  return tmpl.emptyState(
    "Saved projects remain available",
    tmpl.noticeWithDoc(snapshot.capabilities.message),
  );
}

function runtimeAutoDiscoveryEnabled(snapshot) {
  return snapshot?.setup?.repositories?.autoDiscoveryEnabled ?? (snapshot?.autoDiscovery?.enabled === true);
}

function buildSection(section) {
  const nodes = section.cards.map(({ key, hash, build }) => {
    const node = build();
    renderedCards.set(sectionCardKey(section.id, key), {
      node,
      hash,
      offline: false,
    });
    return node;
  });
  const groupEl =
    section.kind === "collapsible"
      ? tmpl.collapsibleGroup(section.title, section.meta(nodes.length), nodes)
      : tmpl.group(
          section.title,
          section.headerEnd ?? section.meta(nodes.length),
          nodes,
        );
  groupEl.dataset.sectionId = section.id;
  return groupEl;
}

function sectionCardKey(sectionId, key) {
  return `${sectionId}::${key}`;
}

// Auto-poll reconciliation: updates/adds cards without ever removing one that vanished from
// the snapshot (marks it offline instead) and never rebuilds a section's group/details element,
// so open <details>, an open action menu, or a click in flight all survive a background poll.
function reconcileSections(sections, snapshot) {
  for (const section of sections) reconcileSection(section);
  const anyVisible = [...renderedCards.values()].some(
    (entry) => !entry.offline,
  );
  const emptyNode = refs.content.querySelector(".empty-state");
  if (!anyVisible && !emptyNode) {
    refs.content.append(emptyStateNode(snapshot));
  } else if (anyVisible && emptyNode) {
    emptyNode.remove();
  }
}

function reconcileSection(section) {
  const existingGroup = refs.content.querySelector(
    `[data-section-id="${section.id}"]`,
  );
  if (!section.cards.length && !existingGroup && !section.alwaysShow) return;
  const groupEl = existingGroup || appendSection(section);
  const grid = groupEl.querySelector(".instance-grid");

  const seenKeys = new Set();
  let index = 0;
  for (const { key, hash, build } of section.cards) {
    const cardKey = sectionCardKey(section.id, key);
    seenKeys.add(cardKey);
    const existing = renderedCards.get(cardKey);
    if (!existing) {
      const node = build();
      renderedCards.set(cardKey, { node, hash, offline: false });
      grid.insertBefore(node, grid.children[index] || null);
    } else if (
      (existing.offline || existing.hash !== hash) &&
      !hasOpenMenu(existing.node)
    ) {
      const node = build();
      // A poll-driven hash change (health/CPU/RSS ticking) shouldn't silently collapse a
      // <details> the operator opened — e.g. an expanded compose-project card — since the
      // rebuilt node is a fresh element with no memory of the old one's open state.
      //
      // The card root is the <details> on most kinds. A repository card is a plain wrapper with
      // no <details> of its own — each worktree row inside it is independently collapsible, so
      // every one of those needs its state carried forward, matched by rootId since DOM order
      // across a rebuild is not guaranteed to match.
      const disclosureOf = (el) => (el instanceof HTMLDetailsElement ? el : el.querySelector(":scope > details"));
      const prevDisclosure = disclosureOf(existing.node);
      const nextDisclosure = disclosureOf(node);
      if (prevDisclosure && nextDisclosure) {
        nextDisclosure.open = prevDisclosure.open;
      }
      const prevRoots = existing.node.querySelectorAll(".repository-root[data-root-id]");
      if (prevRoots.length) {
        const openByRootId = new Map([...prevRoots].map((el) => [el.dataset.rootId, isCheckoutRowOpen(el)]));
        for (const nextRoot of node.querySelectorAll(".repository-root[data-root-id]")) {
          if (openByRootId.has(nextRoot.dataset.rootId)) {
            setCheckoutRowOpen(nextRoot, openByRootId.get(nextRoot.dataset.rootId));
          }
        }
      }
      const wasOffline = existing.offline;
      existing.node.replaceWith(node);
      // A card coming back from offline was parked at the end of the grid by markCardOffline, so
      // replacing in place would strand it below the live cards. Re-seat it at its live position.
      if (wasOffline) grid.insertBefore(node, grid.children[index] || null);
      renderedCards.set(cardKey, { node, hash, offline: false });
    }
    index += 1;
  }
  for (const [cardKey, entry] of renderedCards) {
    if (
      !cardKey.startsWith(`${section.id}::`) ||
      seenKeys.has(cardKey) ||
      entry.offline
    )
      continue;
    if (hasOpenMenu(entry.node)) continue;
    markCardOffline(entry.node);
    entry.offline = true;
  }
  if (section.meta) {
    const visibleCount = grid.querySelectorAll(
      ".instance-card:not(.is-offline)",
    ).length;
    groupEl.querySelector("[data-slot=meta]").textContent =
      section.meta(visibleCount);
  }
}

// Members seen on the last render, per repository, so the next one can tell which disappeared.
// Keyed by associationKey (stable across restarts and port changes) rather than port, so a dev
// server that came back on a different port reads as the same member returning, not a new one.
const lastMembersByRepository = new Map();

// A repository with no cards left stops being tracked, so its members are not resurrected as
// "departed" if it later reappears.
function pruneDepartedTracking(snapshot) {
  const live = new Set((snapshot.repositories || []).map((repository) => repository.repositoryId));
  for (const key of lastMembersByRepository.keys()) {
    if (!live.has(key)) lastMembersByRepository.delete(key);
  }
}

function departedMembersFor(repository) {
  const previous = lastMembersByRepository.get(repository.repositoryId) || new Map();
  const current = new Map(repository.members.map((member) => [member.associationKey, member]));
  const departed = [];
  for (const [key, member] of previous) {
    if (!current.has(key)) departed.push(member);
  }
  lastMembersByRepository.set(repository.repositoryId, current);
  return departed;
}

// Any open menu anywhere in the card, including a member's. The guard exists so a poll-driven
// rebuild never yanks a card out from under an operator mid-interaction, and a repository card
// destroys its members when it rebuilds — so a member's open menu has to block the rebuild just as
// the card's own does. Checking only the first [data-menu] in the subtree found the card's own
// menu, saw it closed, and rebuilt anyway.
function hasOpenMenu(node) {
  return [...node.querySelectorAll("[data-menu]")].some((menu) => !menu.hidden);
}

function appendSection(section) {
  const groupEl = buildSection({ ...section, cards: [] });
  refs.content.append(groupEl);
  return groupEl;
}

// An offline card is a leftover from a previous render whose instance is gone. It stays visible as
// a tombstone, but sinks to the end of its grid so the things actually running stay at the top —
// otherwise a long-dead app holds a prime slot above live ones indefinitely.
function markCardOffline(node) {
  node.classList.add("is-offline");
  const trigger = node.querySelector("[data-action=menu]");
  if (trigger) trigger.disabled = true;
  node.querySelector("[data-menu]")?.setAttribute("hidden", "");
  node.parentNode?.append(node);
}

function renderWarnings(snapshot) {
  refs.warnings.hidden =
    !snapshot.warnings?.length && snapshot.refresh?.state !== "failed";
  refs.warnings.replaceChildren();
  for (const warning of snapshot.warnings || [])
    refs.warnings.append(tmpl.notice(warning));
  if (snapshot.refresh?.state === "failed")
    refs.warnings.append(
      tmpl.notice(`Last successful snapshot: ${snapshot.generatedAt}`),
    );
}

function cardActions() {
  return {
    onAddLink: openAddLinkDialog,
    onEditLinks: openLinkDialog,
    onAssociate: openAppDialog,
    onAlias: openAliasDialog,
    onHide: hideInstance,
    onToggleMenu: toggleActionMenu,
    onCloseMenus: closeActionMenus,
    onHistory: (project, instance) => historyView.open(project, instance),
    onMountRoutesTrigger: mountRoutesTrigger,
  };
}

// Repository-scoped. Actions whose subject is the repository itself (pin, hide, associate) write to
// the repository registry against its id. Actions whose subject is a running app still fan out to
// members, because that is where per-app settings are keyed — the distinction is whether the state
// has to survive the process exiting.
function repositoryActions() {
  return {
    onTogglePinned: toggleRepositoryPinned,
    onHide: hideRepository,
    onIgnore: ignoreRepository,
    onToggleMenu: toggleActionMenu,
    onCloseMenus: closeActionMenus,
    // Binding a repository path describes the whole repository, so the action lives on this menu
    // rather than on the Compose card nested inside it. Same dialog either way.
    onAssociateRepo: openComposeRepoDialog,
  };
}

// One write to the repository registry, against the repository's own id.
//
// This replaces a fan-out that wrote a `favorite` flag to every member and compose group. That
// approach could not express the state it was asked to store: an idle repository has no members, so
// the loops ran zero times and the toggle silently did nothing — the user clicked and the page did
// not change. Pinning belongs to the repository, which exists whether or not anything is running in
// it, so it is stored there.
async function toggleRepositoryPinned(repository) {
  try {
    const result = await api.setRepositoryPinned({
      repositoryId: repository.repositoryId,
      pinned: !repository.pinned,
    });
    applySnapshot(result.developerRuntime || result);
  } catch (err) {
    showError(err.message);
  }
}

async function hideRepository(repository) {
  try {
    let latest = null;
    let revision = lastSnapshot.settingsRevision;
    for (const group of repository.composeGroups) {
      const result = await api.updateComposeProject({ revision, composeProject: group.name, hidden: true });
      latest = result.developerRuntime || result;
      revision = latest.settingsRevision;
    }
    for (const member of repository.members) {
      const result = await api.updateProject({
        revision,
        projectIdentity: member.projectIdentity,
        appId: member.instance?.app?.id || "web",
        appHidden: true,
      });
      latest = result.developerRuntime || result;
      revision = latest.settingsRevision;
    }
    if (latest) applySnapshot(latest);
  } catch (err) {
    showError(err.message);
  }
}

function composeProjectActions() {
  return {
    onAssociateRepo: openComposeRepoDialog,
    onHide: hideComposeProject,
    onToggleMenu: toggleActionMenu,
    onCloseMenus: closeActionMenus,
    onHistory: (project, instance) => historyView.open(project, instance),
    onMountRoutesTrigger: mountRoutesTrigger,
  };
}

function openComposeRepoDialog(composeProject) {
  fields.setValue("compose-repo-project", composeProject.name);
  fields.setValue("compose-repo-project-name", composeProject.name);
  fields.setValue("compose-repo-path", composeProject.repoPath || "");
  fields.setText("compose-repo-error", "");
  refs.composeRepoDialog.showModal();
}

async function hideComposeProject(composeProject) {
  try {
    const result = await api.updateComposeProject({
      revision: lastSnapshot.settingsRevision,
      composeProject: composeProject.name,
      hidden: true,
    });
    applySnapshot(result.developerRuntime || result);
  } catch (err) {
    showError(err.message);
  }
}

function openAddLinkDialog(project, instance) {
  openLinkDialog(project, instance);
}

// The saved links for one app, in the {id, label, path} shape the routes panel renders.
function currentLinksFor(project, instance) {
  const appId = instance.app?.id || "web";
  const projectIdentity = project.identity || instance.project?.identity;
  return state.currentLinks(lastSnapshot, projectIdentity, appId);
}

// Removes one saved link by id, writing the remaining set back — the links API replaces the whole
// array rather than patching one entry, so "delete" is "save everything except this".
async function deleteLink(project, instance, linkId) {
  const appId = instance.app?.id || "web";
  const projectIdentity = project.identity || instance.project?.identity;
  const remaining = state
    .currentLinks(lastSnapshot, projectIdentity, appId)
    .filter((link) => link.id !== linkId);
  try {
    const result = await api.updateLinks({
      revision: lastSnapshot.settingsRevision,
      projectIdentity,
      appId,
      links: remaining,
    });
    applySnapshot(result.developerRuntime || result);
  } catch (err) {
    showError(err.message);
  }
}

// Mounts a portal-menu-button (portal/shared/menu-button.js) into a reserved Links slot: a member
// card's routes-trigger, or a checkout row's root-links (see index.html). Panel content is fetched
// live, so it is built once on first open rather than for every card on every render — same
// lazy-fetch discipline historyView uses, just per-card now instead of one shared dialog.
//
// `discoveredOnly` is for a promoted Compose container. Its discovered pages and APIs load by opaque
// key like any instance's, but saved links are keyed by project identity and app id in settings,
// which Compose containers do not have — so the panel offers no add, edit, capture, or delete.
function mountRoutesTrigger(slotNode, project, instance, { discoveredOnly = false } = {}) {
  const button = document.createElement("portal-menu-button");
  // "Links": the panel lists navigable pages, API endpoints, and the user's own saved links, and
  // one plain word covers all three.
  configureLinksTrigger(button);
  let loaded = false;
  // Rebuilt when the app's saved links change, not on every open: the discovered half costs a fetch
  // and does not change between polls, but the user-added half is now editable from inside this very
  // panel — so an add, edit, or delete has to invalidate the cached content or the list would still
  // show what it held when it was first opened.
  let renderedLinkState = null;
  const linkStateKey = () => (discoveredOnly ? "" : JSON.stringify(currentLinksFor(project, instance)));
  const originalToggle = button.toggle.bind(button);
  button.toggle = async () => {
    if (!loaded || renderedLinkState !== linkStateKey()) {
      loaded = true;
      renderedLinkState = linkStateKey();
      button.panelContent = await buildRoutesDropdown(project, instance, discoveredOnly
        ? { onStale: () => load({ force: true }), onOpenApiRoute: openApiRouteDialog }
        : {
          onStale: () => load({ force: true }),
          captureLink: captureRouteLink,
          isSaved: isRouteSaved,
          onOpenApiRoute: openApiRouteDialog,
          // User-added links render in the Pages section as their own source, alongside discovered
          // ones — this is where adding and editing them now lives, rather than on the three-dot menu.
          userLinks: currentLinksFor(project, instance),
          onAddLink: openAddLinkDialog,
          onEditLink: openLinkDialog,
          onDeleteLink: deleteLink,
        });
    }
    originalToggle();
  };
  slotNode.replaceWith(button);
}

// Opens the shared API contract modal for one endpoint. The routes popover is closed first: it is
// a fixed-position panel anchored to its card, so leaving it open would float it above the modal's
// backdrop. closeActionMenus() does not cover it — that one handles the [data-menu] three-dot
// menus, and this is a portal-menu-button widget with its own close().
function openApiRouteDialog(instance, suggestion) {
  for (const menu of refs.content.querySelectorAll("portal-menu-button")) menu.close?.();
  fillApiRouteDialog(refs.apiRouteDialog, instance, suggestion);
  refs.apiRouteDialog.showModal();
}

function isRouteSaved(project, instance, path) {
  const appId = instance.app?.id || "web";
  const projectIdentity = project.identity || instance.project?.identity;
  const links = state.currentLinks(lastSnapshot, projectIdentity, appId);
  return links.some((link) => link.path === path);
}

// Captures one discovered route into the app's saved links — no free-text dialog detour, since a
// discovered route is already a known-good, server-validated path. Skips the mutation entirely if
// the path is already saved (checked by the caller via isRouteSaved before this ever runs, and
// re-checked here since the dropdown's list is built once per open and could go stale if the user
// edits links in another tab mid-session). updateLinks still runs its own path validation
// (normalizeRoutePath) and revision-conflict check server-side.
async function captureRouteLink(project, instance, suggestion) {
  const appId = instance.app?.id || "web";
  const projectIdentity = project.identity || instance.project?.identity;
  const links = state.currentLinks(lastSnapshot, projectIdentity, appId);
  if (links.some((link) => link.path === suggestion.path)) return;
  const result = await api.updateLinks({
    revision: lastSnapshot.settingsRevision,
    projectIdentity,
    appId,
    links: [...links, { label: suggestion.label || suggestion.path, path: suggestion.path }],
  });
  applySnapshot(result.developerRuntime || result);
}

function openLinkDialog(project, instance) {
  const appId = instance.app?.id || "web";
  const projectIdentity = project.identity || instance.project?.identity;
  fields.setValue("link-project", projectIdentity);
  fields.setValue("link-app", appId);
  fields.setText("link-error", "");
  const links = state.currentLinks(lastSnapshot, projectIdentity, appId);
  renderLinkRows([...links, { label: "", path: "" }]);
  refs.linkDialog.showModal();
}

function openAppDialog(project, instance) {
  fillAppDialog(project, instance);
  fields.setText("app-error", "");
  refs.appDialog.showModal();
}

function fillAppDialog(project, instance) {
  const projectIdentity = project.identity || instance.project?.identity || "";
  const appId = instance.app?.id || "web";
  const projectSettings =
    state.currentProjectSettings(lastSnapshot, projectIdentity) || {};
  const appSettings =
    state.currentAppSettings(lastSnapshot, projectIdentity, appId) ||
    instance.app ||
    {};
  fields.setValue("app-association", instance.associationKey);
  fields.setValue("app-project", projectIdentity);
  fields.setValue(
    "app-project-name",
    project.name === state.UNMATCHED_PROJECT_NAME
      ? ""
      : projectSettings.name || project.name,
  );
  fields.setValue("app-id", appId);
  fields.setValue("app-name", appSettings.name || "Web");
  fields.setValue("app-origin", appSettings.originPreference || "localhost");
  fields.setChecked("app-project-favorite", projectSettings.favorite);
  fields.setChecked("app-project-hidden", projectSettings.hidden);
  fields.setChecked("app-favorite", appSettings.favorite);
  fields.setChecked("app-hidden", appSettings.hidden);
  fields.setValue("app-health-path", appSettings.health?.path);
  fields.setCsv("app-health-statuses", appSettings.health?.acceptedStatuses);
  fields.setCsv("app-match-process", appSettings.match?.process);
  fields.setCsv("app-match-title", appSettings.match?.title);
  fields.setCsv("app-match-path", appSettings.match?.path);
  refs.appRemoveAssociation.hidden = !instance.associationKey;
}

function openAliasDialog(project, instance) {
  fields.setValue("alias-from", instance.project?.identity);
  fields.setValue("alias-to", project.identity || instance.project?.identity);
  fields.setChecked("alias-confirmed", false);
  fields.setText("alias-error", "");
  refs.aliasDialog.showModal();
}

refs.refresh.addEventListener("click", () => load({ force: true }));
refs.settings.addEventListener("click", () => {
  renderSettingsDialog();
  refs.settingsDialog.showModal();
});
document.addEventListener("click", closeActionMenus);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeActionMenus();
});
refs.linkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await mutateDialog(refs.linkDialog, "link-error", () =>
    api.updateLinks({
      revision: lastSnapshot.settingsRevision,
      projectIdentity: fields.readValue("link-project"),
      appId: fields.readValue("link-app"),
      links: serializeLinkRows(),
    }),
  );
});
refs.linkAdd.addEventListener("click", () =>
  addLinkRow({ label: "", path: "" }),
);
refs.appForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const projectIdentity = fields.readValue("app-project");
  const appId = fields.readValue("app-id");
  await mutateDialog(refs.appDialog, "app-error", async () => {
    const assoc = fields.readValue("app-association");
    let revision = lastSnapshot.settingsRevision;
    if (assoc) {
      const associationResult = await api.updateAssociation({
        revision,
        associationKey: assoc,
        projectIdentity,
        appId,
      });
      lastSnapshot = associationResult.developerRuntime || associationResult;
      revision = lastSnapshot.settingsRevision;
    }
    const name = fields.readValue("app-project-name").trim();
    return api.updateProject({
      revision,
      projectIdentity,
      ...(name ? { name } : {}),
      favorite: fields.readChecked("app-project-favorite"),
      hidden: fields.readChecked("app-project-hidden"),
      appId,
      appName: fields.readValue("app-name"),
      appFavorite: fields.readChecked("app-favorite"),
      appHidden: fields.readChecked("app-hidden"),
      originPreference: fields.readValue("app-origin"),
      health: fields.readHealth(),
      match: fields.readMatch(),
    });
  });
});
refs.appRemoveAssociation.addEventListener("click", async () => {
  const associationKey = fields.readValue("app-association");
  if (!associationKey) return;
  await mutateDialog(refs.appDialog, "app-error", () =>
    api.updateAssociation({
      revision: lastSnapshot.settingsRevision,
      associationKey,
      remove: true,
    }),
  );
});
refs.aliasForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await mutateDialog(refs.aliasDialog, "alias-error", () =>
    api.updateAlias({
      revision: lastSnapshot.settingsRevision,
      from: fields.readValue("alias-from"),
      to: fields.readValue("alias-to"),
      confirmed: fields.readChecked("alias-confirmed"),
    }),
  );
});
refs.composeRepoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await mutateDialog(refs.composeRepoDialog, "compose-repo-error", () =>
    api.updateComposeProject({
      revision: lastSnapshot.settingsRevision,
      composeProject: fields.readValue("compose-repo-project"),
      repoPath: fields.readValue("compose-repo-path"),
    }),
  );
});
for (const close of document.querySelectorAll("[data-close]")) {
  close.addEventListener("click", () => close.closest("dialog").close());
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearInterval(pollTimer);
  else {
    // Returning to the tab forces a FULL rebuild, not the quiet reconcile: the card DOM may be
    // minutes stale (the poll was paused while hidden, and an entrypoint URL / health state that
    // changed in the meantime renders only on a rebuild). A user refocusing the tab expects
    // current reality, the same contract a force refresh already follows.
    load({ force: true });
    pollTimer = setInterval(load, 10000);
  }
});

async function mutateDialog(dialog, errorId, mutate) {
  fields.setText(errorId, "");
  try {
    const result = await mutate();
    applySnapshot(result.developerRuntime || result);
    dialog.close();
  } catch (err) {
    fields.setText(errorId, err.message);
  }
}

function toggleActionMenu(card) {
  const menu = card.querySelector("[data-menu]");
  const trigger = card.querySelector("[data-action=menu]");
  const willOpen = menu.hidden;
  closeActionMenus();
  menu.hidden = !willOpen;
  trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
  // Lifts this card above the ones after it for as long as the menu is open. Cards are opaque
  // siblings painted in DOM order, so without this the next card covers the panel however high its
  // own z-index is — the panel cannot escape its card's stacking context. Applied to the nearest
  // card so a menu on a nested member card raises the member, and the outer repository card is
  // raised too when the menu belongs to it.
  if (willOpen) menu.closest(".instance-card")?.classList.add("has-open-menu");
}

function closeActionMenus() {
  for (const menu of refs.content.querySelectorAll("[data-menu]")) {
    menu.hidden = true;
    const card = menu.closest(".instance-card");
    card?.querySelector("[data-action=menu]")?.setAttribute("aria-expanded", "false");
    card?.classList.remove("has-open-menu");
  }
  // Cleared everywhere rather than only on cards that still hold a [data-menu]: a card can be
  // rebuilt by a poll while its menu is open, and a stale raised card would keep covering its
  // neighbours with nothing visible to explain why.
  for (const raised of refs.content.querySelectorAll(".has-open-menu")) {
    raised.classList.remove("has-open-menu");
  }
}

async function hideInstance(project, instance) {
  const projectIdentity = project.identity || instance.project?.identity;
  const appId = instance.app?.id || "web";
  try {
    let revision = lastSnapshot.settingsRevision;
    if (instance.associationKey && !instance.app?.id) {
      const associationResult = await api.updateAssociation({
        revision,
        associationKey: instance.associationKey,
        projectIdentity,
        appId,
      });
      lastSnapshot = associationResult.developerRuntime || associationResult;
      revision = lastSnapshot.settingsRevision;
    }
    const result = await api.updateProject({
      revision,
      projectIdentity,
      appId,
      appHidden: true,
    });
    applySnapshot(result.developerRuntime || result);
  } catch (err) {
    showError(err.message);
  }
}

function renderSettingsDialog() {
  refs.settingsBody.replaceChildren(
    // Two hidden lists, deliberately separate. "Hidden" holds projects and apps the user hid by
    // hand, in Runtime's settings. "Hidden repositories" holds whole repositories the 30-day
    // ageing sweep retired from the list — a different store, a different actor, and a different
    // thing to restore, so merging them would misreport who hid what.
    tmpl.settingsSection("Hidden", hiddenRows()),
    tmpl.settingsSection("Hidden repositories", hiddenRepositoryRows()),
    tmpl.settingsSection("Associations", associationRows()),
    tmpl.settingsSection("Aliases", aliasRows()),
  );
}

function hiddenRepositoryRows() {
  return (lastSnapshot.hiddenRepositories || []).map((item) =>
    tmpl.settingsRow(
      item.name,
      // Records are never deleted, so a repository is here because it went 30 days unseen — saying
      // when makes that legible rather than leaving the user to guess why it left the list.
      item.lastSeenAt ? `last seen ${new Date(item.lastSeenAt).toLocaleDateString()}` : item.repositoryId,
      "Show",
      () => restoreHiddenRepository(item),
    ),
  );
}

// Registry-wide, like Home's Ignore: the repository leaves Home, Plans, and this page's normal list
// until it is restored from Settings or the Manage repositories dialog.
async function ignoreRepository(repository) {
  try {
    const result = await api.setRepositoryVisibility({ repositoryId: repository.repositoryId, hidden: true });
    if (result.developerRuntime) applySnapshot(result.developerRuntime);
  } catch (err) {
    showError(err.message);
  }
}

async function restoreHiddenRepository(item) {
  try {
    const result = await api.setRepositoryVisibility({ repositoryId: item.repositoryId, hidden: false });
    if (result.developerRuntime) applySnapshot(result.developerRuntime);
    // The restore kicks a refresh server-side rather than rebuilding from cached discovery (the
    // persisted-repository list is only assembled on the refresh path), so the repository appears on
    // the next snapshot rather than in this response.
    renderSettingsDialog();
  } catch (err) {
    showError(err.message);
  }
}

function hiddenRows() {
  return (lastSnapshot.settings?.hidden || []).map((item) =>
    tmpl.settingsRow(
      item.kind === "project" ? item.name : `${item.name} / ${item.app.name}`,
      item.kind === "project"
        ? item.identity
        : `${item.identity}#${item.app.id}`,
      "Restore",
      () => restoreHidden(item),
    ),
  );
}

function associationRows() {
  return (lastSnapshot.settings?.associations || []).map((item) =>
    tmpl.settingsRow(
      item.key,
      `${item.projectIdentity}#${item.appId}`,
      "Remove",
      () => removeAssociation(item.key),
    ),
  );
}

function aliasRows() {
  return (lastSnapshot.settings?.aliases || []).map((item) =>
    tmpl.settingsRow(item.from, item.to, "Remove", () =>
      removeAlias(item.from),
    ),
  );
}

async function restoreHidden(item) {
  await mutateSettings(() =>
    api.updateProject({
      revision: lastSnapshot.settingsRevision,
      projectIdentity: item.identity,
      ...(item.kind === "project"
        ? { hidden: false }
        : { appId: item.app.id, appHidden: false }),
    }),
  );
}

async function removeAssociation(associationKey) {
  await mutateSettings(() =>
    api.updateAssociation({
      revision: lastSnapshot.settingsRevision,
      associationKey,
      remove: true,
    }),
  );
}

async function removeAlias(from) {
  await mutateSettings(() =>
    api.updateAlias({
      revision: lastSnapshot.settingsRevision,
      from,
      remove: true,
    }),
  );
}

async function mutateSettings(mutate) {
  try {
    const result = await mutate();
    applySnapshot(result.developerRuntime || result);
    renderSettingsDialog();
  } catch (err) {
    showError(err.message);
  }
}

function renderLinkRows(links) {
  refs.linkList.replaceChildren();
  for (const link of links) addLinkRow(link);
  if (!links.length) refs.linkList.append(tmpl.linkEmpty());
}

function addLinkRow(link) {
  refs.linkList.querySelector("[data-empty]")?.remove();
  const row = tmpl.linkRow(link);
  row.querySelector("[data-action=remove]").addEventListener("click", () => {
    row.remove();
    if (!refs.linkList.querySelector(".link-row"))
      refs.linkList.append(tmpl.linkEmpty());
  });
  row
    .querySelector("[data-action=up]")
    .addEventListener("click", () => moveLinkRow(row, -1));
  row
    .querySelector("[data-action=down]")
    .addEventListener("click", () => moveLinkRow(row, 1));
  refs.linkList.append(row);
  return row;
}

function moveLinkRow(row, direction) {
  const sibling =
    direction < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling || sibling.hasAttribute("data-empty")) return;
  if (direction < 0) refs.linkList.insertBefore(row, sibling);
  else refs.linkList.insertBefore(sibling, row);
}

function serializeLinkRows() {
  return [...refs.linkList.querySelectorAll(".link-row")].map((row) => {
    const id = row.querySelector("[data-field=id]").value;
    return {
      ...(id ? { id } : {}),
      label: row.querySelector("[data-field=label]").value,
      path: row.querySelector("[data-field=path]").value,
    };
  });
}

function showError(message) {
  refs.warnings.hidden = false;
  refs.warnings.replaceChildren(tmpl.notice(message));
}

load();
pollTimer = setInterval(load, 10000);
