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
import { detachRepoLink, resolvesIntoRepo } from "../cli/repo-links.mjs";
import { hookFilePath } from "../cli/hook-composition.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { resolveHarnessPath } from "../harnesses/paths.mjs";

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

function run(args, runEnv = env) {
  const result = spawnSync(process.execPath, [cli, ...args], { env: runEnv, encoding: "utf8" });
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
  // --- each provider's declared storage path is used, including Gemini's root config ---
  {
    const claudeOverride = path.join(tmp, "claude-settings.json");
    assert.equal(hookFilePath("claude", { rootConfigPath: claudeOverride }), claudeOverride);
    for (const harness of ["codex", "gemini"]) {
      const manifest = getHarnessProvider(harness).manifest;
      const key = harness === "codex" ? "hooks" : "rootConfig";
      assert.equal(hookFilePath(harness), resolveHarnessPath(manifest, key),
        `${harness} hook file comes from its own manifest`);
    }
  }

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
    assert.equal(resolvesIntoRepo(path.join(linkOne, "new-hooks.json"), repoRoot), true,
      "a new file below a repo-linked directory is still inside the checkout");
    const dangling = path.join(tmp, "dangling-hooks.json");
    fs.symlinkSync(path.join(repoTarget, "not-yet-created-hooks.json"), dangling);
    assert.equal(resolvesIntoRepo(dangling, repoRoot), true,
      "a dangling file link into the checkout is still detected before writing");
    const fakeRepo = path.join(tmp, "fake-repo");
    fs.mkdirSync(fakeRepo);
    const danglingInFakeRepo = path.join(tmp, "dangling-fake-hooks.json");
    fs.symlinkSync(path.join(fakeRepo, "new-hooks.json"), danglingInFakeRepo);
    assert.equal(detachRepoLink(danglingInFakeRepo, fakeRepo), true,
      "a dangling link into the checkout is detached");
    assert.equal(fs.existsSync(danglingInFakeRepo), false);
    const linkedDirectory = path.join(tmp, "linked-directory");
    fs.symlinkSync(fakeRepo, linkedDirectory);
    assert.throws(() => detachRepoLink(path.join(linkedDirectory, "new-hooks.json"), fakeRepo),
      /resolves into the checkout/, "a linked parent directory must not carry writes into the checkout");
  }

  // --- merge order: Codex appends so trusted positions hold; Claude prepends ---
  // Codex keys hook trust by `<file>:<event>:<group index>:<handler index>`, so a merge that moves an
  // existing entry revokes trust the user already granted. Claude treats the first decisive hook
  // result as final, so a package's own hooks still go first there.
  {
    const entry = (command) => ({ matcher: "", hooks: [{ type: "command", command }] });
    const first = { PostToolUse: [entry("echo first-a"), entry("echo first-b")] };
    const second = { PostToolUse: [entry("echo second-a"), entry("echo second-b")] };
    const commandsAt = (content, key) => JSON.parse(content)[key].PostToolUse.map((e) => e.hooks[0].command);

    const codexPath = path.join(tmp, "order-codex-hooks.json");
    const codexHooks = getHarnessProvider("codex").adapters.hooks;
    fs.writeFileSync(codexPath, codexHooks.merge(codexPath, first).content);
    fs.writeFileSync(codexPath, codexHooks.merge(codexPath, second).content);
    assert.deepEqual(
      commandsAt(fs.readFileSync(codexPath, "utf8"), "hooks"),
      ["echo first-a", "echo first-b", "echo second-a", "echo second-b"],
      "Codex merge keeps earlier entries at their indexes and appends the new fragment in order",
    );

    const claudePath = path.join(tmp, "order-claude-settings.json");
    fs.writeFileSync(claudePath, "{}");
    const claudeHooks = getHarnessProvider("claude").adapters.hooks;
    fs.writeFileSync(claudePath, claudeHooks.merge(claudePath, first).content);
    fs.writeFileSync(claudePath, claudeHooks.merge(claudePath, second).content);
    assert.deepEqual(
      commandsAt(fs.readFileSync(claudePath, "utf8"), "hooks"),
      ["echo second-a", "echo second-b", "echo first-a", "echo first-b"],
      "Claude merge still prepends the new fragment, preserving its internal order",
    );
  }

  // --- duplicate commands within one fragment keep the old merge's last-entry winner ---
  {
    const entry = (matcher, command) => ({ matcher, hooks: [{ type: "command", command }] });
    const fragment = { PostToolUse: [
      entry("first", "echo repeated"),
      entry("middle", "echo distinct"),
      entry("last", "echo repeated"),
    ] };
    for (const harness of ["claude", "codex"]) {
      const hooksPath = path.join(tmp, `dedupe-${harness}.json`);
      fs.writeFileSync(hooksPath, "{}");
      const result = getHarnessProvider(harness).adapters.hooks.merge(hooksPath, fragment);
      const groups = JSON.parse(result.content).hooks.PostToolUse;
      assert.deepEqual(groups.map((group) => group.matcher), ["middle", "last"],
        `${harness} preserves the old merge's intra-fragment dedupe`);
    }
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

  // --- legacy links into the checkout: a home whose hook files are symlinks into the repo (the old
  // install layout) gets real files, and the tracked targets are never written through ---
  {
    const linkedHome = path.join(tmp, "linked-home");
    fs.mkdirSync(path.join(linkedHome, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(linkedHome, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(linkedHome, ".codex", "config.toml"), "");
    const trackedSettings = path.join(fixturePkgDir, "tracked-settings.json");
    const trackedCodexHooks = path.join(fixturePkgDir, "tracked-codex-hooks.json");
    fs.writeFileSync(trackedSettings, "{}\n");
    fs.writeFileSync(trackedCodexHooks, `${JSON.stringify({ hooks: {} })}\n`);
    const liveSettings = path.join(linkedHome, ".claude", "settings.json");
    const liveCodexHooks = path.join(linkedHome, ".codex", "hooks.json");
    fs.symlinkSync(trackedSettings, liveSettings);
    fs.symlinkSync(trackedCodexHooks, liveCodexHooks);

    const enable = run(["package", "enable", "hook-composition-fixture"], {
      ...env, HOME: linkedHome, ROBOREPO_STATE_DIR: path.join(linkedHome, ".roborepo"),
    });
    assert.equal(enable.status, 0, `enable through legacy links failed: ${enable.stderr}`);
    assert.equal(fs.readFileSync(trackedSettings, "utf8"), "{}\n", "tracked Claude settings target is not written through");
    assert.equal(fs.readFileSync(trackedCodexHooks, "utf8"), `${JSON.stringify({ hooks: {} })}\n`, "tracked Codex hooks target is not written through");
    for (const live of [liveSettings, liveCodexHooks]) {
      assert.equal(fs.lstatSync(live).isSymbolicLink(), false, `${path.basename(live)} is replaced by a real file`);
    }
    assert.match(fs.readFileSync(liveSettings, "utf8"), /hook-composition-fixture-claude/, "Claude hook lands in the real settings file");
    assert.match(fs.readFileSync(liveCodexHooks, "utf8"), /hook-composition-fixture-codex/, "Codex hook lands in the real hooks file");
  }

  console.log("ok: cross-harness hook composition round-trips for both Claude and Codex");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(fixturePkgDir, { recursive: true, force: true });
}
