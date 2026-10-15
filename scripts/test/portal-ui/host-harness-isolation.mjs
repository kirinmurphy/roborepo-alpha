// Keeps the hermetic portal blind to the harnesses installed on the machine running the suite.
//
// Harness discovery (scripts/harnesses/discovery.mjs) looks outside the temp HOME in two places:
// provider executables on PATH and, on macOS, desktop apps under /Applications. On a developer Mac
// with Codex or Claude Desktop installed, a harness reaches "ready" as soon as any spec gives the
// temp HOME that harness's config dir. The next real Agents, Tokens, or Home page then finishes
// harness setup on its own (finishSetupOnce in portal/shared/harness-setup-flow.js), which changes
// the shared server's state for every later spec. On CI, where nothing is installed, that never
// happens, so a suite that passes on one machine fails on another depending on spec order.
//
// The returned environment makes every machine look like CI:
// - NODE_ENV=test with ROBOREPO_TEST_DESKTOP_ROOTS={} maps every desktop app root to a missing
//   fixture path (the existing discovery test hook), so no desktop app is found;
// - a directory of stub executables, one per provider executable name from the registry, goes
//   first on PATH. Each stub fails `--version`, which discovery treats as "not installed".

import fs from "node:fs";
import path from "node:path";
import { effectiveDetection } from "../../harnesses/discovery.mjs";
import { listHarnessProviders } from "../../harnesses/registry.mjs";

export function hostHarnessIsolationEnv(tmpDir, basePath = process.env.PATH ?? "") {
  const stubDir = path.join(tmpDir, "harness-executable-stubs");
  fs.mkdirSync(stubDir, { recursive: true });
  for (const name of providerExecutableNames()) writeFailingStub(stubDir, name);
  return {
    NODE_ENV: "test",
    ROBOREPO_TEST_DESKTOP_ROOTS: "{}",
    PATH: [stubDir, basePath].filter(Boolean).join(path.delimiter),
  };
}

// Every executable any registered provider declares, on any platform it lists.
function providerExecutableNames() {
  const names = new Set();
  for (const { manifest } of listHarnessProviders()) {
    const platforms = [process.platform, ...Object.keys(manifest.platforms ?? {})];
    for (const platform of platforms) {
      for (const name of effectiveDetection(manifest, platform).executables ?? []) names.add(name);
    }
  }
  return names;
}

function writeFailingStub(dir, name) {
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), "@exit /b 1\r\n");
    return;
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(file, 0o755);
}
