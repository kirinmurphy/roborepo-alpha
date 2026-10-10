#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeResponse } from "./lib/fake-response.mjs";

// Managed uninstall workspace policy, per
// docs/plans/active/infra-packaging-02-install-lifecycle.md Phase 4.
//
// The behavior under test is the one that can destroy user data, so these run the real CLI and the
// real shell uninstall against sandboxed HOME/ROBOREPO_STATE_DIR fixtures rather than asserting on
// a plan object. Before this phase, remove_runtime_state() ended with `remove_path "${state_dir}"`
// — an rm -rf that took <stateRoot>/workspace with it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");
const uninstallSh = path.join(repoRoot, "scripts/install/uninstall.sh");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-managed-uninstall-"));
let caseId = 0;

// Resource ownership inventory (Phase 7).
//
// The state root is the one place roborepo accumulates machine-local state, and
// remove_runtime_state() enumerates what it deletes rather than removing the root wholesale (the
// workspace lives inside it). An enumerated list is safe but not self-maintaining: a new state path
// added to state-paths.mjs is simply missed, and the leftover then fails --check-clean. That is
// exactly how <stateRoot>/package-runtime (package-runtime assets) leaked — projection cleanup pruned the
// files on package disable but never the directory, and uninstall never removed it at all.
//
// Every child of the state root is one of exactly two things:

// Disposable machine state roborepo created — managed uninstall must remove all of it.
const OWNED_STATE_ENTRIES = [
  "command-overrides.json", "enabled-packages.json", "telemetry", "telemetry-backups", "backups",
  "presets", "rules", "config-state", "harnesses", "repositories", "usage", "capture", "portal",
  "skills", "package-runtime", "install-state.json", "initialization.json", "experimental.json",
];
// User-owned content, or a pointer whose fate follows it — preserved by default.
const PRESERVED_STATE_ENTRIES = ["workspace", "workspace-root.json"];
try {
  testNestedWorkspacePreservedByDefault();
  testRelocatedWorkspaceUntouched();
  testDeleteWorkspaceOptIn();
  testRelocatedNeverDeletedEvenWithOptIn();
  testNoninteractiveRefusesWithoutYes();
  testDryRunMutatesNothing();
  testRepeatedUninstallIsSafe();
  testPackageModeRunsNpmUninstall();
  testCheckCleanToleratesPreservedWorkspace();
  testNpmOwnedCliIsNotARemnant();
  testStateRootOwnershipInventory();
  testEveryDeclaredStatePathIsClassified();
  testUninstallWithConfirmedHarnesses();
  await testPortalUninstallRequiresExplicitConfirm();
  testPortalSurfaceIsPreserveOnly();
  console.log("managed uninstall checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function fixture({ relocated = false } = {}) {
  const home = path.join(tmp, `case-${++caseId}`);
  const stateDir = path.join(home, ".roborepo");
  const workspace = relocated ? path.join(home, "elsewhere", "workspace") : path.join(stateDir, "workspace");

  fs.mkdirSync(path.join(workspace, "skills"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "skills", "mine.md"), "USER AUTHORED\n");
  // Disposable machine state that managed cleanup should remove.
  fs.mkdirSync(path.join(stateDir, "telemetry"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "enabled-packages.json"), "{}\n");

  if (relocated) {
    fs.writeFileSync(
      path.join(stateDir, "workspace-root.json"),
      JSON.stringify({ workspaceRoot: workspace }) + "\n",
    );
  }
  return { home, stateDir, workspace, skill: path.join(workspace, "skills", "mine.md") };
}

function env(f, extra = {}) {
  return { ...process.env, HOME: f.home, ROBOREPO_STATE_DIR: f.stateDir, ...extra };
}

function runCli(f, args, extra) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot, env: env(f, extra), encoding: "utf8", input: "",
  });
}

function npmStubEnv(f) {
  const bin = path.join(f.home, "fake-bin");
  const log = path.join(f.home, "npm-args.txt");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/bin/sh\nprintf '%s\\n' "$*" > "${log}"\n`,
    { mode: 0o755 },
  );
  return {
    PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    ROBOREPO_MODE: "package",
    npmLog: log,
  };
}

function testNestedWorkspacePreservedByDefault() {
  const f = fixture();
  const result = runCli(f, ["uninstall", "--yes"]);
  assert.equal(result.status, 0, `uninstall failed:\n${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(f.skill, "utf8"), "USER AUTHORED\n", "workspace bytes must survive");
  assert.ok(!fs.existsSync(path.join(f.stateDir, "telemetry")), "disposable state must be removed");
  assert.ok(!fs.existsSync(path.join(f.stateDir, "enabled-packages.json")), "package registry must be removed");
  assert.match(result.stdout, /preserved/i, "result must tell the user the workspace was kept");
  assert.match(result.stdout, /Development checkout application files were not removed/, "dev checkout must not claim npm removal");
}

function testRelocatedWorkspaceUntouched() {
  const f = fixture({ relocated: true });
  const result = runCli(f, ["uninstall", "--yes"]);
  assert.equal(result.status, 0, `uninstall failed:\n${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(f.skill, "utf8"), "USER AUTHORED\n", "relocated workspace must survive");
  assert.ok(
    fs.existsSync(path.join(f.stateDir, "workspace-root.json")),
    "the pointer must survive alongside the tree it names, so a reinstall can still find it",
  );
}

function testDeleteWorkspaceOptIn() {
  const f = fixture();
  const result = runCli(f, ["uninstall", "--yes", "--delete-workspace"]);
  assert.equal(result.status, 0, `uninstall failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(!fs.existsSync(f.workspace), "explicit opt-in deletes a nested workspace");
  assert.ok(
    !fs.existsSync(path.join(f.stateDir, "workspace-root.json")),
    "the pointer goes with the tree when the tree is deleted",
  );
}

// The load-bearing safety property: a workspace the user deliberately relocated is never deleted by
// roborepo, even when deletion was explicitly requested. roborepo did not create that location.
function testRelocatedNeverDeletedEvenWithOptIn() {
  const f = fixture({ relocated: true });
  const result = runCli(f, ["uninstall", "--yes", "--delete-workspace"]);
  assert.equal(result.status, 0, `uninstall failed:\n${result.stdout}\n${result.stderr}`);
  assert.equal(
    fs.readFileSync(f.skill, "utf8"),
    "USER AUTHORED\n",
    "--delete-workspace must NOT reach a relocated workspace",
  );
  assert.match(result.stdout, /preserved/i, "and must say so rather than silently ignoring the flag");
}

function testNoninteractiveRefusesWithoutYes() {
  const f = fixture();
  const result = runCli(f, ["uninstall"]);
  assert.equal(result.status, 2, "destructive + noninteractive without --yes must refuse");
  assert.match(result.stderr, /--yes|--dry-run/, "refusal must name the way forward");
  assert.ok(fs.existsSync(f.skill), "nothing may be removed on refusal");
  assert.ok(fs.existsSync(path.join(f.stateDir, "telemetry")), "nothing may be removed on refusal");
}

function testDryRunMutatesNothing() {
  const f = fixture();
  const result = runCli(f, ["uninstall", "--dry-run"]);
  assert.equal(result.status, 0, `dry-run failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(fs.existsSync(f.skill), "dry run must not touch the workspace");
  assert.ok(fs.existsSync(path.join(f.stateDir, "telemetry")), "dry run must not remove state");

  // --dry-run wins over --delete-workspace: previewing a destructive option must not perform it.
  const f2 = fixture();
  runCli(f2, ["uninstall", "--dry-run", "--delete-workspace"]);
  assert.ok(fs.existsSync(f2.workspace), "dry run must not delete even when opt-in is passed");
}

function testRepeatedUninstallIsSafe() {
  const f = fixture();
  const first = runCli(f, ["uninstall", "--yes"]);
  assert.equal(first.status, 0, `first uninstall failed:\n${first.stderr}`);
  const second = runCli(f, ["uninstall", "--yes"]);
  assert.equal(second.status, 0, `repeated uninstall must be safe:\n${second.stdout}\n${second.stderr}`);
  assert.equal(fs.readFileSync(f.skill, "utf8"), "USER AUTHORED\n", "workspace still intact after two runs");
}

function testPackageModeRunsNpmUninstall() {
  const f = fixture();
  const stub = npmStubEnv(f);
  const result = runCli(f, ["uninstall", "--yes"], stub);
  assert.equal(result.status, 0, `package-mode uninstall failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(
    fs.readFileSync(stub.npmLog, "utf8").trim(),
    /^uninstall -g(?: --prefix .+)? codethings-roborepo-alpha$/,
    "package-mode uninstall must remove the globally installed npm package",
  );
  assert.match(result.stdout, /npm package has been uninstalled/i, "result must report npm package removal");
}

// A preserved workspace legitimately keeps the state root alive, so --check-clean must not report
// that as unclean; genuine leftovers still must fail it.
function testCheckCleanToleratesPreservedWorkspace() {
  const f = fixture();
  runCli(f, ["uninstall", "--yes"]);
  const clean = spawnSync("bash", [uninstallSh, "--check-clean"], { cwd: repoRoot, env: env(f), encoding: "utf8" });
  assert.equal(clean.status, 0, `preserved workspace must not count as a remnant:\n${clean.stderr}`);

  fs.mkdirSync(path.join(f.stateDir, "telemetry"), { recursive: true });
  const dirty = spawnSync("bash", [uninstallSh, "--check-clean"], { cwd: repoRoot, env: env(f), encoding: "utf8" });
  assert.equal(dirty.status, 1, "genuine leftover state must still be reported");
  assert.match(dirty.stderr, /remnant/, "and must name what was left behind");
}

// An npm-owned CLI binary is not a remnant, and reporting it as one had teeth.
//
// npm's global bin is wherever the prefix points. On a machine configured with `prefix=~/.local`
// (nvm and Homebrew both produce this), npm installs its binary to the SAME path the shell
// installer uses — ~/.local/bin/roborepo. The remnant check listed that path unconditionally, so a
// correct npm install always looked like leftover state.
//
// That nonzero exit was the gate on the npm handoff in uninstall.mjs, so the check suppressed the
// `npm uninstall` that removes the binary: it survived, and because initialization.json lives in
// the preserved state root, the surviving binary then re-ran onboarding. Observed on a real clean
// machine before this was fixed.
//
// Ownership is read from the link target: npm's points into node_modules, the shell installer's
// points into a checkout. A real shell-installer remnant at the same path must still be reported.
function testNpmOwnedCliIsNotARemnant() {
  if (process.platform === "win32") {
    console.log("skip: npm-owned CLI remnant (POSIX symlink semantics)");
    return;
  }
  // No `uninstall` run first, deliberately: that path removes the shell-installer link as part of
  // its work, which would leave nothing for --check-clean to judge and make this pass either way.
  // The unit under test is the remnant check's ownership call, so the fixture stages the link
  // directly and invokes --check-clean on its own.
  const f = fixture();
  // fixture() seeds disposable state so the other cases have something to remove. It would be
  // reported here and mask the assertion, so clear it: the CLI entry must be the only thing
  // --check-clean has an opinion about.
  fs.rmSync(path.join(f.stateDir, "telemetry"), { recursive: true, force: true });
  fs.rmSync(path.join(f.stateDir, "enabled-packages.json"), { force: true });

  const binDir = path.join(f.home, ".local/bin");
  const cliEntry = path.join(binDir, "roborepo");
  fs.mkdirSync(binDir, { recursive: true });

  // npm-owned: target lives under node_modules. Expected mid-uninstall; npm removes it.
  const npmPackage = path.join(f.home, "npm-prefix/lib/node_modules/codethings-roborepo-alpha/bin");
  fs.mkdirSync(npmPackage, { recursive: true });
  fs.writeFileSync(path.join(npmPackage, "roborepo"), "#!/bin/sh\n");
  fs.symlinkSync(path.join(npmPackage, "roborepo"), cliEntry);

  const npmOwned = spawnSync("bash", [uninstallSh, "--check-clean"], { cwd: repoRoot, env: env(f), encoding: "utf8" });
  assert.equal(npmOwned.status, 0, `an npm-owned binary must not be reported as a remnant:\n${npmOwned.stderr}`);
  assert.doesNotMatch(npmOwned.stderr, /remnant.*bin\/roborepo/, "and must not be named as one");

  // Shell-installer-owned at the same path: still a genuine remnant.
  fs.unlinkSync(cliEntry);
  const checkout = path.join(f.home, "checkout/bin");
  fs.mkdirSync(checkout, { recursive: true });
  fs.writeFileSync(path.join(checkout, "roborepo"), "#!/bin/sh\n");
  fs.symlinkSync(path.join(checkout, "roborepo"), cliEntry);

  const installerOwned = spawnSync("bash", [uninstallSh, "--check-clean"], { cwd: repoRoot, env: env(f), encoding: "utf8" });
  assert.equal(installerOwned.status, 1, "a shell-installer binary at the same path is still a remnant");
  assert.match(installerOwned.stderr, /remnant/, "and must be named");
}

// --- Managed uninstall on a machine where the harnesses are actually installed.
//
// Every other fixture here creates ~/.claude and ~/.codex but puts no executable on PATH, so
// discovery grades them "possible" (home-only evidence). A real user's machine grades "confirmed"
// (executable + home/config), which is a different branch of normalizeConfidence and therefore a
// different set of providers reported as detected. Uninstall iterates detected providers, so the
// cohort it walks here is genuinely larger than in the other cases.
//
// Stub executables rather than real ones: the check is about which discovery branch runs, not about
// the harnesses' behavior, and requiring real installs would make this unrunnable in CI — the exact
// reason harness-cli-check.mjs documents skipping it.
//
// POSIX-only, like the rest of this file (which drives bash uninstall scripts): the `#!/bin/sh`
// stubs are resolved by `which`, and discovery uses `where` on win32. Skipped there rather than
// silently asserting nothing.
function testUninstallWithConfirmedHarnesses() {
  if (process.platform === "win32") {
    console.log("skip: confirmed-harness uninstall (POSIX-only stub executables)");
    return;
  }
  const f = fixture();
  const binDir = path.join(f.home, "stub-bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const exe of ["claude", "codex", "gemini"]) {
    const stub = path.join(binDir, exe);
    fs.writeFileSync(stub, "#!/bin/sh\necho stub\n");
    fs.chmodSync(stub, 0o755);
  }
  // Config alongside the home dir, so evidence is executable + config -> confirmed.
  fs.mkdirSync(path.join(f.home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(f.home, ".claude", "settings.json"), '{"model":"opus"}\n');

  const withStubs = { PATH: `${binDir}:${process.env.PATH}` };
  const refresh = runCli(f, ["harness", "refresh"], withStubs);
  assert.equal(refresh.status, 0, `harness refresh failed:\n${refresh.stdout}${refresh.stderr}`);
  assert.match(
    refresh.stdout,
    /confirmed/,
    `stub executables must raise at least one provider to confirmed\n${refresh.stdout}`,
  );

  const result = runCli(f, ["uninstall", "--yes"], withStubs);
  assert.equal(result.status, 0, `uninstall failed with confirmed harnesses:\n${result.stdout}${result.stderr}`);
  assert.equal(fs.readFileSync(f.skill, "utf8"), "USER AUTHORED\n", "workspace must survive");
  assert.ok(
    fs.existsSync(path.join(f.home, ".claude", "settings.json")),
    "a user's own root config must survive managed uninstall",
  );
}

// --- Resource ownership inventory (Phase 7). See OWNED_STATE_ENTRIES near the top of this file.

// Seeds every owned entry, runs a real managed uninstall, and asserts the state root is left holding
// nothing but the preserved workspace. Catches a leak directly rather than via a --check-clean
// failure whose message names only the symptom.
function testStateRootOwnershipInventory() {
  const f = fixture();
  for (const entry of OWNED_STATE_ENTRIES) {
    const target = path.join(f.stateDir, entry);
    if (entry.endsWith(".json")) fs.writeFileSync(target, "{}\n");
    else {
      fs.mkdirSync(path.join(target, "nested"), { recursive: true });
      fs.writeFileSync(path.join(target, "nested", "asset"), "disposable\n");
    }
  }
  const result = runCli(f, ["uninstall", "--yes"]);
  assert.equal(result.status, 0, `uninstall failed:\n${result.stdout}\n${result.stderr}`);

  const leftover = fs.readdirSync(f.stateDir).sort();
  assert.deepEqual(
    leftover, ["workspace"],
    `managed uninstall must leave only the preserved workspace; leaked: ${leftover.join(", ")}`,
  );
  assert.equal(fs.readFileSync(f.skill, "utf8"), "USER AUTHORED\n", "workspace bytes still intact");
}

// The list above is only trustworthy while it matches what the code actually writes. state-paths.mjs
// is the single declaration point for state-root paths, so every path it exports must be classified
// as owned or preserved. Adding a state path without deciding its removal disposition fails here,
// at the point of introduction, instead of silently leaking into a user's state root.
function testEveryDeclaredStatePathIsClassified() {
  const source = fs.readFileSync(path.join(repoRoot, "scripts/cli/state-paths.mjs"), "utf8");
  const classified = new Set([...OWNED_STATE_ENTRIES, ...PRESERVED_STATE_ENTRIES]);

  // Both shapes that name a state-root child: path.join(stateDir, "<name>", ...) and the
  // portalPidPathForPort helper's joined form.
  const declared = new Set();
  for (const match of source.matchAll(/path\.join\(\s*stateDir\s*,\s*"([^"]+)"/g)) {
    declared.add(match[1]);
  }
  assert.ok(declared.size > 0, "failed to parse any state paths — the parser, not the code, is stale");

  const unclassified = [...declared].filter((name) => !classified.has(name)).sort();
  assert.deepEqual(
    unclassified, [],
    `state-paths.mjs declares state-root ${unclassified.length === 1 ? "entry" : "entries"} `
      + `[${unclassified.join(", ")}] that managed uninstall does not classify. Add each to `
      + `OWNED_STATE_ENTRIES (and to remove_runtime_state() in scripts/install/uninstall-lib.sh) or `
      + `to PRESERVED_STATE_ENTRIES.`,
  );

  // The owned list must also stay in sync with the shell that does the removing.
  const lib = fs.readFileSync(path.join(repoRoot, "scripts/install/uninstall-lib.sh"), "utf8");
  const removeBlock = lib.slice(lib.indexOf("remove_runtime_state()"), lib.indexOf("remove_durable_install_backups()"));
  const missing = OWNED_STATE_ENTRIES.filter((entry) => !removeBlock.includes(`\${state_dir}/${entry}`));
  assert.deepEqual(missing, [], `remove_runtime_state() never removes: ${missing.join(", ")}`);
}

// --- Portal surface. Exercised through the route handler directly rather than over HTTP against a
// detached `roborepo web`: the security-relevant behavior (explicit-confirm gate, preserve-only
// semantics, error mapping) is all handler-side, and a real detached server strands a process when
// the test's sandboxed HOME does not match the one holding its PID file — which hung this suite.
// The origin+token guard runs in portal-server.mjs before dispatch and is covered by that layer.
function fakeReq({ method, body }) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const listeners = {};
  return {
    method,
    headers: { "content-type": "application/json" },
    on(event, handler) {
      listeners[event] = handler;
      // Deliver the body synchronously on the next tick so readJsonBody's data/end wiring runs.
      if (event === "end") {
        queueMicrotask(() => {
          if (payload && listeners.data) listeners.data(Buffer.from(payload));
          handler();
        });
      }
      return this;
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function testPortalUninstallRequiresExplicitConfirm() {
  // Driven through dispatchRoutes rather than a bespoke entry point: maintenance is a route table
  // like every other portal domain, so the test exercises the same path portal-server takes.
  const { maintenanceRoutes } = await import(path.join(repoRoot, "scripts/cli/portal-routes-maintenance.mjs"));
  const { dispatchRoutes } = await import(path.join(repoRoot, "scripts/cli/portal-router.mjs"));
  const dispatch = (req, res, urlPath, qs, handlers) =>
    dispatchRoutes([maintenanceRoutes], req, res, urlPath, qs, handlers);
  const f = fixture();

  // Stubs, deliberately: this test is about the route's own gating, not about cleanup itself
  // (which the CLI cases above cover against real fixtures). A stub that throws if called proves
  // the unconfirmed request never reaches removal.
  const handlers = {
    uninstallPreview: () => ({ ok: true, workspacePreserved: true, removals: [], npmCommand: "npm uninstall -g x" }),
    uninstallExecute: () => { throw new Error("execute must not be reached without explicit confirm"); },
  };

  // A POST without { confirm: true } must be rejected by the handler itself, before any removal.
  const res = fakeResponse();
  const handled = dispatch(fakeReq({ method: "POST", body: {} }), res, "/api/maintenance/uninstall", "", handlers);
  assert.equal(handled, true, "handler must claim the uninstall route");
  await settle();
  assert.equal(res.statusCode, 400, "POST without explicit confirm must be refused");
  assert.match(res.body || "", /confirm/i, "refusal must name the missing confirmation");
  assert.ok(fs.existsSync(f.skill), "refused POST must not mutate anything");

  // Unknown maintenance paths fall through so portal-server can try the next domain / 404.
  assert.equal(
    dispatch(fakeReq({ method: "GET" }), fakeResponse(), "/api/maintenance/nope", "", handlers),
    false,
    "unmatched maintenance paths must not be claimed",
  );
}

// The portal surface can never delete a workspace: uninstallExecute pins the flag off, so there is
// no request shape that reaches workspace deletion through the browser.
function testPortalSurfaceIsPreserveOnly() {
  const source = fs.readFileSync(path.join(repoRoot, "scripts/cli/uninstall.mjs"), "utf8");
  const executeBlock = source.slice(source.indexOf("export function uninstallExecute"));
  assert.match(
    executeBlock.slice(0, executeBlock.indexOf("}\n\n")),
    /ROBOREPO_UNINSTALL_DELETE_WORKSPACE: "0"/,
    "portal execute must hard-code workspace preservation",
  );
  // Strip comments first: the module explains in prose why deletion is absent, and matching that
  // sentence would make this assert the opposite of what it means to check.
  const routes = fs.readFileSync(path.join(repoRoot, "scripts/cli/portal-routes-maintenance.mjs"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(routes, /deleteWorkspace/, "the portal route must not expose a deletion option");
}
