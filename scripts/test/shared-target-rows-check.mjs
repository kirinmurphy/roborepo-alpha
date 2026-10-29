#!/usr/bin/env node
// Core hooks share their targets with package installs: ~/.codex/hooks.json takes package hook
// entries, and ~/.codex/hooks/ and ~/.claude/hooks/ take package scripts. These checks prove the
// `hook_fragment` and `managed_files` manifest rows install core hooks beside package hooks without
// moving them (Codex keys trust by position), and remove only what RoboRepo wrote.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostHarnessIsolationEnv } from "./portal-ui/host-harness-isolation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");
const rowsCli = path.join(repoRoot, "scripts/cli/shared-target-rows.mjs");
const coreCodex = JSON.parse(fs.readFileSync(path.join(repoRoot, "generated/codex/hooks.json"), "utf8")).hooks;
// Every file the row installs, including ones in subdirectories (git/), as paths relative to hooks/.
const coreHooksSource = path.join(repoRoot, "globals/harnesses/codex/hooks");
const coreScripts = fs.readdirSync(coreHooksSource, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(coreHooksSource, path.join(entry.parentPath, entry.name)));
// The conflict cases edit top-level scripts.
const topLevelScripts = coreScripts.filter((name) => !name.includes(path.sep));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-shared-target-rows-"));
try {
  standalonePermissionManifestDiscovery();
  baseInstallShipsTheGitHooksItsConfigPointsAt();
  coreHooksInstallAfterPackageHooks();
  scriptCopiesFollowConflictPolicy();
  linksOutsideTheCheckoutAreNeverWrittenThrough();
  retiredScriptsDoNotOutliveTheirSource();
  console.log("shared-target-rows-check: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The base root configs point agent git at <home>/git-hooks. A base-only install must ship that
// directory, or agent shells would run no git hooks at all: not the push backstop, and not the
// repo's own hooks either.
function baseInstallShipsTheGitHooksItsConfigPointsAt() {
  const { home, env } = makeHome("base-only");
  run(env, cli, "bundle", "apply", "base");
  const source = path.join(repoRoot, "globals/system/git-hooks");
  for (const harness of [".claude", ".codex"]) {
    for (const name of fs.readdirSync(source)) {
      const installed = path.join(home, harness, "git-hooks", name);
      assert.ok(fs.existsSync(installed), `base installs ${harness}/git-hooks/${name}`);
      assert.equal(fs.statSync(installed).mode & 0o111, fs.statSync(path.join(source, name)).mode & 0o111, `${harness}/git-hooks/${name} keeps its mode`);
    }
  }
}

function coreHooksInstallAfterPackageHooks() {
  const { home, env } = makeHome("bundle");
  run(env, cli, "bundle", "apply", "--default");
  run(env, cli, "package", "enable", "telemetry");
  const hooksPath = path.join(home, ".codex", "hooks.json");
  const before = handlerPositions(hooksPath);
  fs.mkdirSync(path.join(home, ".codex", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "hooks", "package-script.mjs"), "// package\n");

  const installed = JSON.parse(run({ ...env, ...hostHarnessIsolationEnv(home) }, "--input-type=module", "-e", `
    import { installCoreHooks } from ${JSON.stringify(new URL("../cli/hook-core-install.mjs", import.meta.url).href)};
    console.log(JSON.stringify(await installCoreHooks("codex")));
  `));
  assert.equal(installed.ok, true, "portal core installer applies the real bundle");
  assert.equal(installed.status.groups.find((group) => group.owner === "core").state, "unknown",
    "installation works without Codex, but cannot claim hooks are trusted");
  assert.equal(installed.status.reviewLaunch.supported, false, "no launcher is offered without a runtime");
  const after = handlerPositions(hooksPath);
  for (const [command, position] of before) {
    assert.equal(after.get(command), position, `package hook kept its trust position: ${command}`);
  }
  for (const command of commands(coreCodex)) assert.ok(after.has(command), `core hook installed: ${command}`);
  for (const script of coreScripts) assert.ok(fs.existsSync(path.join(home, ".codex", "hooks", script)), `core script copied: ${script}`);
  for (const script of coreScripts.filter((name) => fs.statSync(path.join(coreHooksSource, name)).mode & 0o111)) {
    assert.ok(fs.statSync(path.join(home, ".codex", "hooks", script)).mode & 0o111, `core script stays executable: ${script}`);
  }
  assert.equal(fs.readdirSync(path.join(home, ".codex")).some((name) => name.startsWith("hooks_update_")), false,
    "no staged merge-review copy: the core hooks installed instead of colliding");
  assert.match(run(env, cli, "bundle", "check", "hooks"), /ok: hooks/);

  run(env, cli, "bundle", "apply", "hooks");
  assert.deepEqual([...handlerPositions(hooksPath)], [...after], "reapplying the bundle changes nothing");

  const withoutLabels = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  for (const entries of Object.values(withoutLabels.hooks)) {
    for (const entry of entries) for (const hook of entry.hooks || []) delete hook.statusMessage;
  }
  fs.writeFileSync(hooksPath, JSON.stringify(withoutLabels));
  run(env, cli, "bundle", "apply", "hooks");
  const labelled = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const labels = Object.values(labelled.hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks || []))
    .map((hook) => hook.statusMessage).filter(Boolean);
  assert.deepEqual(labels.sort(), ["RoboRepo: command permissions", "RoboRepo: concise command output", "RoboRepo: protected branch push", "RoboRepo: unmanaged skills check"].sort(),
    "reapplying upgrades the native review labels on existing core hooks");
  assert.deepEqual([...handlerPositions(hooksPath)], [...after], "labelling preserves every hook's command and position");
  run(env, cli, "bundle", "apply", "hooks");
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksPath, "utf8")), labelled, "label reconciliation is idempotent");

  run(env, cli, "bundle", "remove", "hooks");
  const removed = handlerPositions(hooksPath);
  assert.deepEqual([...removed], [...before], "removal leaves exactly the package hooks, at their positions");
  assert.ok(fs.existsSync(path.join(home, ".codex", "hooks", "package-script.mjs")), "package script survives removal");
  for (const script of coreScripts) assert.ok(!fs.existsSync(path.join(home, ".codex", "hooks", script)), `core script removed: ${script}`);
}

function scriptCopiesFollowConflictPolicy() {
  const { home, env } = makeHome("policy");
  const hooksDir = path.join(home, ".codex", "hooks");
  const row = ["managed_files", "codex", "globals/harnesses/codex/hooks", hooksDir];
  const [first, second] = topLevelScripts;
  const statePath = path.join(env.ROBOREPO_STATE_DIR, "config-state", "managed-files.json");

  // An older copy RoboRepo wrote and nobody edited is updated in place.
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, first), "// older roborepo copy\n");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, files: { [path.join(hooksDir, first)]: sha256("// older roborepo copy\n") } }));
  // A copy the user edited is not RoboRepo's to overwrite.
  fs.writeFileSync(path.join(hooksDir, second), "// user edit\n");

  const abort = spawnSync(process.execPath, [rowsCli, "apply", ...row], { env: { ...env, ROBOREPO_ON_CONFLICT: "abort" }, encoding: "utf8" });
  assert.notEqual(abort.status, 0, "abort policy stops on an edited copy");
  assert.equal(fs.readFileSync(path.join(hooksDir, second), "utf8"), "// user edit\n");

  run({ ...env, ROBOREPO_ON_CONFLICT: "keep" }, rowsCli, "apply", ...row);
  assert.equal(fs.readFileSync(path.join(hooksDir, first), "utf8"), source(first), "unedited older copy updated");
  assert.equal(fs.readFileSync(path.join(hooksDir, second), "utf8"), "// user edit\n", "keep policy leaves the edit");
  const stem = path.basename(second, path.extname(second));
  assert.ok(fs.readdirSync(hooksDir).some((name) => name.startsWith(`${stem}_update_`)), "keep policy stages RoboRepo's version");

  assert.match(run(env, rowsCli, "remnants", ...row), new RegExp(escape(first)), "the owned copy is reported as a remnant");
  run(env, rowsCli, "remove", ...row);
  assert.ok(!fs.existsSync(path.join(hooksDir, first)), "owned copy removed");
  assert.equal(fs.readFileSync(path.join(hooksDir, second), "utf8"), "// user edit\n", "edited copy survives removal");
  assert.equal(run(env, rowsCli, "remnants", ...row).trim(), "", "nothing RoboRepo owns is left");

  run({ ...env, ROBOREPO_ON_CONFLICT: "overwrite" }, rowsCli, "apply", ...row);
  assert.equal(fs.readFileSync(path.join(hooksDir, second), "utf8"), source(second), "overwrite policy replaces the edit");
  assert.ok(fs.readdirSync(hooksDir).some((name) => name.startsWith(`${stem}_original_`)), "overwrite policy backs up the edit");
}

// A user can link a hook script to their own copy elsewhere (a dotfiles repo). Even when that file
// matches what RoboRepo last recorded, an update must not write into it.
function linksOutsideTheCheckoutAreNeverWrittenThrough() {
  const { home, env } = makeHome("links");
  const hooksDir = path.join(home, ".codex", "hooks");
  const row = ["managed_files", "codex", "globals/harnesses/codex/hooks", hooksDir];
  const [script] = topLevelScripts;
  const external = path.join(tmp, "links-dotfiles", script);
  fs.mkdirSync(path.dirname(external), { recursive: true });
  fs.writeFileSync(external, "// my dotfiles copy\n");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.symlinkSync(external, path.join(hooksDir, script));
  recordHashes(env, { [path.join(hooksDir, script)]: sha256("// my dotfiles copy\n") });

  run({ ...env, ROBOREPO_ON_CONFLICT: "keep" }, rowsCli, "apply", ...row);
  assert.equal(fs.readFileSync(external, "utf8"), "// my dotfiles copy\n", "keep: the linked file is untouched");
  assert.ok(fs.lstatSync(path.join(hooksDir, script)).isSymbolicLink(), "keep: the link stays");
  assert.equal(run(env, rowsCli, "remnants", ...row).includes(script), false, "a link is never reported as RoboRepo's");

  run(env, rowsCli, "remove", ...row);
  assert.ok(fs.lstatSync(path.join(hooksDir, script)).isSymbolicLink(), "removal leaves the user's link");

  run({ ...env, ROBOREPO_ON_CONFLICT: "overwrite" }, rowsCli, "apply", ...row);
  assert.equal(fs.readFileSync(external, "utf8"), "// my dotfiles copy\n", "overwrite: the linked file is untouched");
  assert.equal(fs.lstatSync(path.join(hooksDir, script)).isSymbolicLink(), false, "overwrite: a regular file replaces the link");
  assert.equal(fs.readFileSync(path.join(hooksDir, script), "utf8"), source(script));
}

// A script a later version renames or drops must not stay installed from an earlier one.
function retiredScriptsDoNotOutliveTheirSource() {
  const { home, env } = makeHome("retired");
  const hooksDir = path.join(home, ".codex", "hooks");
  const row = ["managed_files", "codex", "globals/harnesses/codex/hooks", hooksDir];
  fs.mkdirSync(hooksDir, { recursive: true });
  const retired = path.join(hooksDir, "renamed-away.mjs");
  const edited = path.join(hooksDir, "dropped-but-edited.mjs");
  fs.writeFileSync(retired, "// shipped by an older version\n");
  fs.writeFileSync(edited, "// user edit\n");
  recordHashes(env, { [retired]: sha256("// shipped by an older version\n"), [edited]: sha256("// shipped originally\n") });

  assert.match(run(env, rowsCli, "remnants", ...row), /renamed-away\.mjs/, "uninstall's remnant check sees the retired copy");
  run(env, rowsCli, "apply", ...row);
  assert.ok(!fs.existsSync(retired), "update removes an unedited script whose source is gone");
  assert.equal(fs.readFileSync(edited, "utf8"), "// user edit\n", "an edited one stays with the user");

  // Uninstall reaches a retired script too, from the hash record alone.
  fs.writeFileSync(retired, "// shipped by an older version\n");
  recordHashes(env, { [retired]: sha256("// shipped by an older version\n") });
  run(env, rowsCli, "remove", ...row);
  assert.ok(!fs.existsSync(retired), "uninstall removes a retired script");
}

function recordHashes(env, files) {
  const statePath = path.join(env.ROBOREPO_STATE_DIR, "config-state", "managed-files.json");
  let current = {};
  try { current = JSON.parse(fs.readFileSync(statePath, "utf8")).files; } catch {}
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, files: { ...current, ...files } }));
}

function makeHome(name) {
  const home = path.join(tmp, name);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  return { home, env: { ...process.env, HOME: home, ROBOREPO_STATE_DIR: path.join(home, ".roborepo"), ROBOREPO_ON_CONFLICT: "keep" } };
}

function run(env, script, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  assert.equal(result.status, 0, `${path.basename(script)} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

// Codex's trust key is "<file>:<event>:<group index>:<handler index>", so the position is the key.
function handlerPositions(hooksPath) {
  const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8")).hooks;
  const positions = new Map();
  for (const [event, groups] of Object.entries(hooks)) {
    groups.forEach((group, groupIndex) => group.hooks.forEach((hook, handlerIndex) => {
      positions.set(hook.command, `${event}:${groupIndex}:${handlerIndex}`);
    }));
  }
  return positions;
}

function commands(fragment) {
  return Object.values(fragment).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
}

function source(name) {
  return fs.readFileSync(path.join(repoRoot, "globals/harnesses/codex/hooks", name), "utf8");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function standalonePermissionManifestDiscovery() {
  const { home, env } = makeHome("standalone");
  const sourcePath = path.join(repoRoot, "globals/harnesses/codex/hooks/permission-check.mjs");
  const installed = path.join(home, "permission-check.mjs");
  fs.copyFileSync(sourcePath, installed);
  const input = JSON.stringify({ tool_name: "exec_command", tool_input: { command: "git push --force origin main" } });
  const cleanEnv = { ...env };
  delete cleanEnv.REPO_ROOT;
  delete cleanEnv.ROBOREPO_STATE_ROOT;
  delete cleanEnv.ROBOREPO_STATE_DIR;
  function decision(script, overrides) {
    const result = spawnSync(process.execPath, [script], { env: { ...cleanEnv, ...overrides }, input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
  }
  assert.equal(decision(sourcePath, {}), "deny", "provider source finds its checkout manifest without install state");
  assert.equal(decision(installed, {}), "ask", "missing manifest retains conservative classification");
  assert.equal(decision(installed, { REPO_ROOT: repoRoot }), "deny", "explicit repository root works for standalone copy");
  for (const variable of ["ROBOREPO_STATE_ROOT", "ROBOREPO_STATE_DIR"]) {
    for (const [file, key] of [["app-root.json", "appRoot"], ["install-state.json", "repo"]]) {
      const state = path.join(home, variable, file.replace(".json", ""));
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, file), JSON.stringify({ [key]: repoRoot }));
      assert.equal(decision(installed, { [variable]: state }), "deny", `${variable} discovers ${file}`);
    }
  }
}
