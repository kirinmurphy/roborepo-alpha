#!/usr/bin/env node
// Characterizes config-mutate.mjs's setSkillInstalled (skill linking), which resolves
// harness skill dirs from provider manifests rather than a hardcoded Claude/Codex list. Pins the real
// symlink-into-machine-cache behavior: enable materializes a shared skill into the machine-local
// cache then symlinks each present harness's skill dir at it; disable removes both; a native
// (non-managed) skill directory of the same name is left untouched (conflict, not overwrite).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { makeAppRoot } from "./app-root-fixture.mjs";

// Local makeHome on purpose: this check asserts on skill DIRECTORIES only, so it deliberately
// leaves out the root config files the shared makeHome() seeds.
function makeHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-skill-link-home-"));
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  return tmp;
}

function run(appRoot, home, expr) {
  const env = { ...process.env, ROBOREPO_MODE: "development", ROBOREPO_APP_ROOT: appRoot, HOME: home, ROBOREPO_STATE_DIR: path.join(home, ".roborepo"), SKIP_MCP: "1" };
  const result = spawnSync(process.execPath, ["-e", expr], { env, encoding: "utf8" });
  assert.equal(result.status, 0, `expression should succeed: ${result.stderr}\n${result.stdout}`);
  return result;
}

const appRoot = makeAppRoot();
try {
  const skillDir = path.join(appRoot, "globals", "system", "skills", "__char_test_skill__");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: __char_test_skill__\ndescription: Char test.\n---\n\nBody.\n");

  const enableExpr = `import(${JSON.stringify(path.join(appRoot, "scripts", "cli", "config-mutate.mjs"))}).then((m) => { const r = m.setSkillInstalled("__char_test_skill__", true); if (!r.ok) throw new Error(r.message); });`;
  const disableExpr = `import(${JSON.stringify(path.join(appRoot, "scripts", "cli", "config-mutate.mjs"))}).then((m) => { const r = m.setSkillInstalled("__char_test_skill__", false); if (!r.ok) throw new Error(r.message); });`;

  // --- Enable: both present harness skill dirs get a symlink into the machine-local cache ---
  {
    const home = makeHome();
    try {
      run(appRoot, home, enableExpr);
      const claudeLink = path.join(home, ".claude", "skills", "__char_test_skill__");
      const codexLink = path.join(home, ".codex", "skills", "__char_test_skill__");
      assert.ok(fs.lstatSync(claudeLink).isSymbolicLink(), "claude skills dir gets a symlink");
      assert.ok(fs.lstatSync(codexLink).isSymbolicLink(), "codex skills dir gets a symlink");
      const cacheTarget = fs.readlinkSync(claudeLink);
      assert.equal(fs.readlinkSync(codexLink), cacheTarget, "both harnesses link to the same machine-local cache entry");
      assert.match(fs.readFileSync(path.join(cacheTarget, "SKILL.md"), "utf8"), /Char test\./, "cache holds a real copy of the skill source");

      // --- Disable: both symlinks and the cache entry are removed ---
      run(appRoot, home, disableExpr);
      assert.equal(fs.existsSync(claudeLink), false, "claude symlink removed on disable");
      assert.equal(fs.existsSync(codexLink), false, "codex symlink removed on disable");
      assert.equal(fs.existsSync(cacheTarget), false, "machine-local cache entry removed on disable");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // --- Only present harness home dirs are touched (codex absent) ---
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-skill-link-home-"));
    try {
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      run(appRoot, home, enableExpr);
      assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "__char_test_skill__")), "claude linked when present");
      assert.equal(fs.existsSync(path.join(home, ".codex")), false, "codex home never created when absent");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // --- Native (non-managed) skill directory of the same name is left untouched ---
  {
    const home = makeHome();
    try {
      const nativeDir = path.join(home, ".claude", "skills", "__char_test_skill__");
      fs.mkdirSync(nativeDir, { recursive: true });
      fs.writeFileSync(path.join(nativeDir, "SKILL.md"), "native, not builtin-managed\n");
      run(appRoot, home, enableExpr);
      assert.match(
        fs.readFileSync(path.join(nativeDir, "SKILL.md"), "utf8"),
        /native, not builtin-managed/,
        "a pre-existing native (unmanaged) skill directory must not be overwritten",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
} finally {
  fs.rmSync(appRoot, { recursive: true, force: true });
}

console.log("config-mutate-skill-characterization-check: ok");