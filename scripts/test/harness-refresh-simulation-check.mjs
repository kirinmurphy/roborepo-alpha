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
const desktopRoot = path.join(tempRoot, "claude-code");
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
  import { harnessStatePath } from "./scripts/cli/state-paths.mjs";
  import { refreshHarnessesAndApply } from "./scripts/cli/portal-harness-refresh.mjs";
  import { configSnapshotHarnessGuidance } from "./scripts/cli/config.mjs";
  const readyGuidance = () => configSnapshotHarnessGuidance().find((entry) => entry.id === "claude")?.ready ?? false;

  // The portal route answers asynchronously, so this resolves once the response ends.
  async function callRefresh(refreshHarnesses = refreshHarnessState) {
    let ended;
    const done = new Promise((resolve) => { ended = resolve; });
    const res = { status: null, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = body; ended(); } };
    const req = { on(event, callback) {
      if (event === "data") callback("{}");
      if (event === "end") callback();
    } };
    dispatchRoutes([configRoutes], { method: "POST", ...req }, res, "/api/config/harnesses/refresh", "", {
      refreshHarnesses,
      loadConfig: () => ({ machineHarnesses: Object.entries(readHarnessState().providers).map(([id, entry]) => ({
        id,
        enabled: entry.enabled,
        confidence: entry.confidence,
      })) }),
    });
    await done;
    assert.equal(res.status, 200);
    return JSON.parse(res.body);
  }

  // No shim means no discovery before the simulated external installation.
  const absent = await callRefresh();
  assert.deepEqual(absent.detected, []);

  // Simulate an external install: supported CLI on PATH plus the recognized home/config evidence
  // required for confirmed detection. The shim answers only the provider's --version probe.
  const executable = path.join(process.env.FAKE_HARNESS_BIN, "claude");
  fs.writeFileSync(executable, "#!/bin/sh\\nprintf 'Claude Code test shim\\n'\\n");
  fs.chmodSync(executable, 0o755);
  const claudeHome = path.join(process.env.HOME, ".claude");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, "settings.json"), "{}\\n");

  // Installed and launched but not yet set up: the portal finishes setup on its own.
  assert.equal(readyGuidance(), true);

  const installed = await callRefresh();
  assert.equal(readyGuidance(), false, "an enabled harness needs no guidance");
  assert.deepEqual(installed.detected, ["claude"]);
  assert.equal(installed.config.machineHarnesses.some((harness) => JSON.stringify(harness).includes(process.env.FAKE_HARNESS_BIN)), false);
  const detected = installed.config.machineHarnesses.find((harness) => harness.id === "claude");
  assert.equal(detected.confidence, "confirmed");
  assert.equal(detected.enabled, true);

  // The portal's check applies config only when a refresh newly enables a harness: once for the
  // transition, never for a harness that was already enabled.
  let applies = 0;
  const countApply = () => refreshHarnessesAndApply({ apply: async () => { applies += 1; return { ok: true }; } });
  writeHarnessState(setProviderEnabled(readHarnessState(), "claude", false));
  const providers = readHarnessState().providers;
  writeHarnessState({ ...readHarnessState(), providers: { ...providers, claude: { ...providers.claude, selectionSource: "discovery" } } });
  const transitioned = await callRefresh(countApply);
  assert.deepEqual(transitioned.newlyEnabled, [{ id: "claude", displayName: "Claude Code" }]);
  assert.deepEqual(transitioned.applied, { ok: true });
  assert.equal(applies, 1);
  const unchanged = await callRefresh(countApply);
  assert.deepEqual(unchanged.newlyEnabled, []);
  assert.equal(unchanged.applied, null);
  assert.equal(applies, 1);

  // Two requests during one setup share it rather than running two installs.
  writeHarnessState(setProviderEnabled(readHarnessState(), "claude", false));
  writeHarnessState({ ...readHarnessState(), providers: { ...readHarnessState().providers, claude: { ...readHarnessState().providers.claude, selectionSource: "discovery" } } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowApply = () => refreshHarnessesAndApply({ apply: async () => { applies += 1; await gate; return { ok: true }; } });
  const first = slowApply();
  const second = slowApply();
  release();
  assert.equal(await first, await second);
  assert.equal(applies, 2);

  // A failed apply leaves the harness not set up, so the portal offers setup again.
  writeHarnessState(setProviderEnabled(readHarnessState(), "claude", false));
  writeHarnessState({ ...readHarnessState(), providers: { ...readHarnessState().providers, claude: { ...readHarnessState().providers.claude, selectionSource: "discovery" } } });
  const failed = await callRefresh(() => refreshHarnessesAndApply({ apply: async () => ({ ok: false, error: "installer exited 1" }) }));
  assert.deepEqual(failed.applied, { ok: false, error: "installer exited 1" });
  assert.equal(readHarnessState().providers.claude.enabled, false);
  assert.equal(readHarnessState().providers.claude.selectionSource, "discovery");
  assert.equal(readyGuidance(), true);
  await callRefresh(countApply);
  assert.equal(readHarnessState().providers.claude.enabled, true);

  // An explicit user disable must survive the next check, just as it does with a real installation.
  const current = readHarnessState();
  writeHarnessState(setProviderEnabled(current, "claude", false));
  await callRefresh();
  assert.equal(readHarnessState().providers.claude.enabled, false);
  assert.equal(readyGuidance(), false, "a harness the user disabled is not offered for setup");

  // Older state has no migration path; a refresh rebuilds it from current discovery.
  fs.writeFileSync(harnessStatePath, JSON.stringify({ schemaVersion: 1, providers: { claude: { enabled: false } } }));
  assert.deepEqual(readHarnessState().providers, {});
  assert.equal((await callRefresh()).detected.includes("claude"), true);

  if (process.platform === "darwin") {
    fs.unlinkSync(executable);
    const bundle = path.join(process.env.FAKE_DESKTOP_ROOT, "2.1.295", "build-a", "claude.app");
    const contents = path.join(bundle, "Contents");
    fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(contents, "Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.anthropic.claude-code</string></dict></plist>');
    fs.writeFileSync(path.join(path.dirname(bundle), ".verified"), "ok");
    const desktopExecutable = path.join(contents, "MacOS", "claude");
    fs.writeFileSync(desktopExecutable, '#!/bin/sh\\necho "2.1.295 (Claude Code)"\\n');
    fs.chmodSync(desktopExecutable, 0o755);
    const nativeConfig = path.join(claudeHome, "settings.json");
    const configBefore = fs.readFileSync(nativeConfig);
    const plistBefore = fs.readFileSync(path.join(contents, "Info.plist"));
    const executableBefore = fs.readFileSync(desktopExecutable);
    const refreshed = await callRefresh();
    assert.deepEqual(refreshed.detected, ["claude"]);
    const claude = readHarnessState().providers.claude;
    assert.equal(claude.evidence.some((entry) => entry.source === "desktop"), true);
    assert.deepEqual(fs.readFileSync(nativeConfig), configBefore);
    assert.deepEqual(fs.readFileSync(path.join(contents, "Info.plist")), plistBefore);
    assert.deepEqual(fs.readFileSync(desktopExecutable), executableBefore);
  }
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
      FAKE_DESKTOP_ROOT: desktopRoot,
      ROBOREPO_STATE_ROOT: stateRoot,
      NODE_ENV: "test",
      ROBOREPO_TEST_DESKTOP_ROOTS: JSON.stringify({
        "~/Library/Application Support/Claude/claude-code": desktopRoot,
        "/Applications": path.join(tempRoot, "Applications"),
        "~/Applications": path.join(tempRoot, "user-Applications"),
      }),
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
