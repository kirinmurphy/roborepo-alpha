#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-desktop-install-"));
const home = path.join(temp, "home");
const appContents = path.join(temp, "Applications", "ChatGPT.app", "Contents");
const fakeBin = path.join(temp, "bin");
try {
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "which"), '#!/bin/sh\nif [ -x "$FAKE_HARNESS_BIN/$1" ]; then printf "%s\\n" "$FAKE_HARNESS_BIN/$1"; exit 0; fi\nexit 1\n');
  fs.chmodSync(path.join(fakeBin, "which"), 0o755);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(appContents, "Resources"), { recursive: true });
  fs.writeFileSync(path.join(appContents, "Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string></dict></plist>');
  const executable = path.join(appContents, "Resources", "codex");
  fs.writeFileSync(executable, '#!/bin/sh\necho "codex-cli 1.0"\n');
  fs.chmodSync(executable, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_HARNESS_BIN: fakeBin,
    ROBOREPO_STATE_ROOT: path.join(home, ".roborepo"),
    ROBOREPO_ASSUME_INTERACTIVE: "0",
    ROBOREPO_ON_CONFLICT: "overwrite",
    ROBOREPO_PRESETS_ONBOARD: "skip",
    NODE_ENV: "test",
    ROBOREPO_TEST_DESKTOP_ROOTS: JSON.stringify({
      "/Applications": path.join(temp, "Applications"),
      "~/Applications": path.join(temp, "user-Applications"),
      "~/Library/Application Support/Claude/claude-code": path.join(temp, "claude-code"),
    }),
  };
  const installed = spawnSync("bash", ["scripts/install/main.sh"], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  if (process.platform === "darwin") {
    assert.match(installed.stdout, /Codex.*installed, not launched yet/);
    assert.match(installed.stdout, /Launch Codex once, then run roborepo update/);
  }
  assert.equal(fs.existsSync(path.join(home, ".codex")), false, "installer must not create Codex's native home");

  const doctor = spawnSync("bash", ["scripts/doctor.sh", "--quiet"], { cwd: repo, env, encoding: "utf8", timeout: 30_000 });
  if (process.platform === "darwin") assert.match(`${doctor.stdout}\n${doctor.stderr}`, /hint: Launch Codex once, then run roborepo update/);

  const leftoverHome = path.join(temp, "leftover-home");
  fs.mkdirSync(path.join(leftoverHome, ".claude"), { recursive: true });
  const leftoverEnv = { ...env, HOME: leftoverHome, ROBOREPO_STATE_ROOT: path.join(leftoverHome, ".roborepo") };
  const leftoverInstalled = spawnSync("bash", ["scripts/install/main.sh"], { cwd: repo, env: leftoverEnv, encoding: "utf8", timeout: 60_000 });
  assert.equal(leftoverInstalled.status, 0, `${leftoverInstalled.stdout}\n${leftoverInstalled.stderr}`);
  assert.match(leftoverInstalled.stdout, /Claude Code.*configuration present, runtime unavailable/);

  const claudeHome = path.join(temp, "claude-home");
  fs.mkdirSync(path.join(claudeHome, ".claude"), { recursive: true });
  const claudeContents = path.join(temp, "Applications", "Claude.app", "Contents");
  fs.mkdirSync(claudeContents, { recursive: true });
  fs.writeFileSync(path.join(claudeContents, "Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string></dict></plist>');
  const claudeEnv = { ...env, HOME: claudeHome, ROBOREPO_STATE_ROOT: path.join(claudeHome, ".roborepo") };
  const claudeInstalled = spawnSync("bash", ["scripts/install/main.sh"], { cwd: repo, env: claudeEnv, encoding: "utf8", timeout: 60_000 });
  assert.equal(claudeInstalled.status, 0, `${claudeInstalled.stdout}\n${claudeInstalled.stderr}`);
  if (process.platform === "darwin") {
    assert.match(claudeInstalled.stdout, /Claude Code.*installed, setup needed/);
    assert.match(claudeInstalled.stdout, /Open Claude Desktop’s Code tab to install Claude Code/);
  }
  console.log("desktop install presence checks passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
