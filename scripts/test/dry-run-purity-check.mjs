#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertDryRunClean, dryRunRoots } from "./lib/assert-dry-run-clean.mjs";

// Every command that accepts --dry-run makes the same promise: preview, mutate nothing. That was
// asserted per-command by hand, so it held only for the paths a given test happened to snapshot —
// `workspace-resources.mjs --dry-run` created the entire workspace scaffold and no test noticed,
// because no test snapshotted the workspace root around that command.
//
// The command list is derived from the catalog rather than hardcoded, so a newly added --dry-run
// command is covered here the moment it is registered instead of whenever someone remembers.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

const { loadCommandCatalog, listCommandNodes } = await import("../cli/command-catalog.mjs");

// Commands that cannot be exercised as a bare `--dry-run` in a sandbox, with the reason. Each is
// still covered elsewhere; this list exists so "not run here" is a stated decision rather than an
// accidental gap.
const SKIP = new Map([
  ["package enable", "requires a package id argument"],
  ["package disable", "requires a package id argument"],
  ["package adopt-live", "requires a package id argument"],
  ["harness withdraw", "requires a harness id argument"],
  ["skill link-project", "requires a target project path"],
  ["mcp add", "requires a server name and command"],
  // Interactive: prompts for confirmation before it would reach the dry-run preview.
  ["maintenance uninstall", "covered by managed-uninstall-check against real fixtures"],
]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-dry-run-purity-"));
let failures = 0;
try {
  const commands = dryRunCommands();
  assert.ok(commands.length > 0, "expected the catalog to declare at least one --dry-run command");

  for (const tokens of commands) {
    const name = tokens.join(" ");
    if (SKIP.has(name)) {
      console.log(`skip: ${name} (${SKIP.get(name)})`);
      continue;
    }
    runCase(name, tokens);
  }

  // The specific regression this helper was built for: a command whose dry run threads dryRun into
  // its own writes but not into a setup step it calls first. Driven as a module entry point because
  // that is how install/main.sh invokes it.
  runModuleCase("workspace-resources.mjs", [path.join(repoRoot, "scripts/cli/workspace-resources.mjs")]);

  testWatcherSeesEveryRoot();

  assert.equal(failures, 0, `${failures} command(s) mutated state under --dry-run`);
  console.log("dry-run purity checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The watcher's own negative control: write into each watched root and assert the helper notices.
//
// This is what caught two holes in the helper itself. Its first version watched only the harness
// homes, ~/.local/bin, and the state/workspace roots — omitting the shell profiles, which is exactly
// where this phase's dangling-`source`-line defect lived. And because hashDirectory throws ENOTDIR
// on a plain file, adding the profiles alone would have made snapshot() return a constant
// "<unreadable>" on both sides of every comparison, silently reporting success for any profile
// change. A watcher that cannot see the path it watches is worse than none, because it passes.
function testWatcherSeesEveryRoot() {
  const dirs = sandbox("watcher-self-check");
  // A pre-existing profile, so the file branch is exercised as an append rather than a create.
  fs.writeFileSync(path.join(dirs.home, ".zshrc"), "existing\n");
  const roots = dryRunRoots(dirs);

  const blind = [];
  for (const root of roots) {
    const leak = `const fs=require("fs"),p=${JSON.stringify(root)};`
      + `try{if(fs.statSync(p).isFile()){fs.appendFileSync(p,"LEAK\\n")}`
      + `else{fs.mkdirSync(p+"/leak",{recursive:true})}}catch{fs.mkdirSync(p,{recursive:true})}`;
    let caught = false;
    try {
      assertDryRunClean({
        label: `watcher self-check ${root}`,
        argv: [process.execPath, "-e", leak],
        cwd: repoRoot,
        env: envFor(dirs),
        roots,
      });
    } catch {
      caught = true;
    }
    if (!caught) blind.push(root);
  }

  report("watcher sees every root it claims to watch", () => {
    assert.deepEqual(blind, [], `the dry-run watcher is blind to:\n  ${blind.join("\n  ")}`);
  });
}

function dryRunCommands() {
  return listCommandNodes(loadCommandCatalog())
    .filter((entry) => entry.node.kind !== "namespace")
    .filter((entry) => JSON.stringify(entry.node).includes("--dry-run"))
    .map((entry) => entry.tokens);
}

// A fresh sandbox per case: a leak from one command must not mask or cause a later one.
function sandbox(label) {
  const home = path.join(tmp, label.replace(/[^a-z0-9]+/gi, "-"));
  const stateRoot = path.join(home, ".roborepo");
  const workspaceRoot = path.join(stateRoot, "workspace");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  return { home, stateRoot, workspaceRoot };
}

function envFor({ home, stateRoot, workspaceRoot }) {
  return {
    ...process.env,
    HOME: home,
    ROBOREPO_STATE_ROOT: stateRoot,
    ROBOREPO_WORKSPACE_ROOT: workspaceRoot,
    // Never let a dry run open the interactive wizard: it would block on input rather than preview.
    ROBOREPO_PRESETS_ONBOARD: "skip",
  };
}

function runCase(name, tokens) {
  const dirs = sandbox(name);
  report(name, () => assertDryRunClean({
    label: `roborepo ${name} --dry-run`,
    argv: [process.execPath, cli, ...tokens, "--dry-run"],
    cwd: repoRoot,
    env: envFor(dirs),
    roots: dryRunRoots(dirs),
  }));
}

function runModuleCase(name, argv) {
  const dirs = sandbox(name);
  report(name, () => assertDryRunClean({
    label: `${name} --dry-run`,
    argv: [process.execPath, ...argv, "--dry-run"],
    cwd: repoRoot,
    env: envFor(dirs),
    roots: dryRunRoots(dirs),
  }));
}

// Collect every violation rather than stopping at the first: the point of a sweep is to report the
// whole surface at once, so one leak does not hide the others behind it.
function report(name, run) {
  try {
    run();
    console.log(`ok: ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL: ${name}\n${err.message}`);
  }
}
