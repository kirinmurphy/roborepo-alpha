#!/usr/bin/env node
// The portal UI suite's hermetic server must not see the host's installed harnesses, or a harness
// installed on the developer's machine gets set up mid-suite and changes what later specs see
// (scripts/test/portal-ui/host-harness-isolation.mjs). This pins that: under the isolation
// environment, discovery finds no evidence for any registered provider, even when a real-looking
// executable for every provider is also on PATH behind the stubs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectHarnessProvider, effectiveDetection } from "../harnesses/discovery.mjs";
import { listHarnessProviders } from "../harnesses/registry.mjs";
import { hostHarnessIsolationEnv } from "./portal-ui/host-harness-isolation.mjs";

// The stand-in executables below are shell scripts; Windows discovery cannot run them.
if (process.platform === "win32") {
  console.log("skip: portal UI host harness isolation (POSIX stand-in executables)");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-host-isolation-"));
const saved = { ...process.env };
try {
  // A stand-in for an installed CLI: answers --version successfully.
  const installed = path.join(tmp, "installed-bin");
  fs.mkdirSync(installed);
  const names = new Set(listHarnessProviders().flatMap(({ manifest }) => effectiveDetection(manifest).executables ?? []));
  assert.ok(names.size > 0, "registered providers declare executables");
  for (const name of names) {
    fs.writeFileSync(path.join(installed, name), "#!/bin/sh\necho 1.0.0\n");
    fs.chmodSync(path.join(installed, name), 0o755);
  }

  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  Object.assign(process.env, { HOME: home }, hostHarnessIsolationEnv(tmp, `${installed}${path.delimiter}${saved.PATH ?? ""}`));
  for (const { manifest } of listHarnessProviders()) {
    const result = detectHarnessProvider(manifest);
    assert.deepEqual(result.evidence, [], `${manifest.id}: no executable or desktop evidence under isolation`);
    assert.equal(result.status, "absent", `${manifest.id} is not detected`);
  }

  // Control: without the isolation, the stand-in executables are found, so the assertions above
  // are not passing vacuously.
  process.env.PATH = `${installed}${path.delimiter}${saved.PATH ?? ""}`;
  delete process.env.NODE_ENV;
  delete process.env.ROBOREPO_TEST_DESKTOP_ROOTS;
  const visible = listHarnessProviders().filter(({ manifest }) =>
    detectHarnessProvider(manifest).evidence.some((item) => item.kind === "executable" && item.source === "cli"));
  assert.equal(visible.length, listHarnessProviders().filter(({ manifest }) => effectiveDetection(manifest).executables?.length).length);

  console.log("portal UI host harness isolation checks passed");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(tmp, { recursive: true, force: true });
}
