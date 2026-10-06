import { createHash } from "node:crypto";
import path from "node:path";
import { defaultSettings, resolveProjectAlias } from "./settings.mjs";
import { classifyMemberRole, createRoleComparator } from "./member-role.mjs";
import { canonicalRepositoryId, providerUrlForRepositoryId } from "../repositories/identity.mjs";

export function buildDeveloperRuntimeSnapshot({
  discovery,
  settings = defaultSettings(),
  now = new Date(),
  refresh = { state: "idle", startedAt: null, error: null },
  // repositoryId -> canonical display name, from the repository registry. Injected rather than read
  // here so this stays a pure builder (the caller owns state access, as it already does for
  // settings). Empty is fine: naming falls back to whatever the running checkouts report.
  repositoryNames = new Map(),
  // repositoryId -> stable browser key for the repository detail page. Injected alongside names
  // so the runtime card can make the repository title the same detail link Home uses.
  repositoryUrlKeys = new Map(),
  // Repositories the registry knows that have nothing running right now, already carrying their
  // lifecycle state and (for present checkouts) git context. Injected for the same reason as
  // repositoryNames: reading the registry and shelling out to git are the caller's job, so this
  // stays a pure function of its inputs. Empty means "no persistence available", which degrades to
  // the pre-Phase-3 behaviour of listing only what is running.
  persistedRepositories = [],
  // repositoryId -> { rootId, projectRoot, git, state } for the main checkout of a RUNNING repository
  // that has nothing running in it. Found and read by the caller for the same reason as
  // persistedRepositories; it fills the main row, which would otherwise render blank.
  idleMainCheckouts = new Map(),
  // Repositories the 30-day ageing sweep has hidden. Name and last-seen only — enough for the
  // "Show hidden" affordance to offer them back, without deriving lifecycle or reading git for
  // repositories that are by construction not on the page.
  hiddenRepositories = [],
  // Ids of repositories the user has pinned, from the repository registry. Injected for the same
  // reason as repositoryNames: the registry is the caller's to read. A Set rather than a flag on
  // each record because it is consulted once per repository, including for ones that arrived on the
  // running path and therefore have no persisted record to carry it.
  pinnedRepositoryIds = new Set(),
} = {}) {
  const activeByProject = new Map();
  const unmatchedInstances = [];
  const composeProjectsByName = new Map();
  const seenApps = new Set();
  let hiddenCount = 0;
  const shapeGroups = groupByIdentityShape(discovery.instances || []);

  for (const instance of discovery.instances || []) {
    // A Compose-labeled instance has its own resolvable identity — the project that spawned the
    // container — independent of whether lsof/git could resolve a filesystem identity for the
    // host-side listener process. Grouping here first means a Postgres/Traefik/proxy container with
    // low-confidence process identity (the common case: Docker Desktop's `com.docker.backend` fronts
    // every published port) still lands under its real project instead of "Unrecognized listeners".
    if (instance.docker?.composeProject) {
      const projectName = instance.docker.composeProject;
      if (!composeProjectsByName.has(projectName)) {
        const projectSettings = settings.composeProjects?.[projectName] || {};
        const gitInfo = discovery.composeProjectGit?.get(projectName) || null;
        composeProjectsByName.set(projectName, {
          identity: `compose:${projectName}`,
          name: projectSettings.name || projectName,
          favorite: projectSettings.favorite === true,
          hidden: projectSettings.hidden === true,
          repoPath: projectSettings.repoPath || null,
          git: gitInfo?.git || null,
          repositoryId: gitInfo?.repositoryId || null,
          // Which checkout this stack's files actually live in, decided by its bind mounts rather
          // than by where `docker compose up` was typed (classifyComposeOwnership in discovery.mjs).
          // Null for a shared or unverified stack, which routes it to repository level instead of
          // into one checkout's section.
          rootId: gitInfo?.rootId || null,
          // "owned" (mounts land in exactly one checkout), "shared" (they span several, or resolve
          // to the repository root), or "unverified" (no bind mounts at all). shared and unverified
          // render in the same place but are not the same claim — one is a positive finding, the
          // other an absence of evidence — so the evidence kind travels alongside.
          ownership: gitInfo?.ownership || null,
          ownershipEvidence: gitInfo?.ownershipEvidence || null,
          // "manual" when settings.composeProjects[name].repoPath was set and used, "auto" when
          // resolveIdentity instead ran against the working_dir label from `docker ps`, null when
          // neither resolved (e.g. a compose project with no git repo at all).
          resolvedFrom: gitInfo?.resolvedFrom || null,
          providerUrl: gitInfo?.repositoryId ? providerUrlForRepositoryId(gitInfo.repositoryId) : null,
          instances: [],
        });
      }
      const project = composeProjectsByName.get(projectName);
      if (project.hidden) {
        hiddenCount += 1;
        continue;
      }
      // Classified here rather than in toMember: a container never becomes a member (its stack is
      // the member), yet one of its ports can still be the checkout's promoted link.
      project.instances.push(withOpaqueKey({ ...instance, role: classifyMemberRole(instance) }, `compose:${projectName}`, null));
      continue;
    }
    const projectIdentity = resolveProjectAlias(settings, instance.project.identity);
    const association = settings.associations[instance.associationKey];
    // A single distinct "shape" (same title + cwd) under this identity is treated as one app slot
    // even if it has multiple listeners — those extra listeners are near-certainly redundant
    // processes (e.g. two different static-file-server tools pointed at the same directory), not
    // separate services. Two or more genuinely different shapes under one identity still can't be
    // auto-assigned, since there's no reliable way to guess which one is "the" app.
    const shapeKey = instanceShapeKey(instance);
    const group = shapeGroups.get(instance.project.identity);
    const provisionalApp = group?.shapes.size === 1 && (instance.project.confidence === "high" || instance.project.confidence === "medium");
    const appId = association?.appId || (provisionalApp ? "web" : null);
    if (!appId) {
      unmatchedInstances.push(withOpaqueKey(instance, projectIdentity, null));
      continue;
    }
    const effectiveIdentity = resolveProjectAlias(settings, association?.projectIdentity || projectIdentity);
    const projectSettings = settings.projects[effectiveIdentity] || { apps: {} };
    const appSettings = projectSettings.apps?.[appId] || {};
    if (projectSettings.hidden || appSettings.hidden) {
      hiddenCount += 1;
      seenApps.add(`${effectiveIdentity}#${appId}`);
      continue;
    }
    const duplicates = group?.byShape.get(shapeKey) || [];
    // Only the first same-shape instance we encounter becomes the visible card; later duplicates
    // stay out of the rendered list but still contribute their port to duplicatePorts below.
    if (duplicates[0] !== instance) continue;
    const project = ensureProject(activeByProject, effectiveIdentity, projectSettings, instance);
    project.instances.push(withOpaqueKey({
      ...instance,
      duplicatePorts: duplicates.length > 1 ? duplicates.map((dup) => dup.bind.port) : [],
      app: {
        id: appId,
        name: appSettings.name || labelFromId(appId),
        favorite: appSettings.favorite === true,
        hidden: appSettings.hidden === true,
        links: (appSettings.links || []).map((link) => ({ ...link, url: instance.origin ? `${instance.origin}${link.path}` : link.path })),
        originPreference: appSettings.originPreference || "localhost",
        health: appSettings.health || {},
        match: appSettings.match || {},
      },
    }, effectiveIdentity, appId));
    seenApps.add(`${effectiveIdentity}#${appId}`);
  }

  const inactiveProjects = [];
  for (const [identity, project] of Object.entries(settings.projects || {})) {
    if (project.hidden) {
      hiddenCount += Object.keys(project.apps || {}).length;
      continue;
    }
    for (const [appId, app] of Object.entries(project.apps || {})) {
      if (seenApps.has(`${identity}#${appId}`)) continue;
      if (app.hidden) {
        hiddenCount += 1;
        continue;
      }
      inactiveProjects.push({
        identity,
        // Which repository this saved slot belongs to, when its identity resolves to one. Phase 3
        // renders repositories from the registry instead, so a slot that HAS a repository is
        // already represented by that repository's card and must not also appear as a loose saved
        // app; only the never-resolved ones are still listed on their own.
        repositoryId: canonicalRepositoryId(savedIdentityFor(identity)),
        name: project.name || inferredName(identity),
        favorite: project.favorite === true || app.favorite === true,
        hidden: false,
        app: {
          id: appId,
          name: app.name || labelFromId(appId),
          favorite: app.favorite === true,
          hidden: false,
          links: app.links || [],
          originPreference: app.originPreference || "localhost",
          health: app.health || {},
          match: app.match || {},
        },
      });
    }
  }

  const projects = [...activeByProject.values()].sort(compareProjects).map(sortProject);
  const composeProjects = [...composeProjectsByName.values()]
    .map((project) => ({ ...project, containers: groupByContainer(project.instances) }))
    .sort(compareProjects);

  return {
    generatedAt: toIso(now),
    refresh,
    settingsRevision: settings.revision,
    capabilities: discovery.capabilities,
    warnings: discovery.warnings || [],
    projects,
    composeProjects,
    unmatchedInstances: unmatchedInstances.sort(compareInstances),
    // Repository-keyed view over the same instances the three collections above hold. Built
    // alongside them during the migration (developer-runtime-repository-card-merge) so existing consumers
    // keep working while the portal moves over; the legacy three are removed once nothing reads them.
    repositories: buildRepositories({ projects, composeProjects, unmatchedInstances, repositoryNames, repositoryUrlKeys, persistedRepositories, idleMainCheckouts, pinnedRepositoryIds }),
    inactiveProjects: inactiveProjects.sort(compareProjects),
    hiddenRepositories,
    hiddenCount,
    settings: settingsSummary(settings),
  };
}

export function findCurrentInstanceByOpaqueKey(snapshot, opaqueKey) {
  if (!opaqueKey) return null;
  for (const instance of [
    ...(snapshot?.projects || []).flatMap((project) => project.instances || []),
    ...(snapshot?.composeProjects || []).flatMap((project) => project.containers.flatMap((c) => c.instances)),
    ...(snapshot?.unmatchedInstances || []),
  ]) {
    if (instance.opaqueKey === opaqueKey) return instance;
  }
  return null;
}

// One row per container, not one per published port — a single Traefik/Postgres container that
// publishes several host ports (e.g. 80/443/8080 on one proxy) is one operational unit, and
// showing it as three identical-looking rows misrepresents it as three containers.
function groupByContainer(instances) {
  const byContainer = new Map();
  for (const instance of instances) {
    const containerId = instance.docker.containerId;
    if (!byContainer.has(containerId)) {
      byContainer.set(containerId, {
        containerId,
        name: instance.docker.composeService || instance.docker.name,
        image: instance.docker.image,
        state: instance.docker.state,
        instances: [],
      });
    }
    byContainer.get(containerId).instances.push(instance);
  }
  return [...byContainer.values()]
    .map((container) => ({ ...container, instances: container.instances.sort(compareInstances) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// One card per repository, merging what the three legacy collections split by discovery mechanism.
// A repository that runs a Compose stack, a dev server, and a tunnel previously produced three
// unrelated cards in three sections; they share a repositoryId and belong together.
//
// Only a real repositoryId groups. `process:` identities resolve to null (canonicalRepositoryId
// returns null for them — no repository exists to be a member of) and stay unmatched, as do
// Compose projects whose repo never resolved.
function buildRepositories({ projects, composeProjects, unmatchedInstances, repositoryNames = new Map(), repositoryUrlKeys = new Map(), persistedRepositories = [], idleMainCheckouts = new Map(), pinnedRepositoryIds = new Set() }) {
  const byRepository = new Map();

  // A worktree's project-level `name` is commonly its branch or directory name (e.g.
  // "developer-runtime-metadata-suggestions"), not the repository's real name — only the main (non-
  // worktree) checkout's name is canonical. Tracks name candidates per repository, tagged by
  // whether they came from a worktree, so the repository-level name can prefer a main-checkout
  // name and only fall back to a worktree's when no main checkout is present at all.
  const nameCandidates = new Map();
  const noteName = (repositoryId, name, isWorktree) => {
    if (!name) return;
    if (!nameCandidates.has(repositoryId)) nameCandidates.set(repositoryId, []);
    nameCandidates.get(repositoryId).push({ name, isWorktree });
  };

  const ensure = (repositoryId, source) => {
    if (!byRepository.has(repositoryId)) {
      byRepository.set(repositoryId, {
        repositoryId,
        urlKey: repositoryUrlKeys.get(repositoryId) || null,
        // git: ids are portable across machines and promotable to other pages; local: ids are
        // stable but path-derived, so they stay on this surface only.
        identityKind: repositoryId.startsWith("git:") ? "git" : "local",
        providerUrl: providerUrlForRepositoryId(repositoryId),
        // A dev fixture (local/dev-fixtures) rather than a real project — badged "mock" and listed
        // after every real active repository.
        fixture: isFixtureRepository(repositoryId),
        name: source.name,
        // Read from the repository registry (see pinnedRepositoryIds below), never from the members
        // — a pin has to survive the process exiting, and an idle repository has no members to hold
        // it. Defaults false here and is set once the registry has been consulted.
        pinned: false,
        // `active` by construction here: every entry created on the running path was created because
        // something was discovered for it. The persisted-repository pass overwrites this with the
        // registry-derived state for repositories that have nothing running.
        lifecycle: { state: "active", reason: null },
        lastSeenAt: null,
        composeGroups: [],
        // Compose stacks that belong to the repository but to no single checkout of it — mounts
        // spanning several checkouts, mounts resolving to none, or no bind mounts to judge by.
        // Rendered once at repository level (see the Shared Services region in repositoryCard)
        // rather than inside a checkout that does not own them.
        sharedComposeGroups: [],
        // Flat union of every root's members, kept for consumers that only ever needed "every
        // member of this repository" and don't care which checkout it runs from (favorite/hide
        // fan-out, departed-member tracking). `roots` below is the grouped view the card renders.
        members: [],
        // One entry per checkout (main + every worktree) this repository has an active member or
        // git identity for. When only worktrees are running, the main checkout is added as an idle
        // root from idleMainCheckouts; it is still absent when the caller could not find or read it,
        // and the portal then renders its section empty rather than this array being padded with a
        // placeholder.
        roots: [],
      });
    }
    return byRepository.get(repositoryId);
  };

  // rootId is per-checkout even though repositoryId is shared across a repo's worktrees — this is
  // what lets a worktree's branch stay scoped to its own section instead of leaking onto the
  // repository-level badge (see the plan doc's "Worktree/Root Hierarchy" section).
  const ensureRoot = (entry, rootId, git, projectRoot) => {
    let root = entry.roots.find((candidate) => candidate.rootId === rootId);
    if (!root) {
      // primaryEntrypoint is filled once members are ranked (see the per-root loop below); null means
      // nothing user-facing runs here, which is also the only value an idle checkout ever has.
      root = { rootId, isWorktree: Boolean(git?.isWorktree), git: git || null, projectRoot: projectRoot || null, members: [], composeGroups: [], primaryEntrypoint: null };
      entry.roots.push(root);
    } else {
      if (!root.git && git) root.git = git;
      if (!root.projectRoot && projectRoot) root.projectRoot = projectRoot;
    }
    return root;
  };

  for (const project of projects) {
    if (!project.repositoryId) continue;
    const entry = ensure(project.repositoryId, project);
    const rootId = project.rootId || `unresolved:${project.repositoryId}`;
    const root = ensureRoot(entry, rootId, project.git, project.projectRoot);
    noteName(project.repositoryId, project.name, root.isWorktree);
    for (const instance of project.instances) {
      const member = toMember(instance, project.identity);
      entry.members.push(member);
      root.members.push(member);
    }
  }

  for (const composeProject of composeProjects) {
    if (!composeProject.repositoryId) continue;
    const entry = ensure(composeProject.repositoryId, composeProject);
    // A Compose stack is one deploy unit — `docker compose down` stops every container at once —
    // so it stays a named sub-group rather than flattening 11 Supabase containers into the member
    // list ahead of the single dev server the user actually cares about.
    // Carries the whole compose-project record (plus its own aggregate) so the portal renders the
    // sub-group with the same card it used when this was a top-level entry.
    const group = { ...composeProject, cpuPercentOfHost: sumCpuPercentOfHost(composeProject.instances) };
    entry.composeGroups.push(group);
    // Routes into the same checkout its containers actually run from (see the rootId comment above)
    // when the mount evidence says exactly one checkout owns it.
    //
    // Anything else goes to the repository level instead of falling back to the main checkout. That
    // fallback asserted something the evidence contradicts: a stack whose mounts land in two
    // checkouts (`shared`), or in none of them (`repo-root`), or that has no bind mounts to read at
    // all (`unverified`), is not the main checkout's — placing it there tells the user a worktree
    // owns infrastructure that in fact backs several, and hides the sharing that is the whole point
    // of classifying. Phase 4 sets rootId only for `owned`, so a null rootId here is the verdict,
    // not missing data.
    if (!composeProject.rootId) {
      entry.sharedComposeGroups.push(group);
      continue;
    }
    const root = ensureRoot(entry, composeProject.rootId, composeProject.git, composeProject.projectRoot);
    root.composeGroups.push(group);
  }

  for (const instance of unmatchedInstances) {
    const repositoryId = instance.project?.repositoryId;
    if (!repositoryId) continue;
    const name = inferredName(instance.project.identity, instance.project.projectRoot);
    const entry = ensure(repositoryId, { name });
    const rootId = instance.project.rootId || `unresolved:${repositoryId}`;
    const root = ensureRoot(entry, rootId, instance.project.git, instance.project.projectRoot);
    noteName(repositoryId, name, root.isWorktree);
    const member = toMember(instance, instance.project.identity);
    entry.members.push(member);
    root.members.push(member);
  }

  // The main checkout of a running repository, when only its worktrees are running. Same idle-row
  // shape as a persisted checkout (git, path, no members), so the always-rendered main row shows its
  // branch instead of an empty glyph. Only ever the main checkout, and only when no running member
  // already supplied one — other stopped worktrees stay off the card.
  for (const [repositoryId, checkout] of idleMainCheckouts) {
    const entry = byRepository.get(repositoryId);
    if (!entry || !checkout?.rootId || entry.roots.some((root) => !root.isWorktree)) continue;
    const root = ensureRoot(entry, checkout.rootId, checkout.git, checkout.projectRoot);
    root.checkoutState = checkout.state || "present";
    root.checkoutReason = null;
  }

  for (const entry of byRepository.values()) {
    // A main-checkout name is canonical (a worktree's name is commonly its branch/dir name, not the
    // repository's real name); only fall back to a worktree's name when no main-checkout name was
    // ever seen — e.g. only a worktree is currently running.
    //
    // The registry's name outranks both. It is the repository-level fact, recorded when the
    // repository was first resolved and independent of which checkouts happen to be running now —
    // which is exactly the case the candidate list cannot cover: when only a worktree is up there is
    // no main-checkout candidate to prefer, and the card would otherwise be titled with the
    // worktree's branch/directory name (e.g. "developer-runtime-metadata-suggestions" for roborepo).
    //
    // Resolved before any sorting: the member ranking prefers a page whose title names the
    // repository, so it needs the final name, not whichever candidate happened to arrive first.
    const candidates = nameCandidates.get(entry.repositoryId) || [];
    const registryName = repositoryNames.get(entry.repositoryId);
    const mainName = candidates.find((c) => !c.isWorktree)?.name;
    if (registryName) entry.name = registryName;
    else if (mainName) entry.name = mainName;
    else if (candidates.length) entry.name = candidates[0].name;
    const compareMembers = createRoleComparator({ repositoryName: entry.name });
    entry.members = collapseByPid(entry.members);
    entry.members.sort(compareMembers);
    // Duplicate-listener detection runs per checkout, not repository-wide: a repository legitimately
    // runs the same app shape on two different ports when it is open in two worktrees at once (each
    // an independent, intentional checkout) — that is not the stale-leftover-process case this warns
    // about, which is two processes serving the same shape from the SAME checkout.
    entry.duplicateGroups = [];
    for (const root of entry.roots) {
      root.members = collapseByPid(root.members);
      entry.duplicateGroups.push(...findStaleDuplicates(root.members));
      root.members.sort(compareMembers);
      root.composeGroups.sort((a, b) => a.name.localeCompare(b.name));
      root.primaryEntrypoint = primaryEntrypointFor(root, compareMembers);
    }
    // Main checkout first (even if empty — the portal always renders its section), then worktrees
    // alphabetically by branch so the order is stable across polls.
    entry.roots.sort((a, b) => {
      if (a.isWorktree !== b.isWorktree) return a.isWorktree ? 1 : -1;
      return (a.git?.branch || "").localeCompare(b.git?.branch || "");
    });
    entry.composeGroups.sort((a, b) => a.name.localeCompare(b.name));
    entry.sharedComposeGroups.sort((a, b) => a.name.localeCompare(b.name));
    // Every member counts toward the aggregate today. Tool processes that resolve to a repository
    // only by inherited working directory (a tunnel, a stray `npx`) arguably should not — their CPU
    // tracks their own traffic, not application load — but no field currently separates them from a
    // real dev server: on live data ngrok and a Next.js server agree on probe status, title,
    // identity, confidence, and relative cwd, differing only in process command name. Excluding them
    // needs a real signal rather than a name list; see the plan doc's open questions.
    entry.cpuPercentOfHost = sumValues([
      ...entry.composeGroups.map((group) => group.cpuPercentOfHost),
      ...entry.members.map((member) => member.cpuPercentOfHost),
    ]);
  }

  // Everything above came from something running. These come from the registry instead, so the list
  // stops being "what is up right now" and becomes "every repository, with its state" — which is what
  // retires the separate inactive section.
  //
  // Guarded against double-listing: the caller already excludes running repositories, but a stack
  // resolved on this scan can land in the registry a moment before the snapshot is built, and a
  // repository appearing twice is far worse than one appearing a poll late.
  for (const persisted of persistedRepositories) {
    if (!persisted?.repositoryId || byRepository.has(persisted.repositoryId)) continue;
    const entry = ensure(persisted.repositoryId, { name: persisted.name || labelFromRepositoryId(persisted.repositoryId) });
    entry.lifecycle = persisted.lifecycle || { state: "idle", reason: null };
    entry.lastSeenAt = persisted.lastSeenAt || null;
    // Same root shape the running path builds, so the card renders one kind of section either way.
    // members stays empty by construction: an idle repository has no instances, and that absence is
    // the entire difference between the two states.
    for (const checkout of persisted.checkouts || []) {
      if (!checkout?.rootId) continue;
      const root = ensureRoot(entry, checkout.rootId, checkout.git, checkout.projectRoot);
      // A checkout that is gone has no git to say it was a worktree; the registry recorded which
      // kind it was when Runtime saw it, so a missing worktree still renders and sorts as one.
      if (checkout.kind === "worktree") root.isWorktree = true;
      root.checkoutState = checkout.state;
      root.checkoutReason = checkout.reason || null;
    }
    entry.roots.sort((a, b) => {
      if (a.isWorktree !== b.isWorktree) return a.isWorktree ? 1 : -1;
      return (a.git?.branch || "").localeCompare(b.git?.branch || "");
    });
    entry.duplicateGroups = [];
    entry.cpuPercentOfHost = null;
  }

  // Applied to every entry at once, after both the running and persisted passes, because a pin is a
  // property of the repository rather than of how this scan happened to find it — resolving it in
  // one place is what makes an idle repository pinnable at all.
  for (const [repositoryId, entry] of byRepository) {
    entry.pinned = pinnedRepositoryIds.has(repositoryId);
  }

  return sortRepositoriesForDisplay([...byRepository.values()]);
}

// Three groups (see displayGroup): running real repositories, then dev fixtures, then idle/stale —
// a card with something live on it outranks one without, whatever their names. Within each group
// compareRepositories applies, so pins and alphabetical order still hold where they did before.
//
// Exported because the pin mutation re-sorts an existing snapshot in place rather than rebuilding
// it (see setDeveloperRuntimeRepositoryPinned): pinning changes the order, and the order must be derived
// the same way in both paths or the list would reshuffle on the next poll.
export function sortRepositoriesForDisplay(repositories) {
  return [...repositories].sort((a, b) => displayGroup(a) - displayGroup(b) || compareRepositories(a, b));
}

// Real repositories with something running, then dev fixtures whether running or not, then idle and
// stale repositories. Fixtures sit between the two so a running fixture never pushes real work down
// the page, yet stays above the history that is no longer running at all.
function displayGroup(repository) {
  if (repository.fixture) return 1;
  return repository.lifecycle && repository.lifecycle.state !== "active" ? 2 : 0;
}

// The dev fixtures give their repositories deliberately unfetchable github.com/example remotes and
// a `-fixture` repository suffix (see local/dev-fixtures). The suffix matters: the development
// checkout itself also uses an example.com remote in tests and must remain a real repository.
const FIXTURE_REPOSITORY_PATTERN = /^git:github\.com\/example\/.+-fixture$/;

export function isFixtureRepository(repositoryId) {
  return typeof repositoryId === "string" && FIXTURE_REPOSITORY_PATTERN.test(repositoryId);
}

// Last path segment of a git: id, or a generic label for a local: one. Only used when the registry
// has no displayName recorded — a repository registered by a source that never resolved a name.
function labelFromRepositoryId(repositoryId) {
  if (repositoryId.startsWith("git:")) return repositoryId.split("/").pop() || repositoryId;
  return "repository";
}

// One process listening on several ports is one member, not several. A dev server commonly binds a
// main port plus an HMR/websocket port; rendering those as sibling members overstated what was
// running (localhostr_web showed three "members" that were two processes). PID is exact here — no
// heuristic needed — so the extra ports become metadata on the surviving member.
//
// The survivor is the port that answered with a page title: that is the one a user opens, and the
// untitled siblings are the infrastructure ports behind it.
function collapseByPid(members) {
  const byPid = new Map();
  const collapsed = [];
  for (const member of members) {
    // Containers are already one row per container upstream, and Docker's published ports do not
    // share a host PID the way a dev server's do.
    const pid = member.kind === "listener" ? member.instance?.process?.pid : null;
    if (pid == null) {
      collapsed.push(member);
      continue;
    }
    if (!byPid.has(pid)) {
      // slot is where this pid's visible member sits in `collapsed`, so a later winner can replace
      // it by index instead of scanning for it.
      byPid.set(pid, { primary: member, siblings: [], slot: collapsed.length });
      collapsed.push(member);
      continue;
    }
    const group = byPid.get(pid);
    // Prefer a titled port as the visible member; otherwise keep the lowest-numbered one, which is
    // conventionally the primary bind.
    const incomingWins = isEntrypoint(member) && !isEntrypoint(group.primary);
    const loser = incomingWins ? group.primary : member;
    if (incomingWins) {
      collapsed[group.slot] = member;
      group.primary = member;
    }
    group.siblings.push(loser);
  }
  for (const { primary, siblings } of byPid.values()) {
    if (!siblings.length) continue;
    // Non-interactive: these are facts about the process, not things to click.
    primary.secondaryPorts = siblings
      .map((sibling) => sibling.port)
      .sort((a, b) => a - b);
  }
  return collapsed;
}

// A port that answered the HTTP probe with a page title is user-facing; an untitled one is an API,
// a socket, or a service another process talks to. This is what separates menugoats' web app from
// its Supabase containers without naming either.
function isEntrypoint(member) {
  return Boolean(member.instance?.title);
}

// Stale duplicates are already detected upstream: same-shape instances under one identity are
// collapsed to a single visible card and their ports recorded on `duplicatePorts` (see the
// duplicate handling around the shape-group pass). This surfaces that existing signal at repository
// level so the merged card can warn once, rather than re-deriving it.
//
// Note this is a different condition from collapseByPid: that folds ONE process holding several
// ports (normal — a dev server plus its HMR socket), while this reports SEVERAL processes serving
// the same thing (a leftover you probably want to kill).
function findStaleDuplicates(members) {
  const groups = [];
  for (const member of members) {
    const ports = member.instance?.duplicatePorts || [];
    if (ports.length > 1) {
      groups.push({ name: member.name, ports: [...ports].sort((a, b) => a - b) });
    }
  }
  return groups;
}

function toMember(instance, projectIdentity) {
  return {
    kind: instance.docker ? "container" : "listener",
    projectIdentity,
    // Which checkout this member belongs to, so the portal can route a departed (process-gone)
    // member back into the same root section it came from instead of only the main one.
    rootId: instance.project?.rootId ?? null,
    // Whether this port is something a user opens (it answered with a page title) or infrastructure
    // behind one. Drives which members get a permanent, always-visible slot on the card.
    entrypoint: Boolean(instance.title),
    // What the member is for — app, tooling, api, or service (see member-role.mjs). Decides the
    // member order, which member a checkout row promotes, and which members render dimmed.
    role: classifyMemberRole(instance),
    // The page title in full. Prose about what the site is, which belongs in a tooltip rather than
    // as the member's name — see memberName.
    description: instance.title || null,
    // Other ports held by the same process, shown as metadata rather than as separate members.
    secondaryPorts: [],
    // The full instance record, so the portal can render a member with the same card it always
    // used — merging regroups instances, it does not change what an instance is.
    instance,
    opaqueKey: instance.opaqueKey,
    associationKey: instance.associationKey,
    name: memberName(instance),
    port: instance.bind.port,
    origin: instance.origin,
    status: instance.status,
    health: instance.health,
    docker: instance.docker,
    app: instance.app ?? null,
    // Percent of the whole machine, not of one core. `docker stats` reports CPU relative to a single
    // core, which is not summable across containers — cpuPercentOfHost is the normalized field, and
    // summing the raw per-core value produced meaningless totals (161% for one 11-container project).
    cpuPercentOfHost: instance.processMetrics?.cpuPercentOfHost ?? null,
    residentMemoryKb: instance.processMetrics?.residentMemoryKb ?? null,
  };
}

// A member's name should say what the process IS. A page <title> is written for site visitors, not
// for an operator — "localhostr — one config, every agentic coding harness" is a marketing tagline
// that identifies nothing on this page. So the title is demoted below the command name and only
// used when nothing else exists, and even then it is trimmed to its leading segment: site titles
// are conventionally "Name — tagline" or "Name | tagline", and only the leading part names anything.
//
// The full title survives as `description` for the tooltip, where prose belongs.
function memberName(instance) {
  return instance.app?.name
    || instance.docker?.composeService
    || instance.docker?.name
    || instance.process?.command
    || shortTitle(instance.title)
    || `Port ${instance.bind.port}`;
}

// Leading segment of a page title, before the first separator conventionally used to append a
// tagline. Returns null for an empty or missing title so callers fall through to their next source.
function shortTitle(title) {
  if (typeof title !== "string") return null;
  const lead = title.split(/\s+[—–|·:]\s+/)[0]?.trim();
  return lead || null;
}

function sumCpuPercentOfHost(instances) {
  return sumValues(instances.map((instance) => instance.processMetrics?.cpuPercentOfHost ?? null));
}

// Null when nothing reported a usable number, so an unmeasured card renders as "unknown" rather
// than claiming a confident 0%.
function sumValues(values) {
  const present = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!present.length) return null;
  return present.reduce((total, value) => total + value, 0);
}

// The one link a checkout row shows: its best-ranked `app`, whether that is a dev server member or a
// port of a Compose container in this checkout. Containers are candidates here even though they are
// never members, because a Compose-only checkout's `web` service is exactly the app a user opens.
// Null when nothing user-facing runs — the row then shows no link rather than promoting an API.
function primaryEntrypointFor(root, compareMembers) {
  const containerCandidates = root.composeGroups.flatMap((group) =>
    group.containers.flatMap((container) =>
      container.instances.map((instance) => ({ role: instance.role, instance, kind: "container" }))));
  const best = [
    ...root.members.map((member) => ({ role: member.role, instance: member.instance, kind: "listener" })),
    ...containerCandidates,
  ]
    .filter((candidate) => candidate.role === "app" && candidate.instance?.origin && candidate.instance.opaqueKey)
    .sort(compareMembers)[0];
  if (!best) return null;
  return {
    kind: best.kind,
    opaqueKey: best.instance.opaqueKey,
    origin: best.instance.origin,
    port: best.instance.bind.port,
    links: best.instance.app?.links || [],
  };
}

// Favorites first, then portable git-backed repositories ahead of path-derived local ones. Offline
// ordering within a group is unchanged — it still falls out of the member sort.
function compareRepositories(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  // Most recently started first, among repositories that have something running. elapsedSeconds is
  // time SINCE start, so smaller is newer. Only meaningful for active repositories — an idle one has
  // no process to have started — so it is compared only when both sides report one, and ties (or a
  // pair with no metrics at all) fall through to the existing name ordering rather than shuffling.
  const aStarted = startedRank(a);
  const bStarted = startedRank(b);
  if (aStarted !== bStarted) return aStarted - bStarted;
  if (a.identityKind !== b.identityKind) return a.identityKind === "git" ? -1 : 1;
  return a.name.localeCompare(b.name) || a.repositoryId.localeCompare(b.repositoryId);
}

// Smallest elapsed time across a repository's members — the most recently started thing in it, which
// is what "recently started" means for a card that can hold several processes. Infinity for a
// repository with no usable metric, so it sorts after every repository that has one without
// disturbing their relative order.
function startedRank(repository) {
  let best = Infinity;
  for (const member of repository.members || []) {
    const elapsed = member.instance?.processMetrics?.elapsedSeconds;
    if (typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed < best) best = elapsed;
  }
  return best;
}

// Groups instances by project identity, then by "shape" (same page title + same relative cwd)
// within that identity. Two instances with the same shape are treated as duplicate listeners for
// one app, not two different apps — see the auto-promotion comment above for why that matters.
function groupByIdentityShape(instances) {
  const groups = new Map();
  for (const instance of instances) {
    const identity = instance.project?.identity;
    if (!identity) continue;
    if (!groups.has(identity)) groups.set(identity, { shapes: new Set(), byShape: new Map() });
    const group = groups.get(identity);
    const shapeKey = instanceShapeKey(instance);
    group.shapes.add(shapeKey);
    if (!group.byShape.has(shapeKey)) group.byShape.set(shapeKey, []);
    group.byShape.get(shapeKey).push(instance);
  }
  return groups;
}

// No title means there's nothing reliable to compare, so an untitled instance never counts as a
// duplicate of anything else — each gets its own unique key instead of silently grouping under a
// shared blank title.
//
// rootId is part of the key because relativeCwd is root-relative, not root-identifying: a repo's
// top-level app reports relativeCwd "." from its main checkout AND from every worktree alike, so
// without rootId two genuinely different checkouts (each an intentional, separate running instance)
// collapsed into one "duplicate listener" shape group — the second one silently vanished as
// duplicatePorts metadata instead of becoming its own project/root.
function instanceShapeKey(instance) {
  if (!instance.title) return `untitled:${instance.key}`;
  return `${instance.title}::${instance.matchSignature?.relativeCwd ?? ""}::${instance.project?.rootId ?? ""}`;
}

function ensureProject(map, identity, settings, instance) {
  if (!map.has(identity)) {
    map.set(identity, {
      identity,
      name: settings.name || inferredName(identity, instance.project.projectRoot),
      favorite: settings.favorite === true,
      hidden: settings.hidden === true,
      identityKind: instance.project.identityKind,
      confidence: instance.project.confidence,
      evidence: instance.project.evidence,
      repositoryId: instance.project.repositoryId ?? null,
      providerUrl: instance.project.repositoryId ? providerUrlForRepositoryId(instance.project.repositoryId) : null,
      rootId: instance.project.rootId ?? null,
      // Carried for the same reason as rootId: it identifies WHICH checkout this is, and it is the
      // one fact that distinguishes two worktrees on the same branch. buildRepositories passes it to
      // ensureRoot, which is where the root row's "Copy worktree path" item reads it from — without
      // it every root reported projectRoot: null and that item could never appear.
      projectRoot: instance.project.projectRoot ?? null,
      // Git context is per-root, so every instance under one project reports the same value; take it
      // from the first instance that has one rather than duplicating it on each.
      git: instance.project.git ?? null,
      instances: [],
    });
  }
  return map.get(identity);
}

function settingsSummary(settings) {
  const hidden = [];
  for (const [identity, project] of Object.entries(settings.projects || {})) {
    const projectName = project.name || inferredName(identity);
    if (project.hidden) {
      hidden.push({ kind: "project", identity, name: projectName, favorite: project.favorite === true });
    }
    for (const [appId, app] of Object.entries(project.apps || {})) {
      if (!app.hidden) continue;
      hidden.push({
        kind: "app",
        identity,
        name: projectName,
        favorite: project.favorite === true || app.favorite === true,
        app: {
          id: appId,
          name: app.name || labelFromId(appId),
          favorite: app.favorite === true,
          links: app.links || [],
          originPreference: app.originPreference || "localhost",
          health: app.health || {},
          match: app.match || {},
        },
      });
    }
  }
  return {
    aliases: Object.entries(settings.aliases || {}).map(([from, to]) => ({ from, to })),
    associations: Object.entries(settings.associations || {}).map(([key, association]) => ({ key, ...association })),
    hidden,
  };
}

function sortProject(project) {
  project.instances = project.instances.sort(compareInstances);
  return project;
}

function compareProjects(a, b) {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
  return a.name.localeCompare(b.name) || a.identity.localeCompare(b.identity);
}

function compareInstances(a, b) {
  return (a.app?.name || "").localeCompare(b.app?.name || "") || a.bind.port - b.bind.port;
}

function inferredName(identity, projectRoot = null) {
  if (identity.startsWith("git:")) return identity.split("/").at(-1) || identity;
  if (identity.startsWith("path:")) return path.basename(identity.slice("path:".length));
  if (projectRoot) return path.basename(projectRoot);
  return identity.split(":").at(-1) || identity;
}

function savedIdentityFor(identity) {
  if (typeof identity !== "string") return null;
  if (identity.startsWith("git:")) return { identityKind: "git", identity, projectRoot: null };
  if (identity.startsWith("path:")) return { identityKind: "path", identity, projectRoot: identity.slice("path:".length) };
  return null;
}

function labelFromId(value) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (s) => s.toUpperCase());
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function withOpaqueKey(instance, projectIdentity, appId) {
  return {
    ...instance,
    opaqueKey: opaqueKeyFor({
      associationKey: instance.associationKey,
      projectIdentity,
      appId,
      origin: instance.origin,
    }),
  };
}

function opaqueKeyFor(value) {
  return "lk_" + createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 22);
}
