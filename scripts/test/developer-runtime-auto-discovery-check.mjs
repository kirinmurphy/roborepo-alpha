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
  runtime.setDeveloperRuntimePortalInfo({ port: 4999 });
  const loaded = runtime.loadDeveloperRuntimeSnapshot();
  const refreshed = await runtime.refreshDeveloperRuntimeSnapshot();
  process.stdout.write(JSON.stringify({
    loadedFlag: loaded.autoDiscovery,
    refreshedFlag: refreshed.autoDiscovery,
    instances: [...refreshed.projects.flatMap((project) => project.instances || []), ...(refreshed.unmatchedInstances || [])].length,
    registered: Object.keys(loadRegistry({ stateRoot: process.env.ROBOREPO_STATE_ROOT }).repositories).length,
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
  console.log("developer-runtime auto-discovery gate: ok");
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
}
