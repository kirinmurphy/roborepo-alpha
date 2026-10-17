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
  assert.match(result.stdout, /rather than choosing Trust all/);
  assert.match(result.stdout, new RegExp(`^  Open Codex's review: ${escape(pathCodex)}$`, "m"), "CLI-only machine: the PATH binary");

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
