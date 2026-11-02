#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createPrivateKey, X509Certificate } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createLocalTestTls } from "./lib/local-test-tls.mjs";
import {
  buildDeveloperRuntimeSnapshot,
  capabilityForPlatform,
  discoverListenerRecords,
  discoverInstances,
  findCurrentInstanceByOpaqueKey,
  isTlsTrustErrorCode,
  originCandidatesForListener,
  loadSettings,
  normalizeGitRemote,
  normalizeRoutePath,
  parseLsofFieldOutput,
  probeHttpCandidate,
  resolveProjectIdentity,
  resolveProjectAlias,
  settingsPathFor,
  toInstance,
  updateSettings,
  validateSettings,
} from "../../modules/developer-runtime/index.mjs";
import { collectIdleMainCheckouts, markDeveloperRuntimeRefreshFailed } from "../cli/developer-runtime.mjs";
import { canonicalRepositoryId, rootId as computeRootId } from "../../modules/repositories/identity.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "developer-runtime-"));
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
// Docker/process-metrics providers are exercised in their own fixture-driven check scripts; core
// discovery tests here stub them to no-ops so they stay hermetic and don't shell out to a real
// `docker`/`ps` binary just because this machine happens to have one.
const noProviders = {
  discoverDocker: async () => ({ warnings: [], containers: [] }),
  collectProcess: async () => new Map(),
};
try {
  assert.equal(originCandidatesForListener({ address: "*", port: 443 })[0].origin, "https://localhost");
  assert.equal(originCandidatesForListener({ address: "127.0.0.1", port: 8080 })[0].protocol, "http");
  assert.equal(capabilityForPlatform("win32").discovery, "unsupported");
  assert.match(capabilityForPlatform("win32").message, /Windows/);
  assert.equal(capabilityForPlatform("darwin").providers.listeners.state, "supported");
  assert.equal(capabilityForPlatform("darwin").providers.docker.state, "supported");
  assert.equal(capabilityForPlatform("darwin").providers.processMetrics.state, "supported");
  assert.ok(capabilityForPlatform("darwin").unavailable.includes("metadata"));
  assert.ok(!capabilityForPlatform("darwin").unavailable.includes("docker"));
  assert.equal(capabilityForPlatform("linux").providers.docker.state, "unsupported");

  const listeners = parseLsofFieldOutput([
    "p101",
    "cnode",
    "n127.0.0.1:5173",
    "n127.0.0.1:5173",
    "p202",
    "cpython",
    "n*:8000",
    "p303",
    "cpostgres",
    "n[::1]:5432",
    "p404",
    "cbad",
    "n127.0.0.1:0",
  ].join("\n"));
  assert.equal(listeners.length, 3);
  assert.equal(listeners[0].bindScope, "loopback");
  assert.equal(listeners[1].bindScope, "wildcard");
  assert.equal(listeners[2].address, "::1");
  const listenerRecords = await discoverListenerRecords({
    platform: "darwin",
    runCommand: async (command, args) => {
      if (args.includes("-iTCP")) return { stdout: ["p101", "cnode", "n127.0.0.1:5173"].join("\n") };
      if (args.includes("101")) return { stdout: "n/tmp/manual-app\n" };
      throw new Error("unexpected command");
    },
  });
  assert.equal(listenerRecords.records.length, 1);
  assert.equal(listenerRecords.records[0].cwd, "/tmp/manual-app");

  assert.equal(normalizeGitRemote("git@github.com:KirinMurphy/Visa_Planner.git"), "git:github.com/KirinMurphy/Visa_Planner");
  assert.equal(normalizeGitRemote("https://token@github.com/kirinmurphy/visa_planner.git?x=1#frag"), "git:github.com/kirinmurphy/visa_planner");
  assert.equal(normalizeGitRemote("not a remote"), null);

  const repo = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "config"), `[remote "origin"]\n  url = git@github.com:kirinmurphy/visa_planner.git\n`);
  const appDir = path.join(repo, "apps", "web");
  fs.mkdirSync(appDir, { recursive: true });
  const identity = resolveProjectIdentity(appDir, "node");
  assert.equal(identity.identity, "git:github.com/kirinmurphy/visa_planner");
  assert.equal(identity.confidence, "high");

  const worktree = path.join(tempRoot, "worktree");
  const gitDir = path.join(tempRoot, "actual-git");
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  fs.writeFileSync(path.join(gitDir, "config"), `[remote "origin"]\n  url = https://github.com/kirinmurphy/worktree.git\n`);
  assert.equal(resolveProjectIdentity(worktree, "node").identity, "git:github.com/kirinmurphy/worktree");

  assert.equal(normalizeRoutePath("/admin?x=1#top"), "/admin?x=1#top");
  assert.equal(normalizeRoutePath("http://localhost:5173/resume?draft=1"), "/resume?draft=1");
  assert.throws(() => normalizeRoutePath("https://example.com/admin"), /loopback/);
  assert.throws(() => normalizeRoutePath("//example.com/admin"), /protocol-relative/);
  assert.throws(() => normalizeRoutePath("http://u:p@localhost/admin"), /credentials/);
  assert.equal(isTlsTrustErrorCode("DEPTH_ZERO_SELF_SIGNED_CERT"), true);
  assert.equal(isTlsTrustErrorCode("ECONNREFUSED"), false);

  const stateRoot = path.join(tempRoot, "state");
  assert.deepEqual(loadSettings({ stateRoot }), {
    version: 2,
    revision: 1,
    projects: {},
    associations: {},
    aliases: {},
    composeProjects: {},
    preferences: { showNonHttp: false, historyRetentionDays: 14, worktreeStaleDays: 7 },
  });
  const thresholdStateRoot = path.join(tempRoot, "threshold-state");
  const threshold = updateSettings({ stateRoot: thresholdStateRoot, input: { revision: 1, type: "preferences", worktreeStaleDays: 3 } });
  assert.equal(threshold.preferences.worktreeStaleDays, 3);
  assert.throws(() => updateSettings({ stateRoot: thresholdStateRoot, input: { revision: 2, type: "preferences", worktreeStaleDays: 0 } }), /between 1 and 365/);
  // New repoPath input follows the repository path rule, but a traversal path saved before that
  // rule existed must still load: loadSettings throws on invalid values, which would stop Runtime.
  const repoPathStateRoot = path.join(tempRoot, "repo-path-state");
  assert.throws(() => updateSettings({ stateRoot: repoPathStateRoot, input: { revision: 1, type: "composeProject", composeProject: "stack", repoPath: "/work/../repo" } }), /traversal segments/);
  fs.mkdirSync(path.dirname(settingsPathFor(repoPathStateRoot)), { recursive: true });
  fs.writeFileSync(settingsPathFor(repoPathStateRoot), `${JSON.stringify({ ...loadSettings({ stateRoot: repoPathStateRoot }), composeProjects: { stack: { repoPath: "/work/../repo" } } })}\n`);
  assert.equal(loadSettings({ stateRoot: repoPathStateRoot }).composeProjects.stack.repoPath, "/work/../repo");
  const renamedStack = updateSettings({ stateRoot: repoPathStateRoot, input: { revision: 1, type: "composeProject", composeProject: "stack", name: "Stack" } });
  assert.equal(renamedStack.composeProjects.stack.repoPath, "/work/../repo", "an unrelated edit must not be blocked by a stored traversal path");
  const olderStateRoot = path.join(tempRoot, "older-state");
  fs.mkdirSync(path.dirname(settingsPathFor(olderStateRoot)), { recursive: true });
  fs.writeFileSync(settingsPathFor(olderStateRoot), `${JSON.stringify({ version: 1, revision: 7, projects: {}, associations: {} })}\n`);
  assert.throws(() => loadSettings({ stateRoot: olderStateRoot }), /unsupported developer-runtime settings version: 1/);
  const updated = updateSettings({
    stateRoot,
    input: {
      revision: 1,
      type: "links",
      projectIdentity: "git:github.com/kirinmurphy/visa_planner",
      appId: "web",
      links: [{ id: "admin", label: "Admin", path: "http://localhost:5173/admin" }],
    },
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.projects["git:github.com/kirinmurphy/visa_planner"].apps.web.links[0].path, "/admin");
  const reordered = updateSettings({
    stateRoot,
    input: {
      revision: 2,
      type: "links",
      projectIdentity: "git:github.com/kirinmurphy/visa_planner",
      appId: "web",
      links: [
        { id: "resume", label: "Resume", path: "/resume" },
        { id: "admin", label: "Admin area", path: "/admin?tab=users" },
      ],
    },
  });
  assert.equal(reordered.revision, 3);
  assert.deepEqual(
    reordered.projects["git:github.com/kirinmurphy/visa_planner"].apps.web.links.map((link) => [link.id, link.label, link.path]),
    [["resume", "Resume", "/resume"], ["admin", "Admin area", "/admin?tab=users"]],
  );
  const renamed = updateSettings({
    stateRoot,
    input: {
      revision: 3,
      type: "project",
      projectIdentity: "git:github.com/kirinmurphy/visa_planner",
      name: "Visa Planner Local",
      favorite: true,
      appId: "web",
      appName: "Frontend",
      appFavorite: true,
      health: { path: "http://localhost:5173/health", acceptedStatuses: [200, 204] },
      match: { process: ["node"], title: ["Visa Planner"] },
      originPreference: "127.0.0.1",
    },
  });
  assert.equal(renamed.projects["git:github.com/kirinmurphy/visa_planner"].name, "Visa Planner Local");
  assert.equal(renamed.projects["git:github.com/kirinmurphy/visa_planner"].favorite, true);
  assert.equal(renamed.projects["git:github.com/kirinmurphy/visa_planner"].apps.web.name, "Frontend");
  assert.equal(renamed.projects["git:github.com/kirinmurphy/visa_planner"].apps.web.favorite, true);
  assert.equal(renamed.projects["git:github.com/kirinmurphy/visa_planner"].apps.web.health.path, "/health");
  assert.deepEqual(renamed.projects["git:github.com/kirinmurphy/visa_planner"].apps.web.match.title, ["Visa Planner"]);
  assert.equal(renamed.projects["git:github.com/kirinmurphy/visa_planner"].apps.web.originPreference, "127.0.0.1");
  assert.ok(fs.existsSync(settingsPathFor(stateRoot)));
  assert.equal(resolveProjectAlias({}, "compose:my_stack"), "compose:my_stack");
  assert.equal(resolveProjectAlias({}, "roborepo:portal"), "roborepo:portal");
  assert.throws(() => updateSettings({ stateRoot, input: { revision: 1, type: "project", projectIdentity: "git:github.com/x/y", name: "Y" } }), /revision conflict/);
  assert.throws(() => validateSettings({ version: 2, revision: 1, projects: {}, associations: {}, aliases: {}, composeProjects: {}, preferences: { showNonHttp: false, historyRetentionDays: 14 }, future: true }), /unknown/);
  assert.throws(() => validateSettings({ version: 2, revision: 1, projects: { "git:github.com/x/y": { apps: { web: { links: [{ id: "x", label: "X", path: "/x" }, { id: "x", label: "X2", path: "/x2" }] } } } }, associations: {}, aliases: {}, composeProjects: {}, preferences: { showNonHttp: false, historyRetentionDays: 14 } }), /duplicate/);
  const aliased = updateSettings({
    stateRoot,
    input: {
      revision: 4,
      type: "alias",
      from: "path:/tmp/visa_planner",
      to: "git:github.com/kirinmurphy/visa_planner",
      confirmed: true,
    },
  });
  assert.equal(aliased.aliases["path:/tmp/visa_planner"], "git:github.com/kirinmurphy/visa_planner");
  assert.throws(() => updateSettings({ stateRoot, input: { revision: 5, type: "alias", from: "git:github.com/kirinmurphy/visa_planner", to: "path:/tmp/visa_planner", confirmed: true } }), /cycles/);
  const associationRemoved = updateSettings({ stateRoot, input: { revision: 5, type: "association", associationKey: "alegacy", remove: true } });
  assert.equal(associationRemoved.associations.alegacy, undefined);
  assert.equal(associationRemoved.projects["git:github.com/kirinmurphy/visa_planner"].apps.web.links.length, 2);
  const aliasMergeStateRoot = path.join(tempRoot, "alias-merge-state");
  const pathSettings = updateSettings({
    stateRoot: aliasMergeStateRoot,
    input: {
      revision: 1,
      type: "links",
      projectIdentity: "path:/tmp/alias-project",
      appId: "web",
      links: [{ id: "old-home", label: "Old Home", path: "/old" }],
    },
  });
  const mergedAlias = updateSettings({
    stateRoot: aliasMergeStateRoot,
    input: {
      revision: pathSettings.revision,
      type: "alias",
      from: "path:/tmp/alias-project",
      to: "git:github.com/kirinmurphy/alias-project",
      confirmed: true,
    },
  });
  assert.equal(mergedAlias.projects["path:/tmp/alias-project"], undefined);
  assert.equal(mergedAlias.projects["git:github.com/kirinmurphy/alias-project"].apps.web.links[0].path, "/old");

  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args.includes("-iTCP")) {
      return { stdout: ["p101", "cnode", "n127.0.0.1:5173", "p202", "cnode", "n127.0.0.1:5174", "p303", "cprocess", "n127.0.0.1:9000"].join("\n") };
    }
    if (args.includes("101")) return { stdout: `n${appDir}\n` };
    if (args.includes("202")) return { stdout: `n${appDir}\n` };
    if (args.includes("303")) return { stdout: `n${path.join(tempRoot, "loose")}\n` };
    throw new Error("unexpected command");
  };
  const discovery = await discoverInstances({
    platform: "darwin",
    runCommand,
    ...noProviders,
    probeHttp: async (candidate) => (
      candidate.port === 9000
        ? { http: false }
        : { http: true, status: candidate.port === 5174 ? 401 : 200, latencyMs: 12, protocol: "http", title: `Port ${candidate.port}` }
    ),
  });
  assert.equal(discovery.instances.length, 2);
  assert.equal(calls.filter((call) => call.includes("-p 101")).length, 1);
  assert.equal(discovery.instances[1].status, 401);
  assert.notEqual(discovery.instances[0].associationKey, discovery.instances[0].key);
  assert.match(discovery.instances[0].associationKey, /^a[0-9a-f]{24}$/);

  const secureDiscovery = await discoverInstances({
    platform: "darwin", runCommand, ...noProviders,
    probeHttp: async (candidate) => ({
      http: true, status: 200, protocol: "https", title: "Secure app",
      origin: candidate.origin.replace(/^http:/, "https:"),
    }),
  });
  assert.equal(secureDiscovery.instances[0].origin, "https://127.0.0.1:5173");

  const unsupported = await discoverInstances({
    platform: "linux",
    runCommand: async () => {
      throw new Error("must not execute");
    },
  });
  assert.equal(unsupported.capabilities.discovery, "unsupported");
  assert.equal(unsupported.instances.length, 0);

  const snapshot = buildDeveloperRuntimeSnapshot({
    discovery,
    settings: renamed,
    now: new Date("2026-07-18T18:00:00.000Z"),
  });
  assert.equal(snapshot.generatedAt, "2026-07-18T18:00:00.000Z");
  assert.equal(snapshot.projects.length, 0);
  assert.equal(snapshot.unmatchedInstances.length, 2);
  assert.equal(snapshot.inactiveProjects.length, 1);
  const failedSnapshot = markDeveloperRuntimeRefreshFailed(snapshot, {
    startedAt: "2026-07-18T18:01:00.000Z",
    error: "scan failed",
  });
  assert.equal(failedSnapshot.generatedAt, snapshot.generatedAt);
  assert.equal(failedSnapshot.refresh.state, "failed");
  assert.equal(failedSnapshot.refresh.error, "scan failed");
  assert.equal(failedSnapshot.unmatchedInstances.length, snapshot.unmatchedInstances.length);

  const associated = updateSettings({
    stateRoot,
    input: {
      revision: 6,
      type: "association",
      associationKey: discovery.instances[0].associationKey,
      projectIdentity: "git:github.com/kirinmurphy/visa_planner",
      appId: "web",
    },
  });
  const associatedSnapshot = buildDeveloperRuntimeSnapshot({
    discovery,
    settings: associated,
    now: new Date("2026-07-18T18:00:00.000Z"),
  });
  assert.equal(associatedSnapshot.generatedAt, "2026-07-18T18:00:00.000Z");
  assert.equal(associatedSnapshot.projects.length, 1);
  assert.equal(associatedSnapshot.projects[0].instances.length, 1);
  assert.match(associatedSnapshot.projects[0].instances[0].opaqueKey, /^lk_/);
  assert.equal(
    findCurrentInstanceByOpaqueKey(associatedSnapshot, associatedSnapshot.projects[0].instances[0].opaqueKey).origin,
    "http://127.0.0.1:5173",
  );
  assert.equal(findCurrentInstanceByOpaqueKey(associatedSnapshot, "lk_missing"), null);
  assert.equal(associatedSnapshot.unmatchedInstances.length, 1);
  assert.match(associatedSnapshot.unmatchedInstances[0].opaqueKey, /^lk_/);
  assert.equal(associatedSnapshot.projects[0].instances[0].app.links[0].url, "http://127.0.0.1:5173/resume");
  assert.equal(associatedSnapshot.inactiveProjects.length, 0);
  const aliasedDiscovery = cloneJson(discovery);
  aliasedDiscovery.instances[0].project.identity = "path:/tmp/visa_planner";
  const aliasSnapshot = buildDeveloperRuntimeSnapshot({
    discovery: aliasedDiscovery,
    settings: associated,
    now: new Date("2026-07-18T18:00:00.000Z"),
  });
  assert.equal(aliasSnapshot.projects[0].identity, "git:github.com/kirinmurphy/visa_planner");
  const hiddenSettings = cloneJson(associated);
  hiddenSettings.projects["git:github.com/kirinmurphy/visa_planner"].apps.web.hidden = true;
  const hiddenSnapshot = buildDeveloperRuntimeSnapshot({
    discovery,
    settings: hiddenSettings,
    now: new Date("2026-07-18T18:00:00.000Z"),
  });
  assert.equal(hiddenSnapshot.projects.length, 0);
  assert.equal(hiddenSnapshot.hiddenCount, 1);
  assert.equal(hiddenSnapshot.settings.hidden.length, 1);
  assert.equal(hiddenSnapshot.settings.hidden[0].identity, "git:github.com/kirinmurphy/visa_planner");
  assert.equal(hiddenSnapshot.settings.hidden[0].app.id, "web");
  assert.equal(hiddenSnapshot.settings.associations.find((item) => item.key === discovery.instances[0].associationKey).appId, "web");
  assert.equal(hiddenSnapshot.settings.aliases[0].from, "path:/tmp/visa_planner");

  const restoredHidden = updateSettings({
    stateRoot,
    input: {
      revision: associated.revision,
      type: "project",
      projectIdentity: "git:github.com/kirinmurphy/visa_planner",
      appId: "web",
      appHidden: false,
    },
  });
  assert.equal(restoredHidden.projects["git:github.com/kirinmurphy/visa_planner"].apps.web.hidden, false);

  const restartBefore = await discoverInstances({
    platform: "darwin",
    runCommand: async (command, args) => {
      if (args.includes("-iTCP")) return { stdout: ["p701", "cnode", "n127.0.0.1:5173"].join("\n") };
      if (args.includes("701")) return { stdout: `n${appDir}\n` };
      throw new Error("unexpected command");
    },
    ...noProviders,
    probeHttp: async (candidate) => ({ http: true, status: 200, latencyMs: 6, protocol: "http", title: `Web ${candidate.port}` }),
  });
  const restarted = updateSettings({
    stateRoot,
    input: {
      revision: restoredHidden.revision,
      type: "association",
      associationKey: restartBefore.instances[0].associationKey,
      projectIdentity: "git:github.com/kirinmurphy/visa_planner",
      appId: "web",
    },
  });
  const apiDir = path.join(repo, "apps", "api");
  fs.mkdirSync(apiDir, { recursive: true });
  const restartAfter = await discoverInstances({
    platform: "darwin",
    runCommand: async (command, args) => {
      if (args.includes("-iTCP")) {
        return { stdout: ["p801", "cnode", "n127.0.0.1:62345", "p802", "cnode", "n127.0.0.1:62346"].join("\n") };
      }
      if (args.includes("801")) return { stdout: `n${appDir}\n` };
      if (args.includes("802")) return { stdout: `n${apiDir}\n` };
      throw new Error("unexpected command");
    },
    ...noProviders,
    probeHttp: async (candidate) => ({ http: true, status: 200, latencyMs: 7, protocol: "http", title: candidate.port === 62345 ? "Web 62345" : "API" }),
  });
  assert.equal(restartAfter.instances.find((instance) => instance.bind.port === 62345).associationKey, restartBefore.instances[0].associationKey);
  const restartSnapshot = buildDeveloperRuntimeSnapshot({
    discovery: restartAfter,
    settings: restarted,
    now: new Date("2026-07-18T18:02:00.000Z"),
  });
  assert.equal(restartSnapshot.projects.length, 1);
  assert.equal(restartSnapshot.projects[0].instances[0].origin, "http://127.0.0.1:62345");
  assert.equal(restartSnapshot.projects[0].instances[0].app.links[0].url, "http://127.0.0.1:62345/resume");
  assert.deepEqual(restartSnapshot.projects[0].instances[0].app.health.acceptedStatuses, [200, 204]);
  assert.deepEqual(restartSnapshot.projects[0].instances[0].app.match.process, ["node"]);
  assert.equal(restartSnapshot.unmatchedInstances.length, 1);
  assert.equal(restartSnapshot.inactiveProjects.length, 0);

  const lowConfidenceSnapshot = buildDeveloperRuntimeSnapshot({
    discovery: {
      capabilities: capabilityForPlatform("darwin"),
      warnings: [],
      instances: [{
        key: "9000",
        origin: "http://127.0.0.1:9000",
        alternateOrigins: [],
        bind: { address: "127.0.0.1", port: 9000, scope: "loopback", warning: null },
        status: 200,
        latencyMs: 5,
        protocol: "http",
        title: "Loose",
        process: { pid: 303, command: "node" },
        project: { identity: "process:/tmp:node", identityKind: "process", confidence: "low", evidence: "process working directory" },
      }],
    },
    settings: associated,
  });
  assert.equal(lowConfidenceSnapshot.unmatchedInstances.length, 1);
  assert.equal(lowConfidenceSnapshot.inactiveProjects.length, 1);

  let activeProbes = 0;
  let maxActiveProbes = 0;
  const manyListeners = Array.from({ length: 12 }, (_, index) => [
    `p${500 + index}`,
    "cnode",
    `n127.0.0.1:${7000 + index}`,
  ]).flat().join("\n");
  await discoverInstances({
    platform: "darwin",
    runCommand: async (command, args) => {
      if (args.includes("-iTCP")) return { stdout: manyListeners };
      return { stdout: `n${appDir}\n` };
    },
    ...noProviders,
    probeConcurrency: 4,
    probeHttp: async () => {
      activeProbes += 1;
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeProbes -= 1;
      return { http: true, status: 200, latencyMs: 5, protocol: "http", title: "Concurrent" };
    },
  });
  assert.equal(maxActiveProbes, 4);

  const server = http.createServer((req, res) => {
    if (req.url === "/external") {
      res.writeHead(302, { Location: "https://example.com/out" });
      res.end();
      return;
    }
    if (req.url === "/same") {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    if (req.url === "/api") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end("{\"ok\":true}");
      return;
    }
    if (req.url === "/huge") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`${"x".repeat(70 * 1024)}<title>Too Late</title>`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>Local App</title><link rel=\"icon\" href=\"/favicon.ico\">");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const probe = await probeHttpCandidate({ origin: `http://127.0.0.1:${port}` });
    assert.equal(probe.http, true);
    assert.equal(probe.status, 200);
    assert.equal(probe.title, "Local App");
    assert.equal(probe.favicon, `http://127.0.0.1:${port}/favicon.ico`);
    // The content type separates an untitled HTML app shell from an API, so the probe keeps it.
    assert.equal(probe.contentType, "text/html");
    const api = await probeHttpCandidate({ origin: `http://127.0.0.1:${port}/api` });
    assert.equal(api.title, null);
    assert.equal(api.contentType, "application/json; charset=utf-8");
    const shaped = toInstance({
      listener: { pid: 1, address: "127.0.0.1", port, bindScope: "loopback", command: "node" },
      identity: { identity: "path:/tmp/app", identityKind: "path", confidence: "high", projectRoot: "/tmp/app" },
      candidates: [{ origin: `http://127.0.0.1:${port}/api` }],
      probe: api,
      cwd: "/tmp/app",
    });
    assert.equal(shaped.contentType, "application/json; charset=utf-8");
    const redirect = await probeHttpCandidate({ origin: `http://127.0.0.1:${port}/external` });
    assert.equal(redirect.redirectExternal, true);
    const sameOriginRedirect = await probeHttpCandidate({ origin: `http://127.0.0.1:${port}/same` });
    assert.equal(sameOriginRedirect.redirectExternal, false);
    // probeHttpCandidate follows ONE loopback redirect hop to recover a title (the entrypoint
    // signal): /same 302s to /login, which falls through to the default handler here — same
    // title as root, but the follow proves the hop happened. The ORIGINAL origin is preserved;
    // the redirect field is consumed, not surfaced.
    assert.equal(sameOriginRedirect.origin, `http://127.0.0.1:${port}/same`);
    assert.equal(sameOriginRedirect.redirect, null);
    assert.equal(sameOriginRedirect.title, "Local App");
    const huge = await probeHttpCandidate({ origin: `http://127.0.0.1:${port}/huge` });
    assert.equal(huge.title, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const credentials = createLocalTestTls();
  const certificate = new X509Certificate(credentials.cert);
  assert.ok(certificate.verify(certificate.publicKey), "the disposable certificate is self-signed");
  assert.ok(certificate.checkPrivateKey(createPrivateKey(credentials.key)), "the disposable key matches the certificate");
  assert.ok(Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now(), "the certificate is currently valid");
  assert.notEqual(createLocalTestTls().key, credentials.key, "each test server gets a fresh private key");
  const secureServer = https.createServer(credentials, (req, res) => {
    if (req.url === "/external") {
      res.writeHead(302, { Location: "https://example.com/out" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<title>Secure Starter</title>");
  });
  await new Promise((resolve) => secureServer.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `https://127.0.0.1:${secureServer.address().port}`;
    const probe = await probeHttpCandidate({ origin });
    assert.equal(probe.origin, origin);
    assert.equal(probe.title, "Secure Starter");
    assert.equal(probe.tls, "untrusted", "reading local display metadata retains the certificate warning");
    // A TLS-only listener closes a plaintext request without an SSL-specific error message.
    const fallback = await probeHttpCandidate({ origin: origin.replace(/^https:/, "http:") });
    assert.equal(fallback.origin, origin);
    assert.equal(fallback.title, "Secure Starter");
    assert.equal(fallback.tls, "untrusted");
    const external = await probeHttpCandidate({ origin: `${origin}/external` });
    assert.equal(external.redirectExternal, true, "a local certificate retry never follows an external redirect");
    assert.equal(external.title, null);
    assert.equal(external.tls, "untrusted");
  } finally {
    await new Promise((resolve) => secureServer.close(resolve));
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

// --- collectIdleMainCheckouts: the idle main row of a repository whose worktrees run ---
// mainCheckoutPath's git resolution is covered in repositories-lifecycle-check.mjs and the snapshot
// merge in developer-runtime-repository-merge-check.mjs; this covers the scan's own choices: which
// repositories it looks at and when it leaves a main checkout to the running path.
{
  const { execFileSync } = await import("node:child_process");
  const git = (...args) => execFileSync("git", args, { stdio: "ignore" });
  // Real path: git records worktree locations resolved, and macOS tmpdir sits behind /var -> /private/var.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "developer-runtime-idle-main-")));
  try {
    const main = path.join(base, "main");
    git("init", "-q", "-b", "main", main);
    git("-C", main, "config", "user.email", "t@example.invalid");
    git("-C", main, "config", "user.name", "t");
    // A remote gives every checkout one canonical git id; without it each checkout is its own local id.
    git("-C", main, "remote", "add", "origin", "https://example.invalid/acme/idle-main.git");
    git("-C", main, "commit", "-q", "--allow-empty", "-m", "x");
    const linked = path.join(base, "linked");
    git("-C", main, "worktree", "add", "-q", "-b", "feature", linked);
    const repositoryId = canonicalRepositoryId(resolveProjectIdentity(linked));
    assert.match(repositoryId, /^git:/);

    const running = (...roots) => ({
      instances: roots.map((projectRoot) => ({ project: { repositoryId, projectRoot, rootId: computeRootId(projectRoot) } })),
      composeProjectGit: new Map(),
    });

    const worktreeOnly = await collectIdleMainCheckouts(running(linked), new Set([repositoryId]), null);
    const idleMain = worktreeOnly.get(repositoryId);
    assert.equal(idleMain?.projectRoot, main, "a running worktree finds its idle main checkout");
    assert.equal(idleMain.rootId, computeRootId(main));
    assert.equal(idleMain.state, "present");
    assert.equal(idleMain.git?.branch, "main", "git is read from the main checkout, not the worktree");

    const mainAlsoRunning = await collectIdleMainCheckouts(running(linked, main), new Set([repositoryId]), null);
    assert.equal(mainAlsoRunning.size, 0, "a running main checkout is left to the running path");

    const notRunning = await collectIdleMainCheckouts(running(linked), new Set(), null);
    assert.equal(notRunning.size, 0, "a repository that is not running is the persisted path's to show");

    // Bare: the worktrees share `<name>.git`, so there is no main checkout to show.
    const bare = path.join(base, "bare.git");
    git("clone", "-q", "--bare", main, bare);
    const bareLinked = path.join(base, "bare-linked");
    git("-C", bare, "worktree", "add", "-q", "-b", "other", bareLinked);
    const bareOnly = await collectIdleMainCheckouts(running(bareLinked), new Set([repositoryId]), null);
    assert.equal(bareOnly.size, 0, "a bare repository's worktree yields no main checkout");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

console.log("ok: developer-runtime core");
