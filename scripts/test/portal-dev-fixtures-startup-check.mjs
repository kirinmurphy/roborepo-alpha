#!/usr/bin/env node
// Starting the portal must keep the dev fixture records. `roborepo dev start` records the fixtures
// and then runs `web`, so a startup that forgot them lost the idle-checkout fixture, which has no
// listener for Runtime to rediscover it by. Outside dev mode the records stay on disk but hidden;
// with dev mode on the repository list shows all three.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  defaultRegistry, registryPathFor, setDevFixturesEnabled, upsertRepository, writeRegistry,
} from "../../modules/repositories/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-dev-fixtures-startup-"));
const state = path.join(tmp, "state");

const REAL = "git:github.com/acme/startup-real";
const FIXTURES = [
  "git:github.com/example/idle-checkout-fixture",
  "git:github.com/example/multi-member-fixture",
  "git:github.com/example/shared-stack-fixture",
];

const registry = defaultRegistry();
for (const id of [REAL, ...FIXTURES]) upsertRepository(registry, { id, kind: "git", displayName: id.split("/").pop() });
writeRegistry({ stateRoot: state, registry });

const storedIds = () => Object.keys(JSON.parse(fs.readFileSync(registryPathFor(state), "utf8")).repositories).sort();

// Starts a portal on this state, waits until it serves, and returns the repository list it reports.
async function listedAfterStartup() {
  const ready = path.join(tmp, `ready-${Date.now()}`);
  let output = "";
  const child = spawn(process.execPath, [path.join(root, "scripts/cli/main.mjs"), "web", "--no-open", "--port", "0", "--allow-zero-port"], {
    cwd: root,
    env: { ...process.env, HOME: tmp, ROBOREPO_STATE_ROOT: state, PORTAL_READY_FILE: ready },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (part) => { output += part; });
  child.stderr.on("data", (part) => { output += part; });
  try {
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(ready)) {
      if (child.exitCode != null || Date.now() > deadline) throw new Error(`test portal failed to start: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const port = fs.readFileSync(ready, "utf8").match(/ready:(\d+)/)[1];
    const response = await fetch(`http://127.0.0.1:${port}/api/repositories`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    return payload.repositories.map((repository) => repository.repositoryId).sort();
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode == null) await new Promise((resolve) => child.once("exit", resolve));
  }
}

try {
  const allIds = [REAL, ...FIXTURES].sort();

  const listedOff = await listedAfterStartup();
  assert.deepEqual(storedIds(), allIds, "a portal start outside dev mode keeps the fixture records on disk");
  assert.deepEqual(listedOff, [REAL], "and the repository list still hides them");

  setDevFixturesEnabled({ stateRoot: state, enabled: true });
  const listedOn = await listedAfterStartup();
  assert.deepEqual(storedIds(), allIds, "a portal start in dev mode keeps all three fixture records");
  assert.deepEqual(listedOn, allIds, "and the repository list shows them");

  console.log("portal dev fixtures startup: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
