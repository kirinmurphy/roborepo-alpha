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
try {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(appContents, "Resources"), { recursive: true });
  fs.writeFileSync(path.join(appContents, "Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string></dict></plist>');
  const executable = path.join(appContents, "Resources", "codex");
  fs.writeFileSync(executable, '#!/bin/sh\necho "codex-cli 1.0"\n');
  fs.chmodSync(executable, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    ROBOREPO_STATE_DIR: path.join(home, ".roborepo"),
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
  assert.match(installed.stdout, /Codex.*installed, not launched yet/);
  assert.match(installed.stdout, /Launch Codex once, then run roborepo update/);
  assert.equal(fs.existsSync(path.join(home, ".codex")), false, "installer must not create Codex's native home");

  const doctor = spawnSync("bash", ["scripts/doctor.sh", "--quiet"], { cwd: repo, env, encoding: "utf8", timeout: 30_000 });
  assert.match(`${doctor.stdout}\n${doctor.stderr}`, /hint: Launch Codex once, then run roborepo update/);
  console.log("desktop install presence checks passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
