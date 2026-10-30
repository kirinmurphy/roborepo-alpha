#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isolateGitConfig } from "./lib/git-config.mjs";
import { loadCommandCatalog, listCommandNodes } from "../cli/command-catalog.mjs";
import { readConfigSnapshot } from "../cli/config.mjs";
import { menuItems, menuTitle } from "../cli/interactive-menu-items.mjs";
import { repoRoot } from "../cli/paths.mjs";

const cliPath = path.join(repoRoot, "scripts", "cli", "main.mjs");
const catalog = loadCommandCatalog();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-cli-surface-"));
isolateGitConfig(workDir);
const generatedPermissionFiles = [
  path.join(repoRoot, "generated", "claude", "settings.json"),
  path.join(repoRoot, "generated", "codex", "config.toml"),
  path.join(repoRoot, "generated", "codex", "rules", "default.rules"),
  path.join(repoRoot, "generated", "gemini", "policies", "generated-permissions.toml"),
];
const generatedBaseline = gitGeneratedStatus();

try {
  const env = {
    ...process.env,
    HOME: path.join(workDir, "home"),
    GENERATED_HOME: generatedHomeForRepo(repoRoot),
    ROBOREPO_STATE_ROOT: path.join(workDir, "state"),
    SKIP_MCP: "1",
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(env.ROBOREPO_STATE_ROOT, { recursive: true });
  // This suite exercises the command surface and the root menu, not the first-run workflow. A bare
  // `roborepo` on an uninitialized install now routes to `init` (see cli/first-run-routing.mjs), so
  // the sandbox is seeded as already-initialized to reach the menu under test. First-run routing
  // itself is covered by scripts/test/initialization-lifecycle-check.mjs.
  markInitialized(env.ROBOREPO_STATE_ROOT);

  assertCli(["help"], { env, stdout: /Primary commands:/ });

  for (const { tokens, node } of listCommandNodes(catalog, { includeInternal: false, includeAdvanced: true })) {
    const expectedTitle = new RegExp(`roborepo ${escapeRegExp(tokens.join(" "))}\\b`);
    assertCli(["help", ...tokens], { env, stdout: expectedTitle });
    if (node.kind === "namespace") {
      assertCli(tokens, { env, input: "\n", stdout: /Select a number \(or blank to cancel\):/ });
    }
  }

  assertInteractiveMenuRedraw({ env });
  assertIndentedSelectionMarker({ env });
  assertMenuHeaderTemplate();
  assertInteractiveHelpPause({ env });
  assertSilentCommandReturnsToMenu({ env });
  assertRemoteSyncMenuFlow({ env });
  assertCli(["web", "stop"], { env, stdout: /roborepo portal: no server was running/ });
  assertSkillMenuSections();
  assertTelemetryMenuSections();
  assertPackageLibraryLabels();
  assertRootAgentConfigOrder();
  assertConfigMenuCollapsedRoot();
  assertSubmenuNavigation();

  console.log("cli surface integration checks passed");
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
  // Reported from `finally` so a mid-suite failure still surfaces a write into this checkout — but
  // printed rather than thrown, because throwing here would replace the real assertion error with
  // this one and hide why the suite actually failed. The exit code is set instead.
  reportRepoGeneratedUnchanged();
}

// The suite runs the real CLI against a temp HOME/state dir, but appRoot still points at this
// checkout — so anything that renders into generated/ writes to tracked files, stamping a temp path
// like /T/roborepo-cli-surface-XXXX into generated/claude/settings.json. That lands in the working
// tree, gets committed by accident, and ships a permission rule scoped to a directory that no
// longer exists. Fail loudly here instead: a test may read this checkout, never write to it.
function reportRepoGeneratedUnchanged() {
  const dirty = gitGeneratedStatus();
  if (dirty === null || dirty === generatedBaseline) return;
  console.error(
    `\nthe suite modified tracked generated/ files; tests must not write into this checkout:\n${dirty}`,
  );
  process.exitCode = 1;
}

function gitGeneratedStatus() {
  const result = spawnSync("git", ["status", "--porcelain", "--", "generated"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  // No git (or not a checkout) means nothing to protect — skip rather than fail the whole suite.
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function assertCli(args, { env, input = "", status = 0, stdout, stderr } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env,
    input,
    encoding: "utf8",
  });
  assert.equal(result.status, status, `roborepo ${args.join(" ")} exit\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  if (stdout) assert.match(result.stdout, stdout, `roborepo ${args.join(" ")} stdout`);
  if (stderr) assert.match(result.stderr, stderr, `roborepo ${args.join(" ")} stderr`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSkillMenuSections() {
  const sections = menuItems(catalog, catalog.nodes.skill, ["skill"])
    .filter((item) => item.header)
    .map((item) => item.header);
  assert.deepEqual(sections.slice(0, 4), ["Project Skills", "Global Skills", "Inspection", "Repository Data"]);
}

function assertTelemetryMenuSections() {
  const items = menuItems(catalog, catalog.nodes.telemetry, ["telemetry"]);
  const sections = items.filter((item) => item.header).map((item) => item.header);
  const labels = items.map((item) => item.header || item.label);
  assert.deepEqual(sections.slice(0, 3), ["Lifecycle", "Monitoring", "Data Management"]);
  assert(!labels.includes("Stop"), "portal stop should not appear in normal telemetry menu");
}

// The telemetry package presents under Monitoring, not Token Optimization: the catalog
// reorganization that split rules from diagnostics moved it there alongside Capture Dense Bash,
// and renamed its label to "Token Telemetry". Both are asserted here so a future move breaks this
// check rather than silently showing the package under a stale heading.
function assertPackageLibraryLabels() {
  const behaviorView = readConfigSnapshot().behaviorView;
  const section = behaviorView.find((s) => s.category === "Monitoring");
  const labels = section?.items.map((item) => item.label) || [];
  assert(labels.includes("Token Telemetry"), "telemetry package should show product label in Package Library");
  assert(!labels.includes("/telemetry-marker"), "Monitoring should not show telemetry slash-command label");

  // The rule behind the two assertions above, stated so it holds for packages that do not exist yet:
  // a `/command` label is only correct when the command restates the package's own name. Telemetry
  // broke this by exposing /telemetry-marker while being called "Token Telemetry", and the breakage
  // was invisible because every other command-backed package happened to satisfy the rule.
  const commandLabeled = behaviorView
    .filter((s) => s.category !== "Permissions")
    .flatMap((s) => s.items)
    .filter((item) => typeof item.label === "string" && item.label.startsWith("/"));
  assert(commandLabeled.length > 0, "expected at least one command-labeled package");
  for (const item of commandLabeled) {
    const words = item.label.slice(1).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const idWords = String(item.id).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    assert(
      words.every((word) => idWords.includes(word)),
      `package ${item.id} is labeled ${item.label} but the command does not restate its name; `
        + "a product that merely ships a command must keep its prose label",
    );
  }
}

function assertRootAgentConfigOrder() {
  const items = menuItems(catalog, null, []);
  const labels = items.map((item) => item.header || item.label);
  assert(labels.indexOf("Packages") < labels.indexOf("Agent Files"), "Agent Files should follow Packages");
  assert(labels.indexOf("Agent Files") < labels.indexOf("Skills"), "Agent Files should be above Skills");
}

function assertConfigMenuCollapsedRoot() {
  const items = menuItems(catalog, catalog.nodes.config, ["config"]);
  const labels = items.map((item) => item.header || item.label);
  assert(labels.includes("Inspect root config"), "config menu should expose root inspect directly");
  assert(!labels.includes("Root config"), "single-child root config namespace should be collapsed in menu");
  assert.deepEqual(
    items.find((item) => item.label === "Inspect root config")?.value.tokens,
    ["config", "root", "inspect"],
    "collapsed root inspect should preserve full command tokens",
  );
}

function assertSubmenuNavigation() {
  const labels = menuItems(catalog, catalog.nodes.config, ["config"]).map((item) => item.header || item.label);
  assert(!labels.includes("Support"), "submenus should not include global Support section");
  assert(labels.includes("Navigation"), "submenus should include Navigation section");
  assert(labels.includes("Help"), "submenu Navigation should include contextual Help");
  assert(labels.includes("Back"), "submenus should include Back");
  assert(labels.includes("Exit"), "submenus should include Exit");
}

function assertMenuHeaderTemplate() {
  assert.equal(
    stripAnsi(menuTitle(catalog, null, [], { text: "doctor passed (99 checks)", level: "success" })),
    "** doctor passed (99 checks)\n\n=========== ROBOREPO - Main Menu ===========\n\n",
  );
  assert.equal(
    stripAnsi(menuTitle(catalog, catalog.nodes.package, ["package"])),
    "=========== ROBOREPO - Packages ============\nEsc - return to previous menu\n\n",
  );
  assert.match(menuTitle(catalog, null, [], { text: "ok", level: "success" }), /\x1b\[1;32m\*\* ok/);
  assert.match(menuTitle(catalog, null, [], { text: "warn", level: "warning" }), /\x1b\[1;33m\*\* warn/);
  assert.match(menuTitle(catalog, null, [], { text: "bad", level: "error" }), /\x1b\[1;31m\*\* bad/);
}

function assertInteractiveHelpPause({ env }) {
  const script = `
    set timeout 5
    spawn -noecho ${process.execPath} ${cliPath}
    send "\\033\\[B\\033\\[B\\033\\[B\\033\\[B\\033\\[B\\033\\[B\\033\\[B\\033\\[B\\033\\[B\\r"
    expect "Press any key to return to menu"
    send " "
    expect "ROBOREPO - Main Menu"
    send "q"
    expect eof
  `;
  const result = spawnSync("expect", ["-c", script], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });

  if (result.error?.code === "ENOENT") {
    console.log("skipped interactive help PTY check (expect not found)");
    return;
  }

  assert.equal(result.status, 0, `interactive help PTY exit\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function assertSilentCommandReturnsToMenu({ env }) {
  const before = readGeneratedPermissionFiles();
  const script = `
    set timeout 10
    spawn -noecho ${process.execPath} ${cliPath}
    send "\\033\\[B\\033\\[B\\033\\[B\\033\\[B\\r"
    expect "ROBOREPO - Agent Files"
    send "\\033\\[B\\033\\[B\\033\\[B\\r"
    expect "** config permissions completed"
    expect "ROBOREPO - Agent Files"
    send "q"
    expect eof
  `;
  const result = spawnSync("expect", ["-c", script], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });

  if (result.error?.code === "ENOENT") {
    console.log("skipped silent command PTY check (expect not found)");
    return;
  }

  assert.equal(result.status, 0, `silent command PTY exit\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(
    readGeneratedPermissionFiles(),
    before,
    "fake HOME menu command should not rewrite tracked generated permission files",
  );
}

function assertRemoteSyncMenuFlow({ env }) {
  const scanRoot = path.join(workDir, "remote-sync-scan");
  const resultFile = path.join(workDir, "remote-sync-result.json");
  const repo = makeRemoteSyncFixture(scanRoot);
  const script = `
    set timeout 20
    spawn -noecho $env(EXPECT_NODE) $env(EXPECT_CLI) git remote-sync-check $env(EXPECT_SCAN_ROOT) --menu
    expect "Scanning remote state..."
    expect "Remote Sync Check"
    expect "./sync-work"
    expect "./sync-work-extra"
    expect "Could not verify remote state"
    expect "./sync-work-broken"
    send "\\033\\[B\\033\\[B\\r"
    expect "./sync-work-broken"
    send "\\r"
    expect "Could not verify remote state"
    expect "Inspect:"
    expect "Retry:"
    expect "git fetch origin"
    expect "Press Enter to continue"
    send "\\r"
    expect "Remote Sync Check"
    expect "1 branch ahead"
    send "\\r"
    expect "Show unpushed commits"
    expect "Push branch to upstream"
    send "\\r"
    expect "./sync-work"
    expect "ahead"
    send "\\r"
    expect "./sync-work"
    expect "Checkout:"
    expect "Push:"
    expect "remote sync local commit"
    expect "Press Enter to continue"
    send "\\r"
    expect {
      "Scanning remote state..." { exit 41 }
      "Show unpushed commits" {}
      timeout { exit 42 }
    }
    send "\\033\\[B\\033\\[B\\033\\[B\\r"
    expect "./sync-work"
    expect "ahead"
    send "\\r"
    expect "Push ahead to origin/main?"
    send "\\r"
    expect {
      "Scanning remote state..." { exit 43 }
      "Show unpushed commits" {}
      timeout { exit 44 }
    }
    send "\\033\\[B\\033\\[B\\033\\[B\\r"
    expect "ahead"
    send "\\r"
    expect "Push ahead to origin/main?"
    send "y\\r"
    expect "Push complete."
    expect "Press Enter to continue"
    send "\\r"
    expect "Remote Sync Check"
    expect "./sync-work-extra"
    send "q"
    expect eof
  `;
  const result = spawnSync("expect", ["-c", script], {
    cwd: repoRoot,
    env: {
      ...env,
      EXPECT_NODE: process.execPath,
      EXPECT_CLI: cliPath,
      EXPECT_SCAN_ROOT: scanRoot,
      INTERACTIVE_RESULT_FILE: resultFile,
    },
    encoding: "utf8",
  });

  if (result.error?.code === "ENOENT") {
    console.log("skipped remote-sync PTY check (expect not found)");
    return;
  }

  assert.equal(result.status, 0, `remote-sync PTY exit\nrepo: ${repo}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(
    result.stdout,
    /\x1b\[H\x1b\[2J[\s\S]*Show unpushed commits/,
    "remote-sync menu should clear the repository list before drawing repository actions",
  );
  assert.match(
    result.stdout,
    /Back\s+\x1b\[H\x1b\[2J[\s\S]*Remote Sync Check/,
    "remote-sync menu should clear repository actions before returning to the repository list",
  );
  const finalScreen = finalScreenFromAnsi(result.stdout);
  assert.match(finalScreen, /^> \.\/sync-work-extra\b/m, `single-repo refresh should leave other cached ahead repos in the main list\n${finalScreen}`);
  assert.match(finalScreen, /^    \.\/sync-work-broken\b.*verification failure/m, `failed repo should remain a selectable diagnostic row\n${finalScreen}`);
  assert.doesNotMatch(finalScreen, /^    \.\/sync-work-extra\b.*verification failure/m, `single-repo refresh should not re-verify unrelated repos\n${finalScreen}`);
  const payload = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.equal(payload.notice.text, "Remote sync check complete");
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeRemoteSyncFixture(scanRoot) {
  const origin = path.join(workDir, "remote-sync-origin.git");
  const originExtra = path.join(workDir, "remote-sync-origin-extra.git");
  const originBroken = path.join(workDir, "remote-sync-origin-broken.git");
  const seed = path.join(workDir, "remote-sync-seed");
  const seedExtra = path.join(workDir, "remote-sync-seed-extra");
  const seedBroken = path.join(workDir, "remote-sync-seed-broken");
  const repo = path.join(scanRoot, "sync-work");
  const repoExtra = path.join(scanRoot, "sync-work-extra");
  const repoBroken = path.join(scanRoot, "sync-work-broken");
  fs.mkdirSync(scanRoot, { recursive: true });

  seedRemote(origin, seed);
  seedRemote(originExtra, seedExtra);
  seedRemote(originBroken, seedBroken);

  runGit(["clone", origin, repo]);
  runGit(["switch", "-c", "ahead", "origin/main"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "local.txt"), "local\n");
  runGit(["add", "."], { cwd: repo });
  commit(repo, "remote sync local commit");

  runGit(["clone", originExtra, repoExtra]);
  runGit(["switch", "-c", "extra-ahead", "origin/main"], { cwd: repoExtra });
  fs.writeFileSync(path.join(repoExtra, "extra.txt"), "extra\n");
  runGit(["add", "."], { cwd: repoExtra });
  commit(repoExtra, "extra remote sync local commit");

  runGit(["clone", originBroken, repoBroken]);
  runGit(["remote", "set-url", "origin", `${originBroken}-missing`], { cwd: repoBroken });

  const hook = path.join(origin, "hooks", "post-receive");
  fs.writeFileSync(hook, `#!/bin/sh\nmv ${originExtra} ${originExtra}.offline 2>/dev/null || true\n`);
  fs.chmodSync(hook, 0o755);

  return repo;
}

function seedRemote(origin, seed) {
  runGit(["init", "--bare", "--initial-branch=main", origin]);
  runGit(["init", "--initial-branch=main"], { cwd: seed, mkdir: true });
  fs.writeFileSync(path.join(seed, "base.txt"), "base\n");
  runGit(["add", "."], { cwd: seed });
  commit(seed, "base");
  runGit(["remote", "add", "origin", origin], { cwd: seed });
  runGit(["push", "-u", "origin", "main"], { cwd: seed });
}

function commit(cwd, message) {
  runGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message], { cwd });
}

function runGit(args, options = {}) {
  if (options.mkdir) fs.mkdirSync(options.cwd, { recursive: true });
  const result = spawnSync("git", args, { cwd: options.cwd || repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function markInitialized(stateDir) {
  const timestamp = new Date().toISOString();
  fs.writeFileSync(
    path.join(stateDir, "initialization.json"),
    JSON.stringify({
      schemaVersion: 1,
      workflowVersion: 1,
      status: "complete",
      startedAt: timestamp,
      completedAt: timestamp,
    }, null, 2) + "\n",
  );
}

function generatedHomeForRepo(root) {
  return path.join(path.sep, "Users", "you");
}

function readGeneratedPermissionFiles() {
  return Object.fromEntries(
    generatedPermissionFiles.map((file) => [path.relative(repoRoot, file), fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null]),
  );
}

function assertInteractiveMenuRedraw({ env }) {
  const script = `
    set timeout 5
    spawn -noecho ${process.execPath} ${cliPath}
    send "\\033\\[B\\033\\[B\\033\\[Aq"
    expect eof
  `;
  const result = spawnSync("expect", ["-c", script], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });

  if (result.error?.code === "ENOENT") {
    console.log("skipped interactive menu PTY check (expect not found)");
    return;
  }

  assert.equal(result.status, 0, `interactive menu PTY exit\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const screen = finalScreenFromAnsi(result.stdout);
  assert.equal((screen.match(/ROBOREPO - Main Menu/g) || []).length, 1, `menu title duplicated after redraw\n${screen}`);
  assert.equal((screen.match(/^> /gm) || []).length, 1, `menu selection duplicated after redraw\n${screen}`);
  assert.match(screen, /^  Agent Config$/m, `root menu missing Agent Config section\n${screen}`);
  // Primary actions sit at the two-column selector gutter ("  " when unselected, "> " when
  // selected) rather than the four-space child indent used for namespace members. Matching either
  // gutter keeps this about indentation, which is what it tests, instead of about which row the
  // keypress sequence happens to land on — that shifts whenever a primary command is added.
  assert.match(screen, /^(?:> |  )Open web portal\b/m, `primary action should keep selector gutter\n${screen}`);
  assert.doesNotMatch(screen, /^    Open web portal\b/m, `primary action should not get child indent\n${screen}`);
  // `init` leads the primary actions: it is the first thing a new install needs.
  assert.match(screen, /^(?:> |  )Initialize\b/m, `root menu missing Initialize primary action\n${screen}`);
  assert.match(screen, /^(?:> |  )Package Library\b/m, `root menu missing Package Library primary action\n${screen}`);
  assert.match(screen, /^  Support$/m, `root menu missing Support section\n${screen}`);
  assert.match(screen, /^  Navigation$/m, `root menu missing Navigation section\n${screen}`);
  assert.match(screen, /^    Agent Files\b/m, `root menu missing renamed Agent Files item\n${screen}`);
  assert.match(screen, /^    Doctor\b/m, `root menu missing Support Doctor item\n${screen}`);
  assert.match(screen, /^    Maintenance\b/m, `root menu missing Support Maintenance item\n${screen}`);
  // down, down, up leaves the selector one row below the top item. Asserted by offset rather than
  // by label so adding a primary command (init) does not require re-deriving the expected name;
  // what matters is that the arrow keys moved the selector and left exactly one of it.
  const primaryRows = screen.split("\n").filter((line) => /^(?:> |  )\S/.test(line) && !/^  (?:Agent Config|Support|Navigation)$/.test(line));
  assert.equal(primaryRows[1], screen.split("\n").find((line) => line.startsWith("> ")), `menu did not land on expected row\n${screen}`);
}

function assertIndentedSelectionMarker({ env }) {
  // One down per primary action lands on the first child item under the Agent Config section,
  // which is the indented row this check is about. Derived from the catalog rather than hardcoded
  // so adding a primary command does not silently retarget the assertion at a different row.
  // Primary actions are the leading rows before the first section header.
  const rootItems = menuItems(catalog, null, []);
  const primaryCount = rootItems.findIndex((item) => item.header);
  assert.ok(primaryCount > 0, "root menu should list primary actions before the first section");
  const downs = "\\033\\[B".repeat(primaryCount);
  const script = `
    set timeout 5
    spawn -noecho ${process.execPath} ${cliPath}
    send "${downs}q"
    expect eof
  `;
  const result = spawnSync("expect", ["-c", script], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });

  if (result.error?.code === "ENOENT") {
    console.log("skipped indented selection PTY check (expect not found)");
    return;
  }

  assert.equal(result.status, 0, `indented selection PTY exit\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const screen = finalScreenFromAnsi(result.stdout);
  assert.match(screen, /^  > Packages\b/m, `child selection marker should align with section indent\n${screen}`);
  assert.doesNotMatch(screen, /^>   Packages\b/m, `child selection marker should not stay flush-left\n${screen}`);
}

function finalScreenFromAnsi(value) {
  const rows = [""];
  let row = 0;
  let col = 0;
  let saved = { row: 0, col: 0 };

  const ensureRow = () => {
    while (rows.length <= row) rows.push("");
  };

  const write = (text) => {
    ensureRow();
    const line = rows[row] || "";
    rows[row] = line.slice(0, col) + text + line.slice(col + text.length);
    col += text.length;
  };

  for (let i = 0; i < value.length;) {
    const ch = value[i];
    if (ch === "\x1b" && value[i + 1] === "7") {
      saved = { row, col };
      i += 2;
      continue;
    }
    if (ch === "\x1b" && value[i + 1] === "8") {
      row = saved.row;
      col = saved.col;
      ensureRow();
      i += 2;
      continue;
    }
    if (ch === "\x1b" && value[i + 1] === "[") {
      let j = i + 2;
      while (j < value.length && !/[A-Za-z]/.test(value[j])) j += 1;
      const params = value.slice(i + 2, j);
      const code = value[j];
      const n = Number.parseInt(params, 10) || 1;
      if (code === "A") row = Math.max(0, row - n);
      if (code === "H") {
        row = 0;
        col = 0;
        ensureRow();
      }
      if (code === "K" && (params === "2" || params === "")) {
        ensureRow();
        rows[row] = "";
      }
      if (code === "J") {
        ensureRow();
        rows[row] = rows[row].slice(0, col);
        rows.length = row + 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === "\r") {
      col = 0;
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row += 1;
      col = 0;
      ensureRow();
      i += 1;
      continue;
    }
    write(ch);
    i += 1;
  }

  return rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
}