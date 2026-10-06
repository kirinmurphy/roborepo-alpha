// Home's first-run demonstration data. This is deliberately an in-memory projection rather than
// repository-registry state: it must never opt a user into Runtime observation, Plans, or telemetry.

import { forgetRepository, loadRegistry, updateRegistry } from "../../modules/repositories/index.mjs";

// Keep the first-run Home/Runtime mock data available for a later product decision, but leave the
// mock views disabled in the current release. Plans still use their own read-only mock projection.
export const MOCK_FIRST_RUN_VIEWS_ENABLED = false;

export const MOCK_REPOSITORY_IDS = [
  "git:github.com/example/shared-stack-fixture",
  "git:github.com/example/multi-member-fixture",
  "git:github.com/example/idle-checkout-fixture",
];

const MOCK_PLAN_DEFINITIONS = [
  {
    repositoryId: MOCK_REPOSITORY_IDS[0],
    id: "mock-compose-refresh",
    title: "Refresh the shared Compose stack",
    lifecycle: "active",
    worktree: "second-checkout",
    priority: "high",
    nextAction: "Verify the service health checks in the shared checkout.",
    taskCounts: { total: 5, complete: 3 },
    changedAt: "2026-10-03T14:00:00.000Z",
    relativePath: "docs/plans/active/mock-compose-refresh.md",
    excerpt: "Exercise a plan attached to the shared Compose worktree.",
  },
  {
    repositoryId: MOCK_REPOSITORY_IDS[1],
    id: "mock-checkout-redesign",
    title: "Redesign the checkout view",
    lifecycle: "active",
    worktree: "failing-checkout",
    priority: "medium",
    nextAction: "Resolve the failing checkout state and capture its recovery path.",
    taskCounts: { total: 8, complete: 4 },
    changedAt: "2026-10-02T10:30:00.000Z",
    relativePath: "docs/plans/active/mock-checkout-redesign.md",
    excerpt: "Exercise a plan attached to a worktree with a warning.",
  },
  {
    repositoryId: MOCK_REPOSITORY_IDS[1],
    id: "mock-api-surface",
    title: "Tighten the API surface",
    lifecycle: "active",
    worktree: "api-checkout",
    priority: "low",
    nextAction: "Review the route inventory before implementation.",
    taskCounts: { total: 4, complete: 1 },
    changedAt: "2026-10-01T09:15:00.000Z",
    relativePath: "docs/plans/active/mock-api-surface.md",
    excerpt: "Exercise a second plan attached to another active worktree.",
  },
  {
    repositoryId: MOCK_REPOSITORY_IDS[1],
    id: "mock-docs-refresh",
    title: "Refresh the developer docs",
    lifecycle: "backlog",
    worktree: "docs-refresh",
    priority: "none",
    nextAction: "Choose the first documentation slice to update.",
    taskCounts: { total: 0, complete: 0 },
    changedAt: "2026-09-30T16:00:00.000Z",
    relativePath: "docs/plans/backlog/mock-docs-refresh.md",
    excerpt: "Exercise a backlog plan associated with a worktree.",
  },
];

const MOCK_DISPLAY_NAMES = {
  [MOCK_REPOSITORY_IDS[0]]: "Mock: Shared Compose stack",
  [MOCK_REPOSITORY_IDS[1]]: "Mock: Multi-member app",
  [MOCK_REPOSITORY_IDS[2]]: "Mock: Idle checkout",
};

export function purgePersistedMockRepositories({ stateRoot }) {
  loadRegistry({ stateRoot });
  return updateRegistry({
    stateRoot,
    mutate: (current) => {
      let changed = false;
      for (const repositoryId of MOCK_REPOSITORY_IDS) {
        if (current.repositories?.[repositoryId]) {
          forgetRepository(current, repositoryId);
          changed = true;
        }
      }
      return changed;
    },
  });
}

export function mockHomeOverview({ now = new Date().toISOString() } = {}) {
  const plansByRepository = mockPlanDataByRepository();
  return {
    updatedAt: now,
    repositories: [
      mockRepository({
        repositoryId: MOCK_REPOSITORY_IDS[0],
        displayName: "shared-stack-fixture",
        lifecycle: { state: "active", reason: null },
        roots: [
          checkout("shared-main", "main", "/mock/shared-stack-fixture", { port: 48080, kind: "container" }),
          checkout("shared-second", "second-checkout", "/mock/shared-stack-fixture-wt", { port: 48080, kind: "container", worktree: true }),
        ],
        planData: plansByRepository.get(MOCK_REPOSITORY_IDS[0]),
        tokenData: { sessionCount: 8, warningCount: 2, highestSeverity: "high", warnings: [warning("spike", "mock-shared-spike"), warning("loop", "mock-shared-loop")] },
      }),
      mockRepository({
        repositoryId: MOCK_REPOSITORY_IDS[1],
        displayName: "multi-member-fixture",
        lifecycle: { state: "active", reason: null },
        roots: [
          checkout("multi-main", "feature/checkout-redesign", "/mock/multi-member-fixture", { port: 48101, kind: "listener", dirty: true }),
          checkout("multi-failing", "failing-checkout", "/mock/multi-member-fixture-wt-failing", { port: 48104, kind: "listener", worktree: true }),
          checkout("multi-api", "api-checkout", "/mock/multi-member-fixture-wt-api", { port: 48105, kind: "listener", worktree: true }),
          checkout("multi-docs", "docs-refresh", "/mock/multi-member-fixture-wt-docs", { port: 48107, kind: "listener", worktree: true }),
          checkout("multi-detached", "(detached)", "/mock/multi-member-fixture-wt-detached", { port: 48108, kind: "listener", worktree: true, detached: true }),
        ],
        planData: plansByRepository.get(MOCK_REPOSITORY_IDS[1]),
        tokenData: { sessionCount: 14, warningCount: 6, highestSeverity: "high", warnings: [warning("read-warning", "mock-multi-read"), warning("spike", "mock-multi-spike")] },
      }),
      mockRepository({
        repositoryId: MOCK_REPOSITORY_IDS[2],
        displayName: "idle-checkout-fixture",
        lifecycle: { state: "idle", reason: null },
        roots: [
          checkout("idle-main", "main", "/mock/idle-checkout-fixture"),
          {
            rootId: "idle-missing",
            name: "Worktree",
            isWorktree: true,
            worktreeName: "missing-checkout",
            projectRoot: "/mock/idle-checkout-fixture-wt-missing",
            checkoutState: "absent",
            checkoutReason: "checkout directory no longer exists",
            git: null,
            primaryEntrypoint: null,
          },
        ],
        planData: plansByRepository.get(MOCK_REPOSITORY_IDS[2]),
        tokenData: { sessionCount: 12, warningCount: 0, highestSeverity: null, warnings: [] },
      }),
    ],
    unresolvedActivity: [],
  };
}

// The same plan configuration backs Home's inline plan rows, the Plans page's read-only demo
// board, and the Runtime mock's worktree names. It never becomes a file or registry record.
export function mockPlansSnapshot({ now = new Date().toISOString(), packageState = null } = {}) {
  const repositories = mockRepositorySummaries();
  const plans = MOCK_PLAN_DEFINITIONS.map((definition) => mockPlanRecord(definition, repositories.get(definition.repositoryId), now));
  return {
    ok: true,
    repositories: [...repositories.values()],
    repositoryScans: MOCK_REPOSITORY_IDS.map((repositoryId) => ({
      repositoryId,
      state: "scanned",
      planCount: plans.filter((record) => record.repository.repositoryId === repositoryId).length,
      checkoutCount: repositoryId === MOCK_REPOSITORY_IDS[0] ? 2 : repositoryId === MOCK_REPOSITORY_IDS[1] ? 5 : 2,
    })),
    plans,
    errors: [],
    truncated: false,
    planWritePackage: packageState || { available: false, enabled: false, status: "missing", message: "" },
    autoDiscovery: { enabled: false },
  };
}

export function mockPlanDocument({ key }) {
  const record = mockPlansSnapshot().plans.find((candidate) => candidate.key === key);
  if (!record) throw new Error("unknown plan key");
  return {
    plan: record,
    html: `<p>${record.plan.excerpt}</p><h2>Mock demonstration</h2><p>This read-only plan is part of RoboRepo's first-run demonstration.</p>`,
    parsed: {
      frontmatter: { id: record.plan.id, title: record.plan.title, worktree: record.plan.worktree },
      findings: [],
      warnings: [],
      title: record.plan.title,
      headings: [{ depth: 1, text: record.plan.title, line: 1, hasContent: true }],
      tasks: record.plan.openTasks,
      notTested: { present: false, entries: [], unchecked: 0 },
      taskCounts: record.plan.taskCounts,
    },
  };
}

// Runtime has its own repository projection, but it is built from these same mock checkouts so
// a plan's `worktree` names join to the exact roots shown on both pages.
export function mockRuntimeSnapshot({ now = new Date().toISOString() } = {}) {
  const overview = mockHomeOverview({ now });
  const repositories = overview.repositories.map((repository) => {
    const roots = repository.domains.runtime.data.checkouts
      .map((root) => {
        const members = root.primaryEntrypoint?.kind === "listener"
          ? mockRuntimeMembers(repository, root)
          : [];
        const composeGroups = root.primaryEntrypoint?.kind === "container"
          ? [mockRuntimeComposeGroup(repository, root)]
          : [];
        return {
          ...root,
          git: root.git ? { ...root.git, isWorktree: root.isWorktree, worktreeName: root.worktreeName } : null,
          members,
          composeGroups,
        };
      })
      .sort((a, b) => {
        if (a.isWorktree !== b.isWorktree) return a.isWorktree ? 1 : -1;
        return (a.git?.branch || "").localeCompare(b.git?.branch || "");
      });
    return {
      repositoryId: repository.repositoryId,
      urlKey: repository.urlKey,
      identityKind: "git",
      providerUrl: repository.providerUrl,
      fixture: true,
      name: MOCK_DISPLAY_NAMES[repository.repositoryId] || repository.displayName,
      pinned: false,
      lifecycle: repository.lifecycle,
      lastSeenAt: null,
      composeGroups: roots.flatMap((root) => root.composeGroups),
      sharedComposeGroups: [],
      members: roots.flatMap((root) => root.members),
      roots,
      duplicateGroups: [],
      cpuPercentOfHost: null,
    };
  });
  return {
    generatedAt: now,
    refresh: { state: "idle", startedAt: null, error: null, generation: 0 },
    settingsRevision: 0,
    capabilities: { discovery: "supported", platform: "mock" },
    warnings: [],
    projects: [],
    composeProjects: [],
    unmatchedInstances: [],
    repositories,
    inactiveProjects: [],
    hiddenRepositories: [],
    hiddenCount: 0,
    settings: { aliases: [], associations: [], hidden: [] },
    autoDiscovery: { enabled: false },
  };
}

function mockRuntimeMembers(repository, root) {
  const members = [mockRuntimeMember({
    repository,
    root,
    index: 0,
    role: "app",
    port: root.primaryEntrypoint.port,
    appName: "Mock app",
  })];
  // The main checkout demonstrates the member disclosure itself. Other checkouts keep one
  // promoted member so their Links menu remains visible without turning every row into a list.
  if (root.rootId === "multi-main") {
    members.push(mockRuntimeMember({
      repository,
      root,
      index: 1,
      role: "tooling",
      port: root.primaryEntrypoint.port + 1,
      appName: "Storybook",
    }));
  }
  return members;
}

function mockRuntimeMember({ repository, root, index, role, port, appName }) {
  const opaqueKey = index === 0 ? root.primaryEntrypoint.opaqueKey : `mock-${root.rootId}-tooling`;
  const origin = `http://127.0.0.1:${port}`;
  const instance = {
    opaqueKey,
    associationKey: `mock:${root.rootId}:${index}`,
    project: {
      identity: repository.repositoryId,
      repositoryId: repository.repositoryId,
      rootId: root.rootId,
      projectRoot: root.projectRoot,
      evidence: "mock",
      confidence: "high",
      git: root.git,
      providerUrl: repository.providerUrl,
    },
    bind: { address: "127.0.0.1", port, warning: null },
    origin,
    title: `${appName} mock server`,
    status: 200,
    latencyMs: 18,
    health: { state: "healthy", reason: null },
    process: { pid: 8000 + index, command: "mock-dev-server" },
    processMetrics: { cpuPercentOfHost: 0.4, residentMemoryKb: 64000, elapsedSeconds: 24 },
    app: {
      id: `mock-${root.rootId}-${index}`,
      name: appName,
      favorite: false,
      hidden: false,
      links: [
        { id: "home", label: "Home", path: "/", url: `${origin}/` },
        { id: "docs", label: "Docs", path: "/docs", url: `${origin}/docs` },
      ],
      originPreference: "localhost",
      health: {},
      match: {},
    },
    docker: null,
    duplicatePorts: [],
  };
  return {
    kind: "listener",
    projectIdentity: repository.repositoryId,
    rootId: root.rootId,
    entrypoint: index === 0,
    role,
    description: instance.title,
    secondaryPorts: [],
    instance,
    opaqueKey,
    associationKey: instance.associationKey,
    name: appName,
    port,
    origin,
    status: 200,
    health: instance.health,
    docker: null,
    app: instance.app,
    cpuPercentOfHost: 0.4,
    residentMemoryKb: 64000,
  };
}

function mockRuntimeComposeGroup(repository, root) {
  const containerId = `mock-${root.rootId}`;
  const opaqueKey = root.primaryEntrypoint.opaqueKey;
  const instance = {
    opaqueKey,
    associationKey: `mock:${root.rootId}:compose`,
    project: {
      identity: repository.repositoryId,
      repositoryId: repository.repositoryId,
      rootId: root.rootId,
      projectRoot: root.projectRoot,
      evidence: "mock",
      confidence: "high",
      git: root.git,
      providerUrl: repository.providerUrl,
    },
    bind: { address: "127.0.0.1", port: root.primaryEntrypoint.port, warning: null },
    origin: root.primaryEntrypoint.origin,
    title: "Mock web container",
    status: 200,
    latencyMs: 12,
    health: { state: "healthy", reason: null },
    process: null,
    processMetrics: { cpuPercentOfHost: 0.2, residentMemoryKb: 48000, elapsedSeconds: 20 },
    app: null,
    docker: {
      containerId,
      composeService: "web",
      name: `${repository.displayName}-web`,
      image: "node:mock",
      state: "running",
    },
  };
  return {
    identity: `compose:${containerId}`,
    name: "Docker",
    favorite: false,
    hidden: false,
    repoPath: root.projectRoot,
    git: root.git,
    repositoryId: repository.repositoryId,
    rootId: root.rootId,
    ownership: "owned",
    ownershipEvidence: { kind: "bind-mount" },
    resolvedFrom: "auto",
    providerUrl: repository.providerUrl,
    instances: [instance],
    containers: [{
      containerId,
      name: "web",
      image: "node:mock",
      state: "running",
      instances: [instance],
    }],
    cpuPercentOfHost: 0.2,
  };
}

function mockRepository({ repositoryId, displayName, lifecycle, roots, planData, tokenData }) {
  const checkouts = roots.map((root) => ({ ...root }));
  const gitCheckouts = checkouts.map(({ primaryEntrypoint, ...root }) => root);
  return {
    repositoryId,
    urlKey: displayName,
    kind: "git",
    displayName,
    providerUrl: `https://github.com/example/${displayName}`,
    resolution: "resolved",
    activity: "unknown",
    visibility: "visible",
    pinned: false,
    confidence: "high",
    evidence: "mock-fixture",
    discoveredBy: ["mock"],
    capabilities: { developerRuntime: false, plans: false, telemetry: false, agentConfig: false, health: false },
    enrollments: {},
    fixture: true,
    lifecycle,
    lastSeenAt: null,
    domains: {
      runtime: { status: "available", updatedAt: null, data: { lifecycle, lastSeenAt: null, checkouts } },
      git: { status: "available", updatedAt: null, data: { checkouts: gitCheckouts, warnings: [] } },
      plans: { status: "available", updatedAt: null, data: planData || emptyPlanData() },
      tokens: { status: "available", updatedAt: null, data: tokenData },
      agents: { status: "unavailable", updatedAt: null, data: null, message: "Repository-scoped agent configuration is not available yet" },
    },
  };
}

function mockPlanDataByRepository() {
  const repositoryRoots = new Map();
  for (const repository of mockRepositoryDefinitions()) {
    repositoryRoots.set(repository.repositoryId, new Map(repository.roots.map((root) => [root.worktreeName, root.rootId])));
  }
  const grouped = new Map();
  for (const definition of MOCK_PLAN_DEFINITIONS) {
    const plans = grouped.get(definition.repositoryId) || [];
    const checkoutRootId = repositoryRoots.get(definition.repositoryId)?.get(definition.worktree) || null;
    plans.push(mockHomePlan(definition, checkoutRootId));
    grouped.set(definition.repositoryId, plans);
  }
  return new Map(MOCK_REPOSITORY_IDS.map((repositoryId) => {
    const plans = grouped.get(repositoryId) || [];
    return [repositoryId, {
      counts: {
        active: plans.filter((plan) => plan.lifecycle === "active").length,
        backlog: plans.filter((plan) => plan.lifecycle === "backlog").length,
      },
      active: plans.filter((plan) => plan.lifecycle === "active"),
      recent: plans.map(({ id, title, lifecycle, changedAt }) => ({ id, title, lifecycle, changedAt })),
    }];
  }));
}

function mockRepositoryDefinitions() {
  return [
    {
      repositoryId: MOCK_REPOSITORY_IDS[0],
      roots: [
        checkout("shared-main", "main", "/mock/shared-stack-fixture"),
        checkout("shared-second", "second-checkout", "/mock/shared-stack-fixture-wt", { worktree: true }),
      ],
    },
    {
      repositoryId: MOCK_REPOSITORY_IDS[1],
      roots: [
        checkout("multi-main", "feature/checkout-redesign", "/mock/multi-member-fixture"),
        checkout("multi-failing", "failing-checkout", "/mock/multi-member-fixture-wt-failing", { worktree: true }),
        checkout("multi-api", "api-checkout", "/mock/multi-member-fixture-wt-api", { worktree: true }),
        checkout("multi-docs", "docs-refresh", "/mock/multi-member-fixture-wt-docs", { worktree: true }),
        checkout("multi-detached", "(detached)", "/mock/multi-member-fixture-wt-detached", { worktree: true, detached: true }),
      ],
    },
    {
      repositoryId: MOCK_REPOSITORY_IDS[2],
      roots: [
        checkout("idle-main", "main", "/mock/idle-checkout-fixture"),
        { rootId: "idle-missing", worktreeName: "missing-checkout", isWorktree: true },
      ],
    },
  ];
}

function mockHomePlan(definition, checkoutRootId) {
  const total = definition.taskCounts.total;
  return {
    id: definition.id,
    key: `mock:${definition.id}`,
    title: definition.title,
    lifecycle: definition.lifecycle,
    changedAt: definition.changedAt,
    worktree: definition.worktree,
    taskCounts: definition.taskCounts,
    checkoutRootId,
    priority: definition.priority,
    nextAction: definition.nextAction,
    openTasks: Array.from({ length: Math.max(0, total - definition.taskCounts.complete) }, (_, index) => ({ done: false, text: `${definition.title} task ${index + 1}`, line: index + 2 })),
  };
}

function emptyPlanData() {
  return { counts: { active: 0, backlog: 0 }, active: [], recent: [] };
}

function mockRepositorySummaries() {
  return new Map(MOCK_REPOSITORY_IDS.map((repositoryId) => {
    const displayName = repositoryId.split("/").at(-1);
    return [repositoryId, {
      id: repositoryId,
      repositoryId,
      name: MOCK_DISPLAY_NAMES[repositoryId] || displayName,
      providerUrl: `https://github.com/example/${displayName}`,
      gitHead: "mock123",
      branch: "main",
      gitAvailable: true,
    }];
  }));
}

function mockPlanRecord(definition, repository, now) {
  const taskCounts = definition.taskCounts;
  const openTasks = Array.from({ length: Math.max(0, taskCounts.total - taskCounts.complete) }, (_, index) => ({ done: false, text: `${definition.title} task ${index + 1}`, line: index + 2 }));
  const plan = {
    id: definition.id,
    title: definition.title,
    relativePath: definition.relativePath,
    lifecycle: definition.lifecycle,
    readiness: "ready",
    priority: definition.priority,
    nextAction: definition.nextAction,
    blockers: [],
    dependencies: [],
    related: [],
    reviewedCommit: "mock123",
    worktree: definition.worktree,
    reviewState: "current",
    modifiedAt: definition.changedAt,
    gitLastChangedAt: definition.changedAt,
    gitStatus: "clean",
    taskCounts: { ...taskCounts, remaining: taskCounts.total - taskCounts.complete },
    openTasks,
    headings: [{ depth: 1, text: definition.title, line: 1, hasContent: true }],
    excerpt: definition.excerpt,
    validation: { valid: true, findings: [], warnings: [] },
  };
  return { key: `mock:${definition.id}`, mtimeMs: 0, repository, plan, generatedAt: now };
}

function checkout(rootId, branch, projectRoot, { port = null, kind = null, worktree = false, dirty = false, detached = false } = {}) {
  return {
    rootId,
    name: branch,
    isWorktree: worktree,
    worktreeName: worktree ? branch : null,
    projectRoot,
    checkoutState: "present",
    checkoutReason: null,
    git: {
      branch,
      detached,
      shortHead: "mock123",
      dirty,
      ahead: 0,
      behind: 0,
      upstream: "origin/main",
      baseBranch: "origin/main",
      baseBehind: 0,
      baseMergeBaseAt: null,
      upstreamTipAt: null,
      fetchedAt: null,
      provider: { ok: true },
    },
    primaryEntrypoint: port ? { kind, opaqueKey: `mock-${rootId}`, origin: `http://127.0.0.1:${port}`, port, links: [] } : null,
  };
}

function warning(kind, sessionId) {
  return { kind, severity: kind === "read-warning" ? "warn" : "high", sessionId, harness: "mock", model: "RoboRepo demo", at: "2026-01-01T00:00:00.000Z" };
}
