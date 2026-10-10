#!/usr/bin/env node
// Runtime observes processes only while the auto-discovery source is on (pljvmyh §7). With it off
// (the default), loading or refreshing Runtime lists no process and registers no repository —
// not even the portal's own checkout, which Runtime would otherwise synthesize and record.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-runtime-auto-"));

const probe = `
  const runtime = await import("./scripts/cli/developer-runtime.mjs");
  const { loadRegistry } = await import("./modules/repositories/index.mjs");
  const { rootId } = await import("./modules/repositories/identity.mjs");
  const { autoDiscoveryEnabled, setRepositorySourceEnabled } = await import("./scripts/cli/repository-sources.mjs");
  runtime.setDeveloperRuntimePortalInfo({ port: 4999 });
  const loaded = runtime.loadDeveloperRuntimeSnapshot();
  const refreshed = await runtime.refreshDeveloperRuntimeSnapshot();
  const observed = {
    loadedFlag: loaded.autoDiscovery,
    refreshedFlag: refreshed.autoDiscovery,
    instances: [...refreshed.projects.flatMap((project) => project.instances || []), ...(refreshed.unmatchedInstances || [])].length,
    registered: Object.keys(loadRegistry({ stateRoot: process.env.ROBOREPO_STATE_ROOT }).repositories).length,
  };

  // Hold a scan after it observes auto-discovery as enabled, turn the source off, then let the
  // stale scan finish. Its discovered repository must not regain developer-runtime evidence.
  runtime.setDeveloperRuntimePortalInfo(null);
  const stateRoot = process.env.ROBOREPO_STATE_ROOT;
  const projectRoot = stateRoot + "/race-checkout";
  const repositoryId = "git:github.com/example/race-check";
  setRepositorySourceEnabled({ id: "auto-discovery", enabled: true, stateRoot });
  let scanStarted;
  const started = new Promise((resolve) => { scanStarted = resolve; });
  let finishScan;
  const scanGate = new Promise((resolve) => { finishScan = resolve; });
  const inFlight = runtime.refreshDeveloperRuntimeSnapshot({
    discover: async () => {
      scanStarted();
      await scanGate;
      return {
        capabilities: { discovery: "supported" },
        warnings: [],
        instances: [],
        composeProjectGit: new Map([["race-check", {
          repositoryId,
          projectRoot,
          rootId: rootId(projectRoot),
          identityKind: "git",
          confidence: "high",
          name: "race-check",
        }]]),
      };
    },
    refreshGit: async () => {},
  });
  await started;
  setRepositorySourceEnabled({ id: "auto-discovery", enabled: false, stateRoot });
  finishScan();
  await inFlight;
  const afterRace = loadRegistry({ stateRoot }).repositories[repositoryId];
  process.stdout.write(JSON.stringify({
    ...observed,
    raceEnabledAfterDisable: autoDiscoveryEnabled({ stateRoot }),
    raceRepository: afterRace ? { discoveries: afterRace.discoveries } : null,
  }));
`;

try {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: repoRoot,
    env: { ...process.env, ROBOREPO_STATE_ROOT: stateRoot },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.loadedFlag, { enabled: false }, "Runtime reports auto-discovery off by default");
  assert.deepEqual(observed.refreshedFlag, { enabled: false });
  assert.equal(observed.instances, 0, "no process is observed while auto-discovery is off");
  assert.equal(observed.registered, 0, "nothing is registered while auto-discovery is off");
  assert.equal(observed.raceEnabledAfterDisable, false, "the race turns auto-discovery off while a scan is paused");
  assert.equal(observed.raceRepository, null, "a scan started before disable cannot restore repository evidence");
  console.log("developer-runtime auto-discovery gate: ok");
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
}
