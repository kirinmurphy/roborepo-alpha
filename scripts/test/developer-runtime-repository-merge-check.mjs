#!/usr/bin/env node
// Repository-keyed card merging: instances that share a repositoryId belong on one card regardless
// of which discovery mechanism found them. Before this, a repo running a Compose stack, a dev
// server, and a tunnel produced three unrelated cards in three separate page sections.
import assert from "node:assert/strict";
import { buildDeveloperRuntimeSnapshot, defaultSettings } from "../../modules/developer-runtime/index.mjs";

const MENUGOATS = "git:github.com/ryanem/menugoats";
const LOCAL = "local:616846d49a69fc81";
const LOCAL_PATH = "path:/tmp/thing";

// Discovery-shaped instance, as buildDeveloperRuntimeSnapshot expects it (pre-snapshot, so no opaqueKey).
function instance({ pid, port, command, identity, repositoryId, docker = null, status = null, title = null, contentType = null, tls = null, cpu = null, rootId = null, git = null }) {
  return {
    key: `${pid}:127.0.0.1:${port}`,
    associationKey: `a${pid}${port}`,
    matchSignature: { key: `a${pid}${port}`, titleKey: `t${pid}${port}`, relativeCwd: ".", command, title },
    origin: `http://127.0.0.1:${port}`,
    alternateOrigins: [],
    bind: { address: "127.0.0.1", port, scope: "loopback", warning: null },
    status,
    latencyMs: null,
    protocol: "http",
    tls,
    title,
    contentType,
    health: null,
    docker,
    processMetrics: { cpuPercent: cpu, cpuPercentOfHost: cpu, residentMemoryKb: 1000 },
    process: { pid, command },
    project: {
      identity,
      identityKind: identity.startsWith("git:") ? "git" : identity.startsWith("path:") ? "path" : "process",
      confidence: "high",
      projectRoot: "/tmp/menugoats",
      evidence: "Git remote",
      repositoryId,
      rootId,
      git,
    },
  };
}

// Mirrors the live shape on the development machine: Supabase publishes 11 containers under one
// Compose project, none of which set com.docker.compose.service.
const composeContainers = Array.from({ length: 11 }, (_, index) =>
  instance({
    pid: 200 + index,
    port: 54321 + index,
    command: "com.docker.backend",
    identity: `process:/tmp/x:${index}`,
    repositoryId: null,
    docker: {
      containerId: `c${index}`,
      name: `supabase_svc${index}_menugoats`,
      composeService: null,
      composeProject: "menugoats",
      image: "supabase",
      state: "running",
    },
    cpu: 0.3,
  }));

const discovery = {
  capabilities: { discovery: "supported" },
  warnings: [],
  composeProjectGit: new Map([
    ["menugoats", { git: null, repositoryId: MENUGOATS, resolvedFrom: "auto-bind" }],
  ]),
  instances: [
    ...composeContainers,
    instance({ pid: 300, port: 3000, command: "node", identity: MENUGOATS, repositoryId: MENUGOATS, status: 200, title: "Menugoats", cpu: 0.4 }),
    // A tunnel launched from the repo. It answers its own HTTP probe (ngrok serves an inspector UI),
    // so it is indistinguishable from the dev server on every field the instance record carries and
    // merges as an ordinary member.
    instance({ pid: 301, port: 4040, command: "ngrok", identity: MENUGOATS, repositoryId: MENUGOATS, status: 302, cpu: 9.9 }),
    instance({ pid: 400, port: 4321, command: "localhostr", identity: "path:/tmp/thing", repositoryId: LOCAL, status: 200, title: "Localhostr", cpu: 0.5 }),
    instance({ pid: 401, port: 63359, command: "node", identity: "path:/tmp/thing", repositoryId: LOCAL, status: 200, title: "Node", cpu: 0.2 }),
    instance({ pid: 402, port: 63409, command: "deno", identity: "path:/tmp/thing", repositoryId: LOCAL, status: 200, title: "Deno", cpu: 0.1 }),
    // process: identity -> canonicalRepositoryId returns null -> no repository to be a member of.
    instance({ pid: 500, port: 9999, command: "stray", identity: "process:/tmp:stray", repositoryId: null, status: 200, title: "Stray" }),
  ],
};

const snapshot = buildDeveloperRuntimeSnapshot({
  discovery,
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
});

const menugoats = snapshot.repositories.find((entry) => entry.repositoryId === MENUGOATS);
const local = snapshot.repositories.find((entry) => entry.repositoryId === LOCAL);

// Three former cards (compose + node + ngrok) collapse to one.
assert.equal(snapshot.repositories.length, 2);
assert.ok(menugoats);
assert.equal(menugoats.identityKind, "git");
assert.equal(menugoats.providerUrl, "https://github.com/ryanem/menugoats");

// The Compose stack stays a sub-group rather than flattening 11 containers into the member list
// ahead of the one dev server that matters.
assert.equal(menugoats.composeGroups.length, 1);
assert.equal(menugoats.composeGroups[0].containers.length, 11);
assert.equal(menugoats.composeGroups[0].resolvedFrom, "auto-bind");

// This stack carries no rootId — Phase 4 sets one only when bind mounts place it in exactly one
// checkout — so it belongs to the repository, not to any checkout of it. It must NOT land in the
// main root: that was the old fallback, and it told the user the main checkout owned infrastructure
// the evidence never placed there.
assert.equal(menugoats.sharedComposeGroups.length, 1);
assert.equal(menugoats.sharedComposeGroups[0].name, "menugoats");
assert.ok(menugoats.roots.every((root) => root.composeGroups.length === 0));
// It stays in the repository-level list either way, so the card's member count and CPU aggregate
// still see it. The two arrays are different views, not a partition.
assert.ok(menugoats.composeGroups.includes(menugoats.sharedComposeGroups[0]));
assert.equal(menugoats.members.length, 2);
assert.ok(menugoats.members.some((member) => member.port === 3000));
assert.ok(menugoats.members.some((member) => member.port === 4040));

// Aggregate is compose (11 x 0.3) + node (0.4) + ngrok (9.9). Every member counts for now — see the
// aggregate comment in snapshot.mjs for why tool processes are not yet excluded.
assert.ok(Math.abs(menugoats.cpuPercentOfHost - 13.6) < 1e-9);

// An un-pushed repository still merges; it is persistent, just not portable across machines.
assert.ok(local);
assert.equal(local.identityKind, "local");
assert.equal(local.providerUrl, null);
assert.equal(local.members.length, 3);

// git-backed repositories sort ahead of path-derived ones.
assert.equal(snapshot.repositories[0].repositoryId, MENUGOATS);

// A process: identity has no repository and never becomes a member.
assert.ok(!snapshot.repositories.some((entry) => entry.members.some((member) => member.port === 9999)));

// The legacy collections stay populated through the migration so existing consumers keep working.
assert.equal(snapshot.composeProjects.length, 1);
assert.ok(Array.isArray(snapshot.projects));
assert.ok(Array.isArray(snapshot.unmatchedInstances));

// Members carry their full instance record and Compose groups carry their whole project record, so
// the portal renders each with the card it already used rather than a reduced shape.
assert.ok(menugoats.members.every((member) => member.instance?.bind?.port === member.port));
assert.equal(menugoats.composeGroups[0].name, "menugoats");
assert.ok(Array.isArray(menugoats.composeGroups[0].containers));

// An instance with a repositoryId appears in BOTH unmatchedInstances (legacy, kept during the
// migration) and as a repository member. The portal de-duplicates by rendering only unmatched
// instances without a repositoryId, so that filter must leave nothing double-rendered and nothing
// dropped: the two partitions have to exactly reconstruct the legacy collection.
const memberPorts = new Set(snapshot.repositories.flatMap((entry) => entry.members.map((member) => member.port)));
const portalRenders = snapshot.unmatchedInstances.filter((item) => !item.project?.repositoryId);
assert.ok(portalRenders.every((item) => !memberPorts.has(item.bind.port)));
assert.ok(snapshot.unmatchedInstances
  .filter((item) => item.project?.repositoryId)
  .every((item) => memberPorts.has(item.bind.port)));

// One process on several ports is ONE member. A dev server binding a main port plus an HMR socket
// previously rendered as two sibling members, overstating what was running.
const multiPort = buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map(),
    instances: [
      instance({ pid: 700, port: 4321, command: "node", identity: LOCAL_PATH, repositoryId: LOCAL, status: 200, title: "Localhostr", cpu: 0.5 }),
      instance({ pid: 700, port: 63359, command: "node", identity: LOCAL_PATH, repositoryId: LOCAL, status: 200, cpu: 0.5 }),
      instance({ pid: 701, port: 63409, command: "deno", identity: LOCAL_PATH, repositoryId: LOCAL, status: 200, cpu: 0.1 }),
    ],
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
});
const collapsed = multiPort.repositories[0];
assert.equal(collapsed.members.length, 2);

// The titled port survives as the visible member; its untitled sibling becomes metadata.
const survivor = collapsed.members.find((member) => member.port === 4321);
assert.ok(survivor);
assert.deepEqual(survivor.secondaryPorts, [63359]);
assert.equal(survivor.entrypoint, true);

// A port that answered with a page title is user-facing and must sort above infrastructure, so
// opening the app stays one click from page load.
assert.equal(collapsed.members[0].port, 4321);
assert.equal(collapsed.members.find((member) => member.port === 63409).entrypoint, false);

// Worktree/root hierarchy: a repository with a listener on its main checkout and another on a
// linked worktree groups into two `roots[]` sections, each with its own git context and member
// list, instead of one arbitrary branch badge for the whole card
// (docs/plans/active/developer-runtime-metadata-suggestions.md, "Worktree/Root Hierarchy").
const mainGit = { provider: { ok: true }, branch: "main", isWorktree: false, ahead: 0, behind: 0 };
const featureGit = { provider: { ok: true }, branch: "feature/x", isWorktree: true, ahead: 2, behind: 0 };
// Different `identity` per root (as it is live: a worktree commonly resolves its own alias, e.g.
// "builtin:portal", distinct from the main checkout's "git:..." identity) so each becomes its own
// `project` record with its own `name` — this is what let a worktree's branch/dir name leak onto
// the repository-level title before the main-checkout-preference fix below.
const worktreeSnapshot = buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map(),
    instances: [
      instance({ pid: 800, port: 3000, command: "node", identity: MENUGOATS, repositoryId: MENUGOATS, status: 200, title: "Menugoats", rootId: "root-main", git: mainGit }),
      instance({ pid: 801, port: 3001, command: "node", identity: "builtin:portal", repositoryId: MENUGOATS, status: 200, title: "feature-branch-name", rootId: "root-feature", git: featureGit }),
    ],
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
});
const worktreeRepo = worktreeSnapshot.repositories.find((entry) => entry.repositoryId === MENUGOATS);
assert.ok(worktreeRepo);
// Flat union is still populated for consumers that only need "every member" (favorite/hide
// fan-out, departed-member tracking) and do not care which checkout it runs from.
assert.equal(worktreeRepo.members.length, 2);
assert.equal(worktreeRepo.roots.length, 2);
const mainRoot = worktreeRepo.roots.find((root) => root.rootId === "root-main");
const featureRoot = worktreeRepo.roots.find((root) => root.rootId === "root-feature");
assert.ok(mainRoot);
assert.ok(featureRoot);

// The repository name is the main checkout's name, never a worktree's — a worktree's project
// record commonly names itself after its branch/directory alias, which must never leak onto the
// repository-level title regardless of discovery order.
assert.equal(worktreeRepo.name, "menugoats");

// When the ONLY running checkout is a worktree there is no main-checkout name to prefer, so the
// candidate list cannot save the title on its own — it would fall back to the worktree's own name
// ("feature-branch-name" here). The registry's canonical displayName is the repository-level fact
// that covers this, and it outranks every candidate.
const worktreeOnlySnapshot = buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map(),
    instances: [
      instance({ pid: 802, port: 3002, command: "node", identity: "path:feature-branch-name", repositoryId: MENUGOATS, status: 200, title: "feature-branch-name", rootId: "root-feature", git: featureGit }),
    ],
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
  repositoryNames: new Map([[MENUGOATS, "menugoats"]]),
});
const worktreeOnlyRepo = worktreeOnlySnapshot.repositories.find((entry) => entry.repositoryId === MENUGOATS);
assert.equal(worktreeOnlyRepo.name, "menugoats", "registry name titles the card when only a worktree runs");
assert.equal(worktreeOnlyRepo.roots.length, 1);
assert.equal(worktreeOnlyRepo.roots[0].isWorktree, true);

// Without a registry name the builder still degrades to the old behavior rather than emptying the
// title — the worktree's own name is wrong, but it is better than nothing.
const unnamedSnapshot = buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map(),
    instances: [
      instance({ pid: 803, port: 3003, command: "node", identity: "builtin:portal", repositoryId: MENUGOATS, status: 200, title: "feature-branch-name", rootId: "root-feature", git: featureGit }),
    ],
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
});
assert.ok(unnamedSnapshot.repositories.find((entry) => entry.repositoryId === MENUGOATS).name, "name is never empty");

// Same-shape instances on two different worktrees are two intentional checkouts running the same
// app, not stale leftover processes from one checkout — duplicate-listener detection must not fire
// across roots. (It still fires WITHIN one root; see the multi-port collapse case below for that.)
assert.deepEqual(worktreeRepo.duplicateGroups, []);
assert.equal(mainRoot.isWorktree, false);
assert.equal(mainRoot.git.branch, "main");
assert.equal(mainRoot.members.length, 1);
assert.equal(mainRoot.members[0].port, 3000);
assert.equal(featureRoot.isWorktree, true);
assert.equal(featureRoot.git.branch, "feature/x");
assert.equal(featureRoot.members.length, 1);
assert.equal(featureRoot.members[0].port, 3001);
// Main checkout sorts first regardless of branch name, so the card's primary section is always
// the non-worktree root when one exists.
assert.equal(worktreeRepo.roots[0].rootId, "root-main");

// The repository-level `git` field no longer exists — git moved to per-root, since a single
// repository-level value could not represent two different branches at once.
assert.equal(worktreeRepo.git, undefined);

// Same-PID multi-port listeners are normal, not stale: no duplicate warning for them.
assert.equal(collapsed.duplicateGroups.length, 0);

// Several processes serving the same shape are the stale-instance case. The upstream shape pass
// collapses them to one visible card and records their ports; the repository surfaces that as a
// warning. Same signature (identical title + relative cwd + command) is what makes them duplicates.
const staleInstances = [
  instance({ pid: 800, port: 5173, command: "node", identity: LOCAL_PATH, repositoryId: LOCAL, status: 200, title: "App", cpu: 0.2 }),
  instance({ pid: 801, port: 5174, command: "node", identity: LOCAL_PATH, repositoryId: LOCAL, status: 200, title: "App", cpu: 0.2 }),
];
for (const item of staleInstances) {
  item.matchSignature = { ...item.matchSignature, key: "shared-shape", titleKey: "shared-shape-title" };
  item.associationKey = "shared-shape";
}
const stale = buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map(),
    instances: staleInstances,
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
});
assert.equal(stale.repositories[0].duplicateGroups.length, 1);
assert.deepEqual(stale.repositories[0].duplicateGroups[0].ports, [5173, 5174]);

// A repository with no measurable CPU reports null rather than a confident 0%.
const unmeasured = buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map(),
    instances: [
      { ...instance({ pid: 600, port: 7000, command: "node", identity: MENUGOATS, repositoryId: MENUGOATS, status: 200, title: "Quiet" }), processMetrics: null },
    ],
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
});
assert.equal(unmeasured.repositories[0].cpuPercentOfHost, null);

// The other half of the routing rule: a stack the mounts DID place in one checkout still renders
// inside that checkout's section, not in the shared region. Without this the change could pass by
// sending every stack to the repository level, which would be just as wrong in the other direction.
const ownedRootId = "root-abc";
const owned = buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map([
      ["menugoats", {
        git: null,
        repositoryId: MENUGOATS,
        resolvedFrom: "auto",
        rootId: ownedRootId,
        ownership: "owned",
        ownershipEvidence: { kind: "bind-mount", checkoutPaths: ["/tmp/menugoats"] },
      }],
    ]),
    instances: [
      instance({
        pid: 700,
        port: 8100,
        command: "com.docker.backend",
        identity: "process:/tmp/y:0",
        repositoryId: null,
        docker: {
          containerId: "owned0",
          name: "menugoats_db",
          composeService: "db",
          composeProject: "menugoats",
          image: "postgres",
          state: "running",
        },
      }),
    ],
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
});
const ownedRepo = owned.repositories.find((entry) => entry.repositoryId === MENUGOATS);
assert.equal(ownedRepo.sharedComposeGroups.length, 0);
const ownedRoot = ownedRepo.roots.find((root) => root.rootId === ownedRootId);
assert.ok(ownedRoot, "an owned stack creates the checkout section it was placed in");
assert.equal(ownedRoot.composeGroups.length, 1);
assert.equal(ownedRoot.composeGroups[0].ownership, "owned");

// --- Phase 3: persisted repositories join the same list ---
// The point of the phase: a repository you ran once and stopped stays listed. Before this the page
// showed only what was running, and the separate "Inactive saved projects" list held app slots the
// user had configured — so an ordinary repository, run and stopped, appeared nowhere at all.
const IDLE = "git:github.com/k/idle-one";
const STALE = "git:github.com/k/stale-one";
const withPersisted = buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map(),
    instances: [instance({ pid: 800, port: 8200, command: "node", identity: MENUGOATS, repositoryId: MENUGOATS, status: 200, title: "Live" })],
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
  persistedRepositories: [
    {
      repositoryId: IDLE,
      name: "idle-one",
      lifecycle: { state: "idle", reason: null },
      lastSeenAt: "2026-08-01T00:00:00.000Z",
      favorite: false,
      checkouts: [
        { rootId: "idle-root", kind: "primary", state: "present", reason: null, projectRoot: "/tmp/idle-one", git: { branch: "main", isWorktree: false } },
        { rootId: "idle-gone-wt", kind: "worktree", state: "absent", reason: "checkout directory no longer exists", projectRoot: "/tmp/idle-one-wt", git: null },
      ],
    },
    {
      repositoryId: STALE,
      name: "stale-one",
      lifecycle: { state: "stale", reason: "checkout missing" },
      lastSeenAt: "2026-07-01T00:00:00.000Z",
      favorite: false,
      checkouts: [{ rootId: "stale-root", kind: "primary", state: "absent", reason: "checkout missing", projectRoot: "/tmp/stale-one", git: null }],
    },
  ],
});
const idle = withPersisted.repositories.find((r) => r.repositoryId === IDLE);
const staleRepo = withPersisted.repositories.find((r) => r.repositoryId === STALE);
const live = withPersisted.repositories.find((r) => r.repositoryId === MENUGOATS);

assert.equal(withPersisted.repositories.length, 3);
// An idle repository keeps everything that does not depend on a live process — its checkouts, their
// branches, its identity — and has no members, which is the entire difference.
assert.equal(idle.lifecycle.state, "idle");
assert.equal(idle.members.length, 0);
assert.equal(idle.roots.length, 2);
assert.equal(idle.roots[0].git.branch, "main");
// A deleted worktree has no git left to say it was one; the registry's recorded kind keeps it a
// worktree row, sorted after the main checkout, instead of a second "main checkout".
assert.equal(idle.roots[1].isWorktree, true);
assert.equal(idle.roots[1].checkoutState, "absent");
assert.equal(idle.lastSeenAt, "2026-08-01T00:00:00.000Z");
// A checkout that is not on disk carries that as a fact about the directory, so the card can say
// "checkout missing" rather than the misleading "no active members".
assert.equal(staleRepo.lifecycle.state, "stale");
assert.equal(staleRepo.roots[0].checkoutState, "absent");
assert.equal(staleRepo.roots[0].checkoutReason, "checkout missing");
// A running repository is `active` without anyone having to say so.
assert.equal(live.lifecycle.state, "active");
// Running sorts ahead of not-running, whatever the names say: "menugoats" would otherwise fall
// between "idle-one" and "stale-one" alphabetically.
assert.equal(withPersisted.repositories[0].repositoryId, MENUGOATS);

// A repository that IS running must never also appear from the persisted list. The caller filters
// running ids, but a stack resolved on this scan can reach the registry a moment before the snapshot
// is built, and one repository rendering as two cards is worse than one rendering a poll late.
const doubled = buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map(),
    instances: [instance({ pid: 801, port: 8201, command: "node", identity: MENUGOATS, repositoryId: MENUGOATS, status: 200, title: "Live" })],
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
  persistedRepositories: [{
    repositoryId: MENUGOATS,
    name: "menugoats",
    lifecycle: { state: "idle", reason: null },
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    favorite: false,
    checkouts: [{ rootId: "dupe", kind: "primary", state: "present", reason: null, projectRoot: "/tmp/menugoats", git: null }],
  }],
});
assert.equal(doubled.repositories.filter((r) => r.repositoryId === MENUGOATS).length, 1);
assert.equal(doubled.repositories[0].lifecycle.state, "active", "the running view wins over the persisted one");

// Absent the field entirely, the snapshot is exactly what it was before Phase 3 — persistence being
// unavailable costs the idle repositories and nothing else.
assert.equal(snapshot.repositories.every((r) => r.lifecycle.state === "active"), true);

// --- Fixtures and display order (repository-row-layout) ---
// Dev fixtures (local/dev-fixtures) use deliberately unfetchable github.com/example remotes. They are
// flagged, and the list reads: active projects, then fixtures (running or not), then idle projects.
const FIXTURE = "git:github.com/example/multi-member-fixture";
const IDLE_FIXTURE = "git:github.com/example/shared-stack-fixture";
const ordered = buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map(),
    instances: [
      instance({ pid: 850, port: 48101, command: "node", identity: FIXTURE, repositoryId: FIXTURE, status: 200, title: "Fixture" }),
      instance({ pid: 851, port: 8300, command: "node", identity: MENUGOATS, repositoryId: MENUGOATS, status: 200, title: "Real" }),
    ],
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
  persistedRepositories: [
    { repositoryId: IDLE, name: "idle-one", lifecycle: { state: "idle", reason: null }, lastSeenAt: "2026-08-01T00:00:00.000Z", checkouts: [] },
    { repositoryId: IDLE_FIXTURE, name: "shared-stack-fixture", lifecycle: { state: "idle", reason: null }, lastSeenAt: "2026-08-01T00:00:00.000Z", checkouts: [] },
  ],
});
assert.deepEqual(ordered.repositories.map((r) => r.repositoryId), [MENUGOATS, FIXTURE, IDLE_FIXTURE, IDLE]);
assert.deepEqual(ordered.repositories.map((r) => r.fixture), [false, true, true, false]);

// --- Idle main checkout of a running repository ---
// Only a worktree runs, so no running member supplies the main checkout. The caller's
// idleMainCheckouts fills it as an idle root — branch and path, no members, no link — so the
// always-rendered main row is never blank.
const worktreeGitShape = { provider: { ok: true }, branch: "feature/x", isWorktree: true };
const mainGitShape = { provider: { ok: true }, branch: "main", isWorktree: false };
const worktreeOnly = (idleMainCheckouts) => buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map(),
    instances: [instance({ pid: 860, port: 8400, command: "node", identity: MENUGOATS, repositoryId: MENUGOATS, status: 200, title: "Wt", rootId: "wt-root", git: worktreeGitShape })],
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
  idleMainCheckouts,
}).repositories.find((r) => r.repositoryId === MENUGOATS);

const withIdleMain = worktreeOnly(new Map([[MENUGOATS, { rootId: "main-root", projectRoot: "/tmp/menugoats", git: mainGitShape, state: "present" }]]));
assert.deepEqual(withIdleMain.roots.map((root) => root.rootId), ["main-root", "wt-root"], "idle main checkout sorts first, beside the running worktree");
const idleMain = withIdleMain.roots[0];
assert.equal(idleMain.isWorktree, false);
assert.equal(idleMain.git.branch, "main");
assert.equal(idleMain.projectRoot, "/tmp/menugoats");
assert.equal(idleMain.members.length, 0);
assert.equal(idleMain.primaryEntrypoint, null);
assert.equal(withIdleMain.lifecycle.state, "active", "the repository is still running through its worktree");

// Without the fallback the main checkout is simply absent (the portal's empty-row case).
assert.equal(worktreeOnly(new Map()).roots.some((root) => !root.isWorktree), false);

// A running main checkout always wins: the fallback never adds a second main root beside it.
const mainRunning = buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map(),
    instances: [instance({ pid: 870, port: 8500, command: "node", identity: MENUGOATS, repositoryId: MENUGOATS, status: 200, title: "Main", rootId: "main-live", git: mainGitShape })],
  },
  settings: defaultSettings(),
  now: new Date("2026-08-02T00:00:00.000Z"),
  idleMainCheckouts: new Map([[MENUGOATS, { rootId: "main-root", projectRoot: "/tmp/menugoats", git: mainGitShape, state: "present" }]]),
}).repositories.find((r) => r.repositoryId === MENUGOATS);
assert.deepEqual(mainRunning.roots.map((root) => root.rootId), ["main-live"]);

// --- Role ranking and the promoted link (repository-row-layout) ---
// Each scenario builds one checkout of MENUGOATS and reads back that checkout's root, so the
// assertions are about which member a row would promote rather than about snapshot plumbing.
const RANK_ROOT = "root-rank";
function rankedRoot(instances, { composeProjectGit = new Map() } = {}) {
  const built = buildDeveloperRuntimeSnapshot({
    discovery: { capabilities: { discovery: "supported" }, warnings: [], composeProjectGit, instances },
    settings: defaultSettings(),
    now: new Date("2026-08-02T00:00:00.000Z"),
  });
  return built.repositories.find((entry) => entry.repositoryId === MENUGOATS).roots.find((root) => root.rootId === RANK_ROOT);
}
const rankListener = (fields) => instance({ command: "node", identity: MENUGOATS, repositoryId: MENUGOATS, status: 200, rootId: RANK_ROOT, ...fields });

// A Python app and a Node Storybook both answer with a title. Sorting by process command put `node`
// first, so Storybook took the slot; the tooling preset has to demote it whatever the names say.
const storybook = rankedRoot([
  rankListener({ pid: 900, port: 5000, command: "Python", title: "Recipes" }),
  rankListener({ pid: 901, port: 6006, command: "node", title: "Storybook" }),
]);
assert.equal(storybook.primaryEntrypoint?.port, 5000);
assert.equal(storybook.primaryEntrypoint.kind, "listener");
assert.equal(storybook.members.find((member) => member.port === 6006).role, "tooling");
assert.equal(storybook.members[0].port, 5000, "the app sorts ahead of tooling");

// Nothing user-facing is running, so the row promotes nothing rather than an API.
const apiOnly = rankedRoot([rankListener({ pid: 902, port: 5001, contentType: "application/json" })]);
assert.equal(apiOnly.members[0].role, "api");
assert.equal(apiOnly.primaryEntrypoint, null);

// Compose containers live in composeGroups, not members, so a Compose-only checkout previously had
// nothing to promote even when its `web` service was the app.
const composeGit = new Map([["menugoats", {
  git: null,
  repositoryId: MENUGOATS,
  resolvedFrom: "auto",
  rootId: RANK_ROOT,
  ownership: "owned",
  ownershipEvidence: { kind: "bind-mount", checkoutPaths: ["/tmp/menugoats"] },
}]]);
const composeContainer = ({ pid, port, service, name = `menugoats-${service}-1`, status = null, title = null, contentType = null }) => instance({
  pid,
  port,
  command: "com.docker.backend",
  identity: `process:/tmp/c:${pid}`,
  repositoryId: null,
  status,
  title,
  contentType,
  docker: { containerId: `c${pid}`, name, composeService: service, composeProject: "menugoats", image: service, state: "running" },
});
const composeOnly = rankedRoot([
  composeContainer({ pid: 910, port: 8080, service: "web", status: 200, title: "Shop", contentType: "text/html" }),
  composeContainer({ pid: 911, port: 5432, service: "postgres" }),
  composeContainer({ pid: 912, port: 6379, service: "redis" }),
  // Supabase CLI sets no Compose service label: only the container name says what this is.
  composeContainer({ pid: 913, port: 54321, service: null, name: "supabase_kong_menugoats", status: 404, contentType: "application/json" }),
], { composeProjectGit: composeGit });
assert.equal(composeOnly.members.length, 0);
assert.equal(composeOnly.primaryEntrypoint?.port, 8080);
assert.equal(composeOnly.primaryEntrypoint.kind, "container");
assert.ok(composeOnly.primaryEntrypoint.opaqueKey, "a promoted container carries the key the Links panel fetches by");
const containerRole = (port) => composeOnly.composeGroups[0].containers
  .flatMap((container) => container.instances)
  .find((item) => item.bind.port === port).role;
assert.equal(containerRole(8080), "app");
assert.equal(containerRole(5432), "service");
assert.equal(containerRole(6379), "service");
assert.equal(containerRole(54321), "service");

// With no name or title hint and neither on a common app port, the lower port wins.
const noHints = rankedRoot([
  rankListener({ pid: 920, port: 7002, title: "Beta" }),
  rankListener({ pid: 921, port: 7001, title: "Alpha" }),
]);
assert.equal(noHints.primaryEntrypoint.port, 7001);

// A title naming the repository outranks a merely conventional port.
const namedTitle = rankedRoot([
  rankListener({ pid: 930, port: 3000, title: "Dashboard" }),
  rankListener({ pid: 931, port: 7005, title: "Menugoats admin" }),
]);
assert.equal(namedTitle.primaryEntrypoint.port, 7005);

// An app shell that sets its title from JavaScript still answers 2xx text/html: it counts as an app,
// but only takes the slot when nothing titled is running.
const shellOnly = rankedRoot([rankListener({ pid: 940, port: 7010, contentType: "text/html; charset=utf-8" })]);
assert.equal(shellOnly.members[0].role, "app");
assert.equal(shellOnly.primaryEntrypoint.port, 7010);
const shellBesideTitled = rankedRoot([
  rankListener({ pid: 941, port: 7010, contentType: "text/html; charset=utf-8" }),
  rankListener({ pid: 942, port: 7011, title: "Dash" }),
]);
assert.equal(shellBesideTitled.primaryEntrypoint.port, 7011);
const htmlNotFound = rankedRoot([rankListener({ pid: 943, port: 7012, status: 404, contentType: "text/html" })]);
assert.equal(htmlNotFound.members[0].role, "api");
assert.equal(htmlNotFound.primaryEntrypoint, null);

console.log("developer-runtime repository merge check passed");
