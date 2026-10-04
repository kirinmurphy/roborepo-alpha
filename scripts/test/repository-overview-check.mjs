#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  defaultRegistry,
  hideRepository,
  pinRepository,
  recordDiscovery,
  registerLocalRoot,
  setAlias,
  upsertRepository,
  validateRegistry,
} from "../../modules/repositories/index.mjs";
import { createRepositoryOverviewService } from "../cli/repository-overview.mjs";
import { fixtureTelemetryRepositories, homeTelemetryProjection } from "../cli/telemetry-repository-overview.mjs";
import { validateCaptureV3 } from "../cli/telemetry-schemas/capture-schema-v3.mjs";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const ACTIVE = "git:github.com/example/active";
const PINNED = "git:github.com/example/pinned";
const STALE = "local:aaaaaaaaaaaaaaaa";
const HIDDEN = "local:bbbbbbbbbbbbbbbb";
const IDLE_RECENT = "local:cccccccccccccccc";
const IDLE_OLD = "local:dddddddddddddddd";

const registry = defaultRegistry();
addRepository(ACTIVE, "Active App", "2026-09-30T11:00:00.000Z");
addRepository(PINNED, "Pinned App", "2026-09-29T11:00:00.000Z");
addRepository(STALE, "Stale App", "2026-07-01T11:00:00.000Z");
addRepository(HIDDEN, "Hidden App", "2026-09-30T10:00:00.000Z");
addRepository(IDLE_RECENT, "Recent Idle", "2026-09-28T10:00:00.000Z");
addRepository(IDLE_OLD, "Old Idle", "2026-09-20T10:00:00.000Z");
pinRepository(registry, PINNED, { pinned: true, now: NOW.toISOString() });
hideRepository(registry, HIDDEN, { hidden: true, now: NOW.toISOString() });
validateRegistry(registry);

const runtime = {
  generatedAt: "2026-09-30T11:59:00.000Z",
  refresh: { state: "idle", error: null },
  repositories: [
    {
      repositoryId: ACTIVE,
      name: "Active App",
      lifecycle: { state: "active", reason: null },
      roots: [{
        isWorktree: true,
        projectRoot: "/private/worktrees/active-feature",
        members: [{ secondaryPorts: [9999] }],
        git: { branch: "feature/home", dirty: true, ahead: 2, behind: 1, baseBranch: "origin/main", baseBehind: 3, fetchedAt: 123 },
        primaryEntrypoint: { kind: "container", opaqueKey: "secret-runtime-key", origin: "http://127.0.0.1:4317", port: 4317 },
      }],
    },
    { repositoryId: PINNED, name: "Pinned App", lifecycle: { state: "idle", reason: null }, lastSeenAt: "2026-09-29T11:00:00.000Z", roots: [] },
    { repositoryId: STALE, name: "Stale App", lifecycle: { state: "stale", reason: "checkout missing" }, lastSeenAt: "2026-07-01T11:00:00.000Z", roots: [] },
    { repositoryId: IDLE_RECENT, name: "Recent Idle", lifecycle: { state: "idle", reason: null }, lastSeenAt: "2026-09-28T10:00:00.000Z", roots: [] },
    { repositoryId: IDLE_OLD, name: "Old Idle", lifecycle: { state: "idle", reason: null }, lastSeenAt: "2026-09-20T10:00:00.000Z", roots: [] },
    { repositoryId: null, name: "Unresolved listener", lifecycle: { state: "active", reason: null }, roots: [{ projectRoot: "/private/unresolved" }] },
  ],
};

const plans = {
  truncated: false,
  errors: [],
  repositories: [{ repositoryId: ACTIVE }],
  plans: [
    { repository: { repositoryId: ACTIVE }, plan: { id: "active-plan", title: "Active plan", lifecycle: "active", taskCounts: { total: 8, complete: 3 }, gitLastChangedAt: "2026-09-29T12:00:00.000Z", modifiedAt: "2026-09-20T12:00:00.000Z" } },
    { repository: { repositoryId: ACTIVE }, plan: { id: "backlog-plan", title: "Backlog plan", lifecycle: "backlog", gitLastChangedAt: null, modifiedAt: "2026-09-28T12:00:00.000Z" } },
    { repository: { repositoryId: ACTIVE }, plan: { id: "old-plan", title: "Old plan", lifecycle: "completed", gitLastChangedAt: "2026-09-23T11:59:59.999Z", modifiedAt: null } },
    { repository: { repositoryId: ACTIVE }, plan: { id: "future-plan", title: "Future plan", lifecycle: "completed", gitLastChangedAt: "2026-10-01T12:00:00.000Z", modifiedAt: null } },
  ],
};

const telemetry = {
  status: "available",
  updatedAt: "2026-09-30T11:58:00.000Z",
  repositories: {
    [ACTIVE]: { sessionCount: 3, warningCount: 2, highestSeverity: "high", recent: [{ kind: "spike", severity: "high", sessionId: "s1", at: "2026-09-30T11:00:00.000Z" }] },
  },
};

const service = createRepositoryOverviewService({
  loadRegistry: () => structuredClone(registry),
  loadRuntime: () => structuredClone(runtime),
  loadPlans: () => structuredClone(plans),
  loadTelemetry: () => structuredClone(telemetry),
  now: () => NOW,
});

const home = service.loadHome();
assert.deepEqual(home.repositories.map((repository) => repository.repositoryId), [PINNED, ACTIVE, IDLE_RECENT, IDLE_OLD, STALE], "pinning outranks lifecycle and idle repositories sort by recency");
assert.equal(home.unresolvedActivity.length, 1);
assert.equal(home.unresolvedActivity[0].name, "Unresolved listener");
assert.equal(home.repositories.some((repository) => repository.repositoryId === HIDDEN), false, "hidden repositories stay out of Home");

const active = home.repositories.find((repository) => repository.repositoryId === ACTIVE);
assert.equal(active.urlKey, "active-app");
assert.equal(active.domains.runtime.data.checkouts[0].primaryEntrypoint.kind, "container", "container and host entrypoints share the same projection");
assert.equal(active.domains.runtime.data.checkouts[0].primaryEntrypoint.port, 4317);
assert.equal(active.domains.runtime.data.checkouts[0].primaryEntrypoint.opaqueKey, "secret-runtime-key", "Home reuses the promoted app key for route discovery");
assert.equal(JSON.stringify(active).includes("9999"), false, "secondary ports are absent from the overview payload");
assert.equal(active.domains.git.data.warnings.length, 3);
assert.deepEqual(active.domains.plans.data.counts, { active: 1, backlog: 1 });
assert.equal(active.domains.plans.data.recent[0].changedAt, "2026-09-29T12:00:00.000Z", "Git last-change time wins over mtime");
assert.deepEqual(active.domains.plans.data.recent.map((plan) => plan.id), ["active-plan", "backlog-plan"], "recent plans stay inside the trailing seven-day window");
assert.equal(active.domains.tokens.data.warningCount, 2);
assert.equal(active.domains.tokens.data.warnings[0].kind, "spike");
assert.deepEqual(active.domains.plans.data.active[0].taskCounts, { total: 8, complete: 3 });
assert.equal("additionalActive" in active.domains.plans.data, false, "plans are no longer split into a leftover list");
assert.equal(active.domains.agents.status, "unavailable");
assert.equal(home.repositories.find((repository) => repository.repositoryId === PINNED).domains.plans.status, "unavailable", "unscanned Plans coverage is not reported as zero");
assert.equal(active.domains.runtime.data.checkouts[0].projectRoot, "/private/worktrees/active-feature", "shared checkout tooltips and copy controls receive the checkout path");

const detail = service.loadDetail({ urlKey: "active-app" });
assert.equal(detail.repository.repositoryId, ACTIVE);
assert.equal(detail.repository.identity.localRoots.length, 1);
assert.throws(() => service.loadDetail({ urlKey: "hidden-app" }), /unknown repository/, "hidden urlKeys return not found");
assert.throws(() => service.loadDetail({ urlKey: "missing" }), /unknown repository/);

const aliasRegistry = structuredClone(registry);
const aliasId = "local:eeeeeeeeeeeeeeee";
upsertRepository(aliasRegistry, { id: aliasId, kind: "local", displayName: "Active Alias", now: NOW.toISOString() });
setAlias(aliasRegistry, aliasId, ACTIVE, { now: NOW.toISOString() });
const aliasRuntime = structuredClone(runtime);
aliasRuntime.repositories.find((repository) => repository.repositoryId === ACTIVE).repositoryId = aliasId;
const aliasPlans = structuredClone(plans);
aliasPlans.repositories[0].repositoryId = aliasId;
for (const plan of aliasPlans.plans) plan.repository.repositoryId = aliasId;
const aliasTelemetry = structuredClone(telemetry);
aliasTelemetry.repositories[aliasId] = aliasTelemetry.repositories[ACTIVE];
delete aliasTelemetry.repositories[ACTIVE];
const aliasedHome = createRepositoryOverviewService({
  loadRegistry: () => aliasRegistry,
  loadRuntime: () => aliasRuntime,
  loadPlans: () => aliasPlans,
  loadTelemetry: () => aliasTelemetry,
  now: () => NOW,
}).loadHome();
const aliasedActive = aliasedHome.repositories.find((repository) => repository.repositoryId === ACTIVE);
assert.equal(aliasedHome.repositories.some((repository) => repository.repositoryId === aliasId), false, "aliases do not create duplicate cards");
assert.equal(aliasedActive.domains.runtime.data.checkouts.length, 1, "Runtime data joins through canonical aliases");
assert.equal(aliasedActive.domains.plans.data.counts.active, 1, "Plans data joins through canonical aliases");
assert.equal(aliasedActive.domains.tokens.data.sessionCount, 3, "Tokens data joins through canonical aliases");

const staleRuntime = structuredClone(runtime);
staleRuntime.refresh = { state: "failed", error: "Docker timed out" };
const staleHome = createRepositoryOverviewService({
  loadRegistry: () => structuredClone(registry),
  loadRuntime: () => staleRuntime,
  loadPlans: () => structuredClone(plans),
  loadTelemetry: () => structuredClone(telemetry),
  now: () => NOW,
}).loadHome();
assert.equal(staleHome.repositories.find((repository) => repository.repositoryId === ACTIVE).domains.runtime.status, "stale");
assert.equal(staleHome.repositories.find((repository) => repository.repositoryId === ACTIVE).domains.runtime.data.checkouts.length, 1, "stale envelopes preserve last-known data");

let domainCalls = 0;
const degraded = createRepositoryOverviewService({
  loadRegistry: () => structuredClone(registry),
  loadRuntime: () => { domainCalls += 1; throw new Error("runtime offline"); },
  loadPlans: () => { domainCalls += 1; throw new Error("plans offline"); },
  loadTelemetry: () => { domainCalls += 1; throw new Error("tokens offline"); },
  now: () => NOW,
}).loadHome();
assert.equal(domainCalls, 3, "each bounded domain loader runs once");
assert.equal(degraded.repositories.length, 5, "domain failures never remove repository anchors");
assert.equal(degraded.repositories[0].domains.runtime.status, "unavailable");
assert.equal(degraded.repositories[0].domains.plans.status, "unavailable");
assert.equal(degraded.repositories[0].domains.tokens.status, "unavailable");

// Home order: pinned, running real repositories, running fixtures, idle real repositories, idle
// fixtures. The fixtures above all carry the github.com/example prefix, so this mixes in real ids.
const REAL_ACTIVE = "git:github.com/acme/real-active";
const REAL_IDLE = "git:github.com/acme/real-idle";
const REAL_PINNED_IDLE = "git:github.com/acme/real-pinned";
const FIXTURE_IDLE = "git:github.com/example/fixture-idle";
const groupedRegistry = defaultRegistry();
for (const [id, name] of [[REAL_ACTIVE, "Real Active"], [REAL_IDLE, "Zebra Idle"], [REAL_PINNED_IDLE, "Real Pinned"], [FIXTURE_IDLE, "Fixture Idle"], [ACTIVE, "Active App"]]) {
  addRepository(id, name, "2026-09-30T11:00:00.000Z", groupedRegistry);
}
pinRepository(groupedRegistry, REAL_PINNED_IDLE, { pinned: true, now: NOW.toISOString() });
const groupedRuntime = {
  generatedAt: NOW.toISOString(),
  refresh: { state: "idle", error: null },
  repositories: [
    { repositoryId: REAL_ACTIVE, name: "Real Active", lifecycle: { state: "active", reason: null }, roots: [] },
    { repositoryId: ACTIVE, name: "Active App", lifecycle: { state: "active", reason: null }, roots: [] },
    { repositoryId: FIXTURE_IDLE, name: "Fixture Idle", lifecycle: { state: "idle", reason: null }, roots: [] },
    { repositoryId: REAL_IDLE, name: "Zebra Idle", lifecycle: { state: "idle", reason: null }, roots: [] },
    { repositoryId: REAL_PINNED_IDLE, name: "Real Pinned", lifecycle: { state: "idle", reason: null }, roots: [] },
  ],
};
const grouped = createRepositoryOverviewService({
  loadRegistry: () => structuredClone(groupedRegistry),
  loadRuntime: () => structuredClone(groupedRuntime),
  loadPlans: () => ({ truncated: false, errors: [], repositories: [], plans: [] }),
  loadTelemetry: () => ({ status: "available", repositories: {} }),
  now: () => NOW,
}).loadHome();
assert.deepEqual(
  grouped.repositories.map((repository) => repository.repositoryId),
  [REAL_PINNED_IDLE, REAL_ACTIVE, ACTIVE, REAL_IDLE, FIXTURE_IDLE],
  "Home orders pinned, active, active fixtures, idle, then idle fixtures",
);
assert.equal(grouped.repositories.find((repository) => repository.repositoryId === FIXTURE_IDLE).fixture, true);
assert.equal(grouped.repositories.find((repository) => repository.repositoryId === REAL_IDLE).fixture, false);

// Plan/worktree association: exact `worktree` name against Runtime's administrative worktree name.
// Non-destructive: both lists stay complete, and a safe match only adds `checkoutRootId` to the plan.
const ASSOC = "git:github.com/acme/associated";
const associationRegistry = defaultRegistry();
addRepository(ASSOC, "Associated", "2026-09-30T11:00:00.000Z", associationRegistry);
const worktreeRoot = (rootId, name, branch) => ({ rootId, isWorktree: true, projectRoot: `/private/${rootId}`, git: { branch, worktreeName: name } });
const associationRuntime = {
  generatedAt: NOW.toISOString(),
  refresh: { state: "idle", error: null },
  repositories: [{
    repositoryId: ASSOC,
    name: "Associated",
    lifecycle: { state: "active", reason: null },
    roots: [
      // A main checkout never matches, even if something upstream handed it a name.
      { rootId: "main", isWorktree: false, projectRoot: "/private/main", git: { branch: "main", worktreeName: "main-claim" } },
      worktreeRoot("matched", "feature-a", "feature/a"),
      worktreeRoot("contested", "contested", "feature/contested"),
      worktreeRoot("dup-1", "dup", "feature/dup-1"),
      worktreeRoot("dup-2", "dup", "feature/dup-2"),
      worktreeRoot("planless", "planless", "feature/planless"),
      // Unreferenceable: no rootId, so it never matches; its twin with the same name is ambiguous.
      worktreeRoot(null, "unrooted", "feature/unrooted"),
      worktreeRoot(null, "half-rooted", "feature/half-rooted-1"),
      worktreeRoot("half-rooted", "half-rooted", "feature/half-rooted-2"),
    ],
  }],
};
const assocPlan = (id, worktree, lifecycle = "active") => ({
  repository: { repositoryId: ASSOC },
  key: `key-${id}`,
  plan: { id, title: `Plan ${id}`, lifecycle, worktree, taskCounts: { total: 2, complete: 1 }, gitLastChangedAt: "2026-09-29T12:00:00.000Z" },
});
const associationPlans = {
  truncated: false,
  errors: [],
  repositories: [{ repositoryId: ASSOC }],
  plans: [
    assocPlan("matched", "feature-a"),
    assocPlan("unassociated", ""),
    assocPlan("missing-worktree", "removed-worktree"),
    assocPlan("main-claim", "main-claim"),
    assocPlan("contested-1", "contested"),
    assocPlan("contested-2", "contested"),
    assocPlan("dup-claim", "dup"),
    assocPlan("backlog-claim", "planless", "backlog"),
    assocPlan("unrooted", "unrooted"),
    assocPlan("half-rooted", "half-rooted"),
  ],
};
const loadAssociation = ({ runtime: runtimeData = associationRuntime, plans: plansData = associationPlans } = {}) => createRepositoryOverviewService({
  loadRegistry: () => structuredClone(associationRegistry),
  loadRuntime: () => { if (!runtimeData) throw new Error("runtime offline"); return structuredClone(runtimeData); },
  loadPlans: () => { if (!plansData) throw new Error("plans offline"); return structuredClone(plansData); },
  loadTelemetry: () => ({ status: "available", repositories: {} }),
  now: () => NOW,
}).loadHome().repositories.find((repository) => repository.repositoryId === ASSOC);

const associated = loadAssociation();
const runtimeCheckouts = associated.domains.runtime.data.checkouts;
const activePlans = associated.domains.plans.data.active;
assert.deepEqual(activePlans.map((plan) => plan.id),
  ["contested-1", "contested-2", "dup-claim", "half-rooted", "main-claim", "matched", "missing-worktree", "unassociated", "unrooted"],
  "every active plan appears exactly once, in the existing order (newest change, then title)");
assert.deepEqual(Object.fromEntries(activePlans.map((plan) => [plan.id, plan.checkoutRootId ?? null])), {
  "contested-1": null, "contested-2": null, "dup-claim": null, "half-rooted": null, "main-claim": null,
  matched: "matched", "missing-worktree": null, unassociated: null, unrooted: null,
}, "only a unique plan claim on a unique, referenceable linked worktree matches; main checkouts, contested names, duplicate worktrees, null rootIds, and backlog plans never do");
assert.deepEqual(runtimeCheckouts.map((checkout) => checkout.rootId), ["main", "matched", "contested", "dup-1", "dup-2", "planless", null, null, "half-rooted"],
  "every Runtime checkout stays in the list, matched or not");
assert.equal(runtimeCheckouts.some((checkout) => "plan" in checkout), false, "checkouts carry no plan; the plan references the checkout");
assert.equal(runtimeCheckouts.find((checkout) => checkout.rootId === "main").worktreeName, null, "main checkouts expose no worktree name");
assert.equal(runtimeCheckouts.find((checkout) => checkout.rootId === "matched").worktreeName, "feature-a");
assert.deepEqual(activePlans.find((plan) => plan.id === "matched"),
  { id: "matched", key: "key-matched", title: "Plan matched", lifecycle: "active", changedAt: "2026-09-29T12:00:00.000Z", worktree: "feature-a", taskCounts: { total: 2, complete: 1 }, checkoutRootId: "matched" },
  "a match adds only checkoutRootId: no branch, path, process, Links, or Git fields are copied onto the plan");
assert.equal("additionalActive" in associated.domains.plans.data, false);
assert.deepEqual(associated.domains.plans.data.counts, { active: 9, backlog: 1 }, "repository-wide counts are unchanged by matching");
assert.equal(associated.domains.git.data.checkouts.some((checkout) => "plan" in checkout), false, "the git domain carries no plan either");

const partialAssociation = loadAssociation({ plans: { ...associationPlans, truncated: true } });
assert.equal(partialAssociation.domains.plans.status, "partial");
assert.equal(partialAssociation.domains.plans.message, "Plans coverage is incomplete");
assert.equal(partialAssociation.domains.plans.data.active.find((plan) => plan.id === "matched").checkoutRootId, "matched", "partial coverage still matches what it has");

const plansOffline = loadAssociation({ plans: null });
assert.equal(plansOffline.domains.plans.status, "unavailable");
assert.deepEqual(plansOffline.domains.runtime.data.checkouts, runtimeCheckouts, "unavailable Plans data leaves every checkout unchanged");

const runtimeOffline = loadAssociation({ runtime: null });
assert.equal(runtimeOffline.domains.runtime.status, "unavailable");
assert.equal(runtimeOffline.domains.plans.data.active.length, 9, "without Runtime every active plan is still listed");
assert.equal(runtimeOffline.domains.plans.data.active.some((plan) => "checkoutRootId" in plan), false, "without Runtime no match is invented");

// Tokens follow the capture switch: with capture off, a real repository's Tokens domain is
// unavailable even though an older spool still projects warnings for it. Dev fixture repositories
// get their warnings from the committed fixture spool either way.
const SHARED_FIXTURE = "git:github.com/example/shared-stack-fixture";
const MULTI_FIXTURE = "git:github.com/example/multi-member-fixture";
const IDLE_FIXTURE = "git:github.com/example/idle-checkout-fixture";
const TOKENS_REAL = "git:github.com/acme/tokens-real";
const fixtureSpool = fs.readFileSync(new URL("../../local/dev-fixtures/token-warnings-spool.jsonl", import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((line) => JSON.parse(line));
for (const row of fixtureSpool) {
  assert.equal(row.schema, 3, "the fixture spool uses the schema real captures write");
  validateCaptureV3(row);
}
const fixtureRepositories = fixtureTelemetryRepositories(fixtureSpool);
assert.deepEqual(
  Object.fromEntries(Object.entries(fixtureRepositories).map(([id, summary]) => [id, summary.warningCount])),
  { [SHARED_FIXTURE]: 2, [MULTI_FIXTURE]: 6, [IDLE_FIXTURE]: 0 },
  "the fixture spool runs through the real analysis and lands on the three dev fixtures",
);
const relabeled = fixtureSpool.map((row) => ({ ...row, repo: { ...row.repo, repository_id: TOKENS_REAL } }));
assert.deepEqual(fixtureTelemetryRepositories(relabeled), {}, "fixture rows naming a real repository are dropped");

const tokensRegistry = defaultRegistry();
for (const [id, name] of [[TOKENS_REAL, "Tokens Real"], [SHARED_FIXTURE, "shared-stack-fixture"]]) {
  upsertRepository(tokensRegistry, { id, kind: "git", displayName: name, now: NOW.toISOString() });
  recordDiscovery(tokensRegistry, id, { source: "developer-runtime", evidence: "git-remote", confidence: "high", now: NOW.toISOString() });
}
const spoolProjection = {
  status: "available",
  updatedAt: "2026-09-30T11:58:00.000Z",
  repositories: { [TOKENS_REAL]: { sessionCount: 3, warningCount: 2, highestSeverity: "high", recent: [] } },
};
const loadTokens = (enabled) => {
  const repositories = createRepositoryOverviewService({
    loadRegistry: () => structuredClone(tokensRegistry),
    loadRuntime: () => null,
    loadPlans: () => null,
    loadTelemetry: () => homeTelemetryProjection({ enabled, projection: structuredClone(spoolProjection), fixtureRepositories }),
    now: () => NOW,
  }).loadHome().repositories;
  return (id) => repositories.find((repository) => repository.repositoryId === id).domains.tokens;
};
const captureOff = loadTokens(false);
assert.deepEqual(captureOff(TOKENS_REAL), { status: "unavailable", updatedAt: null, data: null, message: "Token tracking is off" }, "capture off hides an older spool's warnings");
assert.equal(captureOff(SHARED_FIXTURE).status, "available");
assert.equal(captureOff(SHARED_FIXTURE).data.warningCount, 2, "a dev fixture shows its fixture warnings with capture off");
const captureOn = loadTokens(true);
assert.equal(captureOn(TOKENS_REAL).data.warningCount, 2, "capture on shows the spool's warnings");
assert.equal(captureOn(SHARED_FIXTURE).data.warningCount, 2, "a dev fixture keeps its fixture warnings with capture on");

console.log("repository-overview-check passed");

function addRepository(id, name, seenAt, target = registry) {
  const kind = id.startsWith("git:") ? "git" : "local";
  upsertRepository(target, { id, kind, displayName: name, now: seenAt });
  recordDiscovery(target, id, { source: "developer-runtime", evidence: "git-remote", confidence: kind === "git" ? "high" : "medium", now: seenAt });
  registerLocalRoot(target, id, { rootId: id.slice(-8).replace(/[^a-z0-9]/g, "a"), now: seenAt });
}
