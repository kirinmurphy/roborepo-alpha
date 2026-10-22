#!/usr/bin/env node
// Terminal hook review guidance end to end: a temp HOME, a fake Codex whose `hooks/list` answers
// from that home's hooks.json, and the real CLI. Commands that rewrite Codex hooks print the review
// step exactly once, only when a RoboRepo hook awaits review; a base-only install asks Codex
// nothing; and the printed command prefers the desktop app's bundled CLI over one on PATH.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");
const fakeServer = path.join(here, "fixtures/hook-readiness/fake-codex-app-server.mjs");
const telemetryCommands = commands(JSON.parse(fs.readFileSync(path.join(repoRoot, "globals/packages/telemetry/hooks-codex.json"), "utf8")));
const REVIEW_LINE = /^Codex hooks need review: /m;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-hook-review-cli-"));
try {
  cliOnlyMachine();
  recursivePackageChanges();
  if (process.platform === "darwin") desktopMachine();
  console.log("ok: terminal hook review guidance");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function cliOnlyMachine() {
  const machine = makeMachine("cli-only");
  const pathCodex = fakeCodex(path.join(machine.root, "bin", "codex"));

  let result = machine.run("bundle", "apply", "--default");
  assert.doesNotMatch(result.stdout, REVIEW_LINE, "base-only install installs nothing that needs review");
  assert.equal(machine.codexLaunches(), 0, "and does not start Codex to ask");

  result = machine.run("onboard-intro");
  assert.doesNotMatch(result.stdout, REVIEW_LINE, "headless onboarding applies base only");

  result = machine.run("package", "enable", "telemetry");
  assert.equal(count(result.stdout, REVIEW_LINE), 1, "one review step for the package change, none extra from telemetry");
  assert.match(result.stdout, /^Codex hooks need review: Token Telemetry \(SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop\)\.$/m);
  assert.doesNotMatch(result.stdout, /Trust all/);
  assert.match(result.stdout, new RegExp(`^  Open Codex's review: ${escape(pathCodex)}$`, "m"), "CLI-only machine: the PATH binary");

  const hooksFile = path.join(machine.root, "home", ".codex", "hooks.json");
  const labelled = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  assert.ok(!("_descriptions" in labelled.hooks), "source-only explanations never reach the native hook file");
  const nativeHooks = Object.values(labelled.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
  assert.equal(nativeHooks.length, 5);
  assert.ok(nativeHooks.every((hook) => hook.statusMessage?.startsWith("RoboRepo: telemetry")), "all five native package hooks have readable names");
  const unnamed = structuredClone(labelled);
  for (const groups of Object.values(unnamed.hooks)) for (const group of groups) for (const hook of group.hooks) delete hook.statusMessage;
  fs.writeFileSync(hooksFile, JSON.stringify(unnamed));
  machine.run("package", "enable", "telemetry");
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksFile, "utf8")), labelled, "reapply labels existing package hooks in place without changing their commands or positions");

  result = machine.run("telemetry", "enable");
  assert.equal(count(result.stdout, REVIEW_LINE), 1, "telemetry enable reports once");

  // Trusted in Codex: nothing to say.
  result = machine.run("package", "enable", "telemetry", { FAKE_CODEX_TRUSTED: JSON.stringify(telemetryCommands) });
  assert.doesNotMatch(result.stdout, REVIEW_LINE);

  // The optional hooks bundle adds core hooks; telemetry's stay trusted at their positions.
  result = machine.run("bundle", "apply", "hooks", { FAKE_CODEX_TRUSTED: JSON.stringify(telemetryCommands) });
  assert.match(result.stdout, /^Codex hooks need review: Codex core hooks \(SessionStart, PreToolUse\)\.$/m);
  assert.doesNotMatch(result.stdout, /Token Telemetry \(/, "trusted package hooks did not move, so they need no new review");

  // Package changes in a headless run still print guidance, and never open a terminal.
  result = machine.run("package", "disable", "telemetry", { FAKE_CODEX_TRUSTED: "[]" });
  assert.equal(result.status, 0);
  assert.ok(!fs.existsSync(path.join(machine.state, "terminal-launch")), "the CLI never launches a terminal");
}

function recursivePackageChanges() {
  const machine = makeMachine("recursive");
  fakeCodex(path.join(machine.root, "bin", "codex"));
  for (const [id, requires, hooks] of [
    ["review-base", [], false],
    ["review-leaf", ["review-base"], true],
    ["review-middle", ["review-leaf"], false],
    ["review-top", ["review-middle"], false],
  ]) {
    const dir = path.join(machine.root, "workspace", "packages", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.config.json"), JSON.stringify({
      schemaVersion: 1, id, label: id, description: "Hook review fixture", requires,
      presentation: { category: "integrations" },
      resources: hooks ? [{ type: "hooks", harness: "codex", source: "hooks.json" }] : [],
    }));
    if (hooks) fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({
      PostToolUse: [{ hooks: [{ type: "command", command: "node /fixture/recursive-observer.mjs" }] }],
    }));
  }
  const reconcileMachine = makeMachine("recursive-reconcile");
  fakeCodex(path.join(reconcileMachine.root, "bin", "codex"));
  fs.cpSync(path.join(machine.root, "workspace"), path.join(reconcileMachine.root, "workspace"), { recursive: true });
  const defaultDir = path.join(reconcileMachine.root, "workspace", "packages", "review-default");
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.writeFileSync(path.join(defaultDir, "package.config.json"), JSON.stringify({
    schemaVersion: 1, id: "review-default", label: "review-default", description: "Default composite fixture",
    defaultEnabled: true, requires: ["review-leaf"], presentation: { category: "integrations" }, resources: [],
  }));
  const reconciled = reconcileMachine.runScript(`
    const { applyBulkPackageChange } = await import(${JSON.stringify(path.join(repoRoot, "scripts/cli/config-bulk.mjs"))});
    const { reportPackageHookChange } = await import(${JSON.stringify(path.join(repoRoot, "scripts/cli/hook-readiness-status.mjs"))});
    console.log(JSON.stringify(reportPackageHookChange(await applyBulkPackageChange(["review-base"], true), ["review-base"])));
  `);
  assert.deepEqual(reconciled.hookHarnesses, ["codex"], "reconciliation reports hooks from an untouched default composite requirement");
  assert.ok(reconciled.changedPackageIds.includes("review-leaf"));
  assert.match(fs.readFileSync(path.join(reconcileMachine.root, "home", ".codex", "hooks.json"), "utf8"), /recursive-observer/);

  let result = machine.run("package", "enable", "review-top");
  assert.match(result.stdout, /Codex hooks need review: review-leaf/, "transitive hook dependency gets a terminal review hint");
  const portalResult = machine.runScript(`
    const { mutatePackage } = await import(${JSON.stringify(path.join(repoRoot, "scripts/cli/config-mutate.mjs"))});
    const { reportPackageHookChange } = await import(${JSON.stringify(path.join(repoRoot, "scripts/cli/hook-readiness-status.mjs"))});
    console.log(JSON.stringify(reportPackageHookChange(await mutatePackage("review-top", true), ["review-top"])));
  `);
  assert.deepEqual(portalResult.hookHarnesses, ["codex"], "portal reports hooks installed by transitive requirements");
  assert.deepEqual(portalResult.changedPackageIds.sort(), ["review-base", "review-leaf", "review-middle", "review-top"]);
  machine.run("package", "enable", "telemetry");
  result = machine.run("package", "disable", "review-base", "--cascade");
  assert.match(result.stdout, REVIEW_LINE, "cascading through hook-owning dependents checks remaining hook readiness");
  const bulkResult = machine.runScript(`
    const { applyBulkPackageChange } = await import(${JSON.stringify(path.join(repoRoot, "scripts/cli/config-bulk.mjs"))});
    const { reportPackageHookChange } = await import(${JSON.stringify(path.join(repoRoot, "scripts/cli/hook-readiness-status.mjs"))});
    console.log(JSON.stringify(reportPackageHookChange(await applyBulkPackageChange(["review-top"], true), ["review-top"])));
  `);
  assert.ok(bulkResult.hookHarnesses.includes("codex"), "bulk reporting includes transitive hook requirements");
  assert.ok(bulkResult.changedPackageIds.includes("review-leaf"));
  const cascadeResult = machine.runScript(`
    const { disablePackage } = await import(${JSON.stringify(path.join(repoRoot, "scripts/cli/packages.mjs"))});
    const { reportPackageHookChange } = await import(${JSON.stringify(path.join(repoRoot, "scripts/cli/hook-readiness-status.mjs"))});
    const changed = new Set();
    await disablePackage(["review-base", "--cascade"], changed);
    console.log(JSON.stringify(reportPackageHookChange({ ok: true, changedPackageIds: [...changed] }, ["review-base"])));
  `);
  assert.deepEqual(cascadeResult.hookHarnesses, ["codex"], "reporting includes transitive cascade dependents");
  assert.deepEqual(cascadeResult.changedPackageIds.sort(), ["review-base", "review-leaf", "review-middle", "review-top"]);
}

function desktopMachine() {
  const machine = makeMachine("desktop");
  fakeCodex(path.join(machine.root, "bin", "codex"));
  const bundle = path.join(machine.root, "Applications", "ChatGPT.app");
  fs.mkdirSync(path.join(bundle, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string></dict></plist>');
  const bundled = fakeCodex(path.join(bundle, "Contents", "Resources", "codex"));

  machine.run("bundle", "apply", "--default");
  const result = machine.run("package", "enable", "telemetry");
  assert.match(result.stdout, new RegExp(`^  Open Codex's review: ${escape(bundled)}$`, "m"), "both installed: the desktop app's bundled CLI");
}

function makeMachine(name) {
  const root = path.join(tmp, name);
  const home = path.join(root, "home");
  const state = path.join(home, ".roborepo");
  for (const dir of [".codex", ".claude"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.mkdirSync(path.join(root, "Applications"), { recursive: true });
  const launchLog = path.join(root, "codex-launches.log");
  const env = {
    ...process.env,
    HOME: home,
    ROBOREPO_STATE_DIR: state,
    ROBOREPO_WORKSPACE_ROOT: path.join(root, "workspace"),
    ROBOREPO_ON_CONFLICT: "keep",
    PATH: [path.join(root, "bin"), "/usr/bin", "/bin"].join(path.delimiter),
    NODE_ENV: "test",
    ROBOREPO_TEST_DESKTOP_ROOTS: JSON.stringify({ "/Applications": path.join(root, "Applications"), "~/Applications": path.join(root, "user-Applications") }),
    FAKE_CODEX_MODE: "hooks-json",
    FAKE_CODEX_LAUNCH_LOG: launchLog,
  };
  return {
    root,
    state,
    run(...args) {
      const extra = typeof args.at(-1) === "object" ? args.pop() : {};
      const result = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, encoding: "utf8", input: "" });
      assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
      return result;
    },
    runScript(source) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return JSON.parse(result.stdout.trim().split("\n").at(-1));
    },
    codexLaunches: () => (fs.existsSync(launchLog) ? fs.readFileSync(launchLog, "utf8").split("\n").filter(Boolean).length : 0),
  };
}

// Answers discovery's version probe, and otherwise runs the fake app-server.
function fakeCodex(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.155.0"; exit 0; fi\nexec "${process.execPath}" "${fakeServer}" "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function commands(fragment) {
  return Object.entries(fragment).filter(([key]) => !key.startsWith("_"))
    .flatMap(([, groups]) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
}

function count(text, pattern) {
  return text.split("\n").filter((line) => pattern.test(line)).length;
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
