#!/usr/bin/env node
// Runtime shows development fixtures only while `roborepo dev start` has dev mode on. Without the
// marker a running fixture stays off the page (`roborepo web`); with it, both a running fixture and
// an idle fixture checkout the registry knows appear like any other repository.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-runtime-dev-fixtures-"));

// The Runtime module reads its state root once at import, so it runs in a child with
// ROBOREPO_STATE_ROOT pointed at the temp directory.
const probe = `
  const stateRoot = process.env.ROBOREPO_STATE_ROOT;
  const runtime = await import("./scripts/cli/developer-runtime.mjs");
  const { recordRepositoryDiscovery } = await import("./scripts/cli/repositories.mjs");
  const { setRepositorySourceEnabled } = await import("./scripts/cli/repository-sources.mjs");
  const { setDevFixturesEnabled } = await import("./modules/repositories/index.mjs");
  const { rootId } = await import("./modules/repositories/identity.mjs");
  const fs = await import("node:fs");

  const REAL = "git:github.com/example/alpha";
  const RUNNING = "git:github.com/example/multi-member-fixture";
  const IDLE = "git:github.com/example/idle-checkout-fixture";
  const checkout = (name) => {
    const dir = stateRoot + "/" + name;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  for (const [repositoryId, name] of [[REAL, "alpha"], [IDLE, "idle-checkout-fixture"]]) {
    const dir = checkout(name);
    recordRepositoryDiscovery({ repositoryId, kind: "git", displayName: name, source: "developer-runtime", evidence: "git-remote", confidence: "high", localRoot: rootId(dir), localRootPath: dir, stateRoot });
  }
  setRepositorySourceEnabled({ id: "auto-discovery", enabled: true, stateRoot });

  const runningRoot = checkout("multi-member-fixture");
  const listener = {
    key: "fixture-web", associationKey: "fixture-web",
    matchSignature: { key: "fixture-web", projectIdentity: RUNNING, relativeCwd: null, command: "node", title: "fixture" },
    origin: "http://127.0.0.1:48101", alternateOrigins: [],
    bind: { address: "127.0.0.1", port: 48101, scope: "loopback", warning: null },
    status: 200, latencyMs: 1, protocol: "http", title: "fixture",
    health: { state: "healthy", reason: null, consecutiveFailures: 0, since: null, firstSeenAt: null, lastProbeAt: null },
    process: { pid: 999999, command: "node" },
    project: { identity: RUNNING, identityKind: "git", confidence: "high", projectRoot: runningRoot, evidence: "git-remote", git: null, repositoryId: RUNNING, rootId: rootId(runningRoot) },
  };
  const discover = async () => ({ capabilities: { discovery: "supported" }, warnings: [], instances: [structuredClone(listener)], composeProjectGit: new Map() });
  const refresh = async () => {
    runtime.clearDeveloperRuntimeSnapshotCache();
    const snapshot = await runtime.refreshDeveloperRuntimeSnapshot({ discover, refreshGit: async () => {} });
    return {
      repositories: snapshot.repositories.map((repository) => repository.repositoryId).sort(),
      projects: snapshot.projects.map((project) => project.repositoryId || project.project?.repositoryId || null),
    };
  };

  const devOff = await refresh();
  setDevFixturesEnabled({ stateRoot, enabled: true });
  const devOn = await refresh();
  setDevFixturesEnabled({ stateRoot, enabled: false });
  const devStopped = await refresh();
  process.stdout.write(JSON.stringify({ devOff, devOn, devStopped, ids: { REAL, RUNNING, IDLE } }));
`;

try {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: repoRoot,
    env: { ...process.env, ROBOREPO_STATE_ROOT: stateRoot },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { devOff, devOn, devStopped, ids } = JSON.parse(result.stdout);

  assert.deepEqual(devOff.repositories, [ids.REAL], "outside dev mode a running fixture stays off Runtime");
  assert.equal(devOff.projects.length, 0, "and its listener is not listed as a project");
  assert.deepEqual(devOn.repositories, [ids.REAL, ids.IDLE, ids.RUNNING].sort(), "dev mode shows the running fixture and the idle fixture checkout");
  assert.equal(devOn.projects.length, 1, "the running fixture's listener is listed");
  assert.deepEqual(devStopped.repositories, [ids.REAL], "turning dev mode off hides them again");
  console.log("developer-runtime dev fixtures: ok");
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
}
