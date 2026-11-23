#!/usr/bin/env node
// Doctor's installed-config drift check (scripts/cli/install-drift.mjs) against a fixture home: an
// install that matches this checkout passes, a stale managed permission rule or hook file is named
// with the fix, a rule or file the user added is never reported, and the check writes nothing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const checker = path.join(repoRoot, "scripts", "cli", "install-drift.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-install-drift-"));
const home = path.join(root, "home");
const claude = path.join(home, ".claude");
const settingsPath = path.join(claude, "settings.json");
const pushHook = path.join(claude, "hooks", "protected-branch-push.mjs");
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ROBOREPO_STATE_ROOT: path.join(root, "state"),
  ROBOREPO_SKIP_NODE_RELEASE_CHECK: "1",
  ROBOREPO_SKIP_PROTECTION_CHECK: "1",
};

const run = (args = []) => spawnSync(process.execPath, [checker, ...args], { env, encoding: "utf8" });
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const writeSettings = (settings) => fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().map((rel) => {
    const file = path.join(dir, rel);
    return fs.statSync(file).isFile() ? `${rel}:${fs.readFileSync(file, "utf8")}` : rel;
  });
}

function expectCurrent(label) {
  const result = run();
  assert.equal(result.status, 0, `${label}\n${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, "", label);
}

function expectBehind(label, summary, detail) {
  const result = run();
  assert.equal(result.status, 1, `${label}\n${result.stdout}${result.stderr}`);
  const [first, ...rest] = result.stdout.trimEnd().split("\n");
  assert.equal(first, summary, label);
  assert.ok(rest.some((line) => detail.test(line)), `${label}: no detail line matches ${detail}\n${result.stdout}`);
}

try {
  // A home as `roborepo update` leaves it with the optional hooks bundle selected: the settings the
  // live permission render writes, and the hook and git hook files copied from their sources.
  const presetsState = path.join(root, "state", "presets", "state.json");
  fs.mkdirSync(path.dirname(presetsState), { recursive: true });
  fs.writeFileSync(presetsState, JSON.stringify({ selected: ["hooks"] }));
  fs.cpSync(path.join(repoRoot, "globals", "system", "hooks", "claude"), path.join(claude, "hooks"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "globals", "system", "git-hooks"), path.join(claude, "git-hooks"), { recursive: true });
  fs.writeFileSync(path.join(claude, "MANAGED_BY_ROBOREPO.md"), "managed\n");
  fs.writeFileSync(settingsPath, "{}\n");
  const rendered = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import os from "node:os";
    import { previewPermissionRenders } from ${JSON.stringify(path.join(repoRoot, "scripts", "cli", "permissions-render.mjs"))};
    for (const preview of previewPermissionRenders(os.homedir())) fs.writeFileSync(preview.file, preview.render());
  `], { env, encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  const current = readSettings();
  assert.ok(current.permissions?.allow?.length, "fixture render produced permission rules");
  assert.ok(!current.permissions.ask.includes("Bash(git push:*)"), "this checkout leaves git push to the hook");

  expectCurrent("a home that matches this checkout");

  // A rule the user added themselves, and a hook script beside RoboRepo's, are theirs.
  writeSettings({ ...current, permissions: { ...current.permissions, allow: [...current.permissions.allow, "Bash(my-own-tool:*)"] } });
  fs.writeFileSync(path.join(claude, "hooks", "my-own-hook.mjs"), "// mine\n");
  expectCurrent("a user-owned rule and hook file");

  // The case that prompted this check: an install from before git push moved to the hook.
  writeSettings({ ...current, permissions: { ...current.permissions, ask: [...current.permissions.ask, "Bash(git push:*)"] } });
  expectBehind(
    "a stale managed permission rule",
    "1 permission rule",
    /^ {2}claude: ~\/\.claude\/settings\.json still has ask Bash\(git push:\*\), which this checkout no longer installs$/,
  );
  const before = snapshot(home);
  run();
  assert.deepEqual(snapshot(home), before, "the check writes nothing");

  // Doctor carries it as a warning with the fix, and stays green.
  const doctor = spawnSync("bash", [path.join(repoRoot, "scripts", "doctor.sh"), "--quiet"], { cwd: repoRoot, env, encoding: "utf8" });
  assert.match(
    doctor.stdout,
    /^warn: installed harness config is behind what roborepo update would install: 1 permission rule — run: roborepo update$/m,
    doctor.stdout + doctor.stderr,
  );
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /^ {2}claude: ~\/\.claude\/settings\.json still has ask Bash\(git push:\*\)/m);
  writeSettings(current);

  // A missing core hook entry in settings is one update would add back.
  const hookless = structuredClone(current);
  hookless.hooks.PreToolUse = hookless.hooks.PreToolUse
    .filter((group) => !group.hooks.some((hook) => hook.command.includes("protected-branch-push.mjs")));
  writeSettings(hookless);
  expectBehind("a missing managed hook entry", "1 hook entry", /missing the PreToolUse hook `node "\$HOME\/\.claude\/hooks\/protected-branch-push\.mjs"`/);
  writeSettings(current);

  // An older copy of a managed hook file.
  fs.writeFileSync(pushHook, "// an older protected-branch-push hook\n");
  expectBehind(
    "a stale managed hook file",
    "1 hook file",
    /^ {2}~\/\.claude\/hooks\/protected-branch-push\.mjs differs from globals\/system\/hooks\/claude\/protected-branch-push\.mjs$/,
  );

  // One the user edited after RoboRepo wrote it says update keeps it.
  const stateFile = path.join(root, "state", "config-state", "managed-files.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ [pushHook]: "0".repeat(64) }));
  expectBehind("a hand-edited managed hook file", "1 hook file", /was edited by hand .* update keeps your copy/);

  // With the hooks bundle off, update neither installs nor refreshes hook files, so none count.
  fs.writeFileSync(presetsState, JSON.stringify({ selected: [] }));
  expectCurrent("a stale hook file whose bundle is off");
  fs.writeFileSync(presetsState, JSON.stringify({ selected: ["hooks"] }));
  fs.rmSync(stateFile);

  // A hook file of a selected bundle that is not installed at all is one update would add.
  fs.rmSync(pushHook);
  expectBehind(
    "a missing managed hook file",
    "1 hook file",
    /^ {2}~\/\.claude\/hooks\/protected-branch-push\.mjs is not installed \(from globals\/system\/hooks\/claude\/protected-branch-push\.mjs\)$/,
  );
  fs.copyFileSync(path.join(repoRoot, "globals", "system", "hooks", "claude", "protected-branch-push.mjs"), pushHook);
  expectCurrent("the hook file restored");

  // A settings file update would create is reported, not written.
  fs.rmSync(settingsPath);
  expectBehind("a missing settings file", "1 missing config file", /^ {2}~\/\.claude\/settings\.json is not installed$/);
  assert.ok(!fs.existsSync(settingsPath), "the check does not create the settings file");

  // A check that cannot read the home exits 2, never the 1 that means a difference.
  fs.mkdirSync(settingsPath);
  const broken = run();
  assert.equal(broken.status, 2, broken.stdout + broken.stderr);
  fs.rmSync(settingsPath, { recursive: true });
  writeSettings(current);

  // With no RoboRepo install in the home there is nothing to compare.
  fs.rmSync(path.join(claude, "MANAGED_BY_ROBOREPO.md"));
  expectCurrent("a home RoboRepo never installed into");

  console.log("install drift check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
