#!/usr/bin/env node
// The real supported-provider refresh path, using a temporary command shim and home/config
// fixtures instead of requiring an installed harness on the developer machine.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-harness-refresh-"));
const fakeBin = path.join(tempRoot, "bin");
const fakeHome = path.join(tempRoot, "home");
const stateRoot = path.join(tempRoot, "state");
fs.mkdirSync(fakeBin, { recursive: true });
fs.mkdirSync(fakeHome, { recursive: true });

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, `#!/bin/sh\n${contents}`);
  fs.chmodSync(filePath, 0o755);
}

// Resolve only commands in fakeBin, even when this test runs on a machine with harnesses present.
writeExecutable(path.join(fakeBin, "which"), `
if [ -x "$FAKE_HARNESS_BIN/$1" ]; then
  printf '%s\\n' "$FAKE_HARNESS_BIN/$1"
  exit 0
fi
exit 1
`);

const probe = `
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import path from "node:path";
  import { dispatchRoutes } from "./scripts/cli/portal-router.mjs";
  import { configRoutes } from "./scripts/cli/portal-routes-config.mjs";
  import { refreshHarnessState } from "./scripts/harnesses/refresh.mjs";
  import { readHarnessState, setProviderEnabled, writeHarnessState } from "./scripts/harnesses/state.mjs";

  function callRefresh() {
    const res = { status: null, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    const req = { on(event, callback) {
      if (event === "data") callback("{}");
      if (event === "end") callback();
    } };
    dispatchRoutes([configRoutes], { method: "POST", ...req }, res, "/api/config/harnesses/refresh", "", {
      refreshHarnesses: refreshHarnessState,
      loadConfig: () => ({ machineHarnesses: Object.entries(readHarnessState().providers).map(([id, entry]) => ({
        id,
        enabled: entry.enabled,
        confidence: entry.confidence,
      })) }),
    });
    assert.equal(res.status, 200);
    return JSON.parse(res.body);
  }

  // No shim means no discovery before the simulated external installation.
  const absent = callRefresh();
  assert.deepEqual(absent.detected, []);

  // Simulate an external install: supported CLI on PATH plus the recognized home/config evidence
  // required for confirmed detection. The shim answers only the provider's --version probe.
  const executable = path.join(process.env.FAKE_HARNESS_BIN, "claude");
  fs.writeFileSync(executable, "#!/bin/sh\\nprintf 'Claude Code test shim\\n'\\n");
  fs.chmodSync(executable, 0o755);
  const claudeHome = path.join(process.env.HOME, ".claude");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, "settings.json"), "{}\\n");

  const installed = callRefresh();
  assert.deepEqual(installed.detected, ["claude"]);
  assert.equal(installed.config.machineHarnesses.some((harness) => JSON.stringify(harness).includes(process.env.FAKE_HARNESS_BIN)), false);
  const detected = installed.config.machineHarnesses.find((harness) => harness.id === "claude");
  assert.equal(detected.confidence, "confirmed");
  assert.equal(detected.enabled, true);

  // An explicit user disable must survive the next check, just as it does with a real installation.
  const current = readHarnessState();
  writeHarnessState(setProviderEnabled(current, "claude", false));
  callRefresh();
  assert.equal(readHarnessState().providers.claude.enabled, false);
  process.stdout.write("harness refresh simulation: install detection, portal route, and disable preservation passed\\n");
`;

try {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: fakeHome,
      PATH: fakeBin,
      FAKE_HARNESS_BIN: fakeBin,
      ROBOREPO_STATE_ROOT: stateRoot,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /harness refresh simulation: install detection, portal route, and disable preservation passed/);
  console.log("harness refresh simulation: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
