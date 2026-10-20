#!/usr/bin/env node
// Proves the cross-harness hook composition module (scripts/cli/hook-composition.mjs) works for
// both Claude (~/.claude/settings.json) and Codex (~/.codex/hooks.json) via a throwaway fixture
// package, independent of any real package.
//
// The fixture is created under globals/packages/ (not a workspace package) because component.source
// for "hooks"/"rules" resources is resolved via `path.join(repoRoot, component.source)` in
// packages.mjs — a pre-existing assumption (predating this refactor) that source is repoRoot-relative,
// which does not hold for workspace packages (their source is resolved relative to their own package
// dir instead). That mismatch is a latent bug outside this test's scope; using a built-in-style
// fixture sidesteps it and matches how real packages are wired.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvesIntoRepo } from "../cli/hook-composition.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-hook-composition-"));
const fixturePkgDir = path.join(repoRoot, "globals", "packages", "hook-composition-fixture");
fs.mkdirSync(fixturePkgDir, { recursive: true });

const claudeFragment = {
  PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "echo hook-composition-fixture-claude" }] }],
};
const codexFragment = {
  PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "echo hook-composition-fixture-codex" }] }],
};
fs.writeFileSync(path.join(fixturePkgDir, "hooks-claude.json"), JSON.stringify(claudeFragment));
fs.writeFileSync(path.join(fixturePkgDir, "hooks-codex.json"), JSON.stringify(codexFragment));
fs.writeFileSync(path.join(fixturePkgDir, "package.config.json"), JSON.stringify({
  schemaVersion: 1,
  id: "hook-composition-fixture",
  label: "Hook Composition Fixture",
  description: "Throwaway package proving cross-harness hook composition round-trips.",
  lifecycle: "optional",
  presentation: { category: "skills-dev-lifecycle", order: 100 },
  resources: [
    { type: "hooks", harness: "claude", source: "hooks-claude.json" },
    { type: "hooks", harness: "codex", source: "hooks-codex.json" },
  ],
}));

const home = path.join(tmp, "home");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");

const env = {
  ...process.env,
  HOME: home,
  ROBOREPO_STATE_DIR: path.join(home, ".roborepo"),
  SKIP_MCP: "1",
};

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  return result;
}

function claudeHookCommands() {
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  return (settings.hooks?.PreToolUse || []).flatMap((e) => (e.hooks || []).map((h) => h.command));
}

function codexHookCommands() {
  const hooksPath = path.join(home, ".codex", "hooks.json");
  if (!fs.existsSync(hooksPath)) return [];
  const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  return ((parsed.hooks || {}).PreToolUse || []).flatMap((e) => (e.hooks || []).map((h) => h.command));
}

try {
  // --- symlink guard: complete chains back into the repo are refused ---
  {
    const repoTarget = path.join(repoRoot, "globals");
    const linkTwo = path.join(tmp, "hooks-link-two");
    const linkOne = path.join(tmp, "hooks-link-one");
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(repoTarget, linkTwo);
    fs.symlinkSync(linkTwo, linkOne);
    assert.equal(resolvesIntoRepo(linkOne, repoRoot), true, "multi-hop symlink into repo is detected");
    assert.equal(resolvesIntoRepo(outside, repoRoot), false, "ordinary outside directory is allowed");
  }

  // --- enable: both harnesses' hooks land ---
  {
    const enable = run(["package", "enable", "hook-composition-fixture"]);
    assert.equal(enable.status, 0, `enable failed: ${enable.stderr}`);
    assert.ok(claudeHookCommands().includes("echo hook-composition-fixture-claude"), "Claude hook installed on enable");
    assert.ok(codexHookCommands().includes("echo hook-composition-fixture-codex"), "Codex hook installed on enable");
  }

  // --- reapply: idempotent, no duplicates ---
  {
    const reenable = run(["package", "enable", "hook-composition-fixture"]);
    assert.equal(reenable.status, 0, `reapply failed: ${reenable.stderr}`);
    const claudeCount = claudeHookCommands().filter((c) => c === "echo hook-composition-fixture-claude").length;
    const codexCount = codexHookCommands().filter((c) => c === "echo hook-composition-fixture-codex").length;
    assert.equal(claudeCount, 1, "Claude hook not duplicated on reapply");
    assert.equal(codexCount, 1, "Codex hook not duplicated on reapply");
  }

  // --- unrelated user hooks survive ---
  {
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    settings.hooks.PreToolUse.push({ matcher: "", hooks: [{ type: "command", command: "echo user-owned-hook" }] });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(settings, null, 2));

    const codexHooksPath = path.join(home, ".codex", "hooks.json");
    const codexParsed = JSON.parse(fs.readFileSync(codexHooksPath, "utf8"));
    codexParsed.hooks.PreToolUse.push({ matcher: "", hooks: [{ type: "command", command: "echo user-owned-codex-hook" }] });
    fs.writeFileSync(codexHooksPath, JSON.stringify(codexParsed, null, 2));
  }

  // --- disable: both harnesses' owned hooks removed, user hooks survive ---
  {
    const disable = run(["package", "disable", "hook-composition-fixture"]);
    assert.equal(disable.status, 0, `disable failed: ${disable.stderr}`);
    assert.ok(!claudeHookCommands().includes("echo hook-composition-fixture-claude"), "Claude hook removed on disable");
    assert.ok(!codexHookCommands().includes("echo hook-composition-fixture-codex"), "Codex hook removed on disable");
    assert.ok(claudeHookCommands().includes("echo user-owned-hook"), "unrelated Claude user hook survives disable");
    assert.ok(codexHookCommands().includes("echo user-owned-codex-hook"), "unrelated Codex user hook survives disable");
  }

  // --- reapply after disable: stays removed ---
  {
    const redisable = run(["package", "disable", "hook-composition-fixture"]);
    assert.equal(redisable.status, 0, `re-disable failed: ${redisable.stderr}`);
    assert.ok(!claudeHookCommands().includes("echo hook-composition-fixture-claude"), "Claude hook stays removed after re-disable");
    assert.ok(!codexHookCommands().includes("echo hook-composition-fixture-codex"), "Codex hook stays removed after re-disable");
  }

  console.log("ok: cross-harness hook composition round-trips for both Claude and Codex");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(fixturePkgDir, { recursive: true, force: true });
}