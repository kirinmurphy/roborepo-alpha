#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Initialization state + first-run routing.
//
// The state-record assertions run in-process against a sandboxed ROBOREPO_STATE_DIR. The routing
// assertions call the pure decision function rather than spawning a PTY: the rule under test is
// "which route does (argv, phase, tty) select", and a real terminal adds no coverage while making
// the test unrunnable in CI.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-init-lifecycle-"));
const stateDir = path.join(tmp, ".roborepo");
process.env.ROBOREPO_STATE_DIR = stateDir;

const { resolveFirstRunRoute } = await import("../cli/first-run-routing.mjs");
const {
  readInitializationState,
  writeInitializationState,
  validateInitializationState,
  beginInitialization,
  completeInitialization,
  initializationPhase,
  isInitializationComplete,
  WORKFLOW_VERSION,
} = await import("../cli/initialization-state.mjs");
const { initializationStatePath } = await import("../cli/state-paths.mjs");
const { harnessStatePath } = await import("../cli/state-paths.mjs");
const { workspaceRoot, STATE_ROOT: stateRoot } = await import("../cli/roots.mjs");
const { ensureInitialized, finalizeInitialization, describeNewerSchemaRefusal } = await import("../cli/initialization-bootstrap.mjs");
const { browserRedirectMessage, extractPortalUrl, resolveFirstRunConfigurationMode } = await import("../cli/initialize.mjs");

try {
  testMissingState();
  testBeginLeavesInProgress();
  testCompleteMarksComplete();
  testResumePreservesStartedAt();
  testCorruptStateReadsAsMissing();
  testSchemaValidation();
  testStatePathIsSandboxed();
  testFirstRunRouting();
  testExplicitCommandsBypassInit();
  testAliasReachesSameImplementation();
  testNewerRecordIsNeverOverwritten();
  testBrowserRedirectMessage();
  testInitDryRunShowsConfigurationChoice();
  testEnsureInitializedBootstrapsMissing();
  testEnsureInitializedIsIdempotent();
  testEnsureInitializedResumesInProgress();
  testEnsureInitializedRefusesNewerSchema();
  testEnsureInitializedDryRunDoesNotMutate();
  testEnsureInitializedForceRebootstrapsComplete();
  testInterruptedInitConfigStaysInProgressAndResumes();
  testInitResumesInterruptedConfigNotAlreadyInitialized();
  testWebRefusesNewerSchemaThroughRealCli();
  testResolveFirstRunConfigurationMode();
  console.log("initialization lifecycle checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function resetState() {
  fs.rmSync(initializationStatePath, { force: true });
}

// --- missing: never initialized. Directory existence must NOT imply initialization, which is the
// whole reason this record exists separately from the workspace/state dirs. ---
function testMissingState() {
  resetState();
  fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
  assert.equal(readInitializationState(), null, "absent record reads as null");
  assert.equal(initializationPhase(), "missing", "an existing workspace dir must not imply initialization");
  assert.equal(isInitializationComplete(), false);
}

function testBeginLeavesInProgress() {
  resetState();
  const state = beginInitialization();
  assert.equal(state.status, "in-progress");
  assert.equal(state.completedAt, null, "completedAt stays null until the workflow finishes");
  assert.equal(state.workflowVersion, WORKFLOW_VERSION);
  assert.equal(initializationPhase(), "in-progress", "an interrupted run is resumable, not complete");
  assert.equal(isInitializationComplete(), false);
}

function testCompleteMarksComplete() {
  resetState();
  beginInitialization();
  const state = completeInitialization();
  assert.equal(state.status, "complete");
  assert.ok(state.completedAt, "completedAt is required once complete");
  assert.equal(initializationPhase(), "complete");
  assert.equal(isInitializationComplete(), true);
}

// --- Re-entering an interrupted init keeps the original startedAt, so the record reports when the
// user first tried rather than when they last retried. ---
function testResumePreservesStartedAt() {
  resetState();
  const first = beginInitialization({ now: () => "2020-01-01T00:00:00.000Z" });
  const resumed = beginInitialization({ now: () => "2026-01-01T00:00:00.000Z" });
  assert.equal(resumed.startedAt, first.startedAt, "resume must not reset startedAt");

  const finished = completeInitialization({ now: () => "2026-01-02T00:00:00.000Z" });
  assert.equal(finished.startedAt, first.startedAt, "completion must not reset startedAt");
  assert.equal(finished.completedAt, "2026-01-02T00:00:00.000Z");
}

// --- A broken state file must not lock a user out of their own first run: unreadable and
// never-started have the same recovery (run init), so both read as "missing". ---
function testCorruptStateReadsAsMissing() {
  resetState();
  fs.mkdirSync(path.dirname(initializationStatePath), { recursive: true });
  fs.writeFileSync(initializationStatePath, "{ not json");
  assert.equal(readInitializationState(), null, "unparseable record reads as missing");
  assert.equal(initializationPhase(), "missing");

  fs.writeFileSync(initializationStatePath, JSON.stringify({ schemaVersion: 99, status: "complete" }));
  assert.equal(readInitializationState(), null, "unknown schemaVersion reads as missing, not complete");
}

function testSchemaValidation() {
  assert.throws(() => validateInitializationState({}), /schemaVersion/);
  assert.throws(
    () => validateInitializationState({ schemaVersion: 1, workflowVersion: 1, status: "bogus", startedAt: new Date().toISOString(), completedAt: null }),
    /status must be one of/,
  );
  // completedAt is mandatory once complete — otherwise "complete" could not be distinguished from
  // an in-progress record that merely had its status flipped.
  assert.throws(
    () => validateInitializationState({ schemaVersion: 1, workflowVersion: 1, status: "complete", startedAt: new Date().toISOString(), completedAt: null }),
    /completedAt is required/,
  );
  assert.throws(
    () => writeInitializationState({ schemaVersion: 1, workflowVersion: 0, status: "in-progress", startedAt: new Date().toISOString(), completedAt: null }),
    /workflowVersion/,
  );
}

function testStatePathIsSandboxed() {
  assert.ok(
    initializationStatePath.startsWith(stateDir),
    `initialization state must honor ROBOREPO_STATE_DIR, got ${initializationStatePath}`,
  );
  assert.equal(path.basename(initializationStatePath), "initialization.json");
}

// --- Routing: only a bare interactive invocation on an uninitialized install reroutes to init. ---
function testFirstRunRouting() {
  const bareInteractive = (phase) => resolveFirstRunRoute({ args: [], phase, interactive: true }).route;
  assert.equal(bareInteractive("missing"), "init", "uninitialized bare interactive roborepo enters init");
  assert.equal(bareInteractive("in-progress"), "init", "an interrupted init is resumed, not skipped");
  assert.equal(bareInteractive("complete"), "normal", "a completed install opens the normal root menu");

  // Automation must never be dropped into a wizard it cannot answer.
  for (const phase of ["missing", "in-progress", "complete"]) {
    assert.equal(
      resolveFirstRunRoute({ args: [], phase, interactive: false }).route,
      "normal",
      `non-interactive bare invocation must not route to init (phase: ${phase})`,
    );
  }
}

function testExplicitCommandsBypassInit() {
  // Diagnostics and help stay reachable before initialization; this is the specific failure mode
  // of the old forced onboarding gate, so it is asserted rather than assumed.
  for (const args of [["doctor"], ["version"], ["--help"], ["harness", "list"], ["config", "apply"]]) {
    assert.equal(
      resolveFirstRunRoute({ args, phase: "missing", interactive: true }).route,
      "normal",
      `explicit command must run before initialization: ${args.join(" ")}`,
    );
  }
}

// --- Downgrade: an older RoboRepo must not destroy a newer installation's state. A newer-schema
// record is well-formed, just not interpretable by this build, so it reads as "not initialized"
// like a corrupt one — but writing over it is a different act entirely. Before this guard, an
// older CLI replayed the whole first-run workflow and overwrote the record with its own. ---
function testNewerRecordIsNeverOverwritten() {
  resetState();
  const newer = {
    schemaVersion: 99,
    workflowVersion: 9,
    status: "complete",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
  };
  fs.mkdirSync(path.dirname(initializationStatePath), { recursive: true });
  fs.writeFileSync(initializationStatePath, `${JSON.stringify(newer)}\n`);

  assert.equal(readInitializationState(), null, "an uninterpretable record must not read as valid");
  assert.throws(
    () => beginInitialization(),
    /newer RoboRepo/i,
    "beginInitialization must refuse rather than clobber a newer record",
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(initializationStatePath, "utf8")),
    newer,
    "the newer record must survive the refused write byte-for-byte",
  );

  // Through the real CLI, including --force: "re-run initialization" never means "discard a newer
  // installation's state". Both must exit nonzero with an explanation, not a stack trace.
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: stateDir, ROBOREPO_PRESETS_ONBOARD: "skip" };
  for (const args of [["init"], ["init", "--force"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, env, encoding: "utf8", input: "" });
    assert.equal(result.status, 1, `${args.join(" ")} must refuse a newer record`);
    assert.match(result.stderr, /newer version of RoboRepo/i, `${args.join(" ")} must explain why`);
    assert.doesNotMatch(result.stderr, /at writeInitializationState/, "must not surface a raw stack trace");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(initializationStatePath, "utf8")),
      newer,
      `${args.join(" ")} must leave the newer record intact`,
    );
  }
  resetState();
}

function testBrowserRedirectMessage() {
  const url = "http://127.0.0.1:9876";
  const message = browserRedirectMessage(url);
  assert.match(message, /Welcome to roborepo/, "handoff screen must introduce roborepo");
  assert.match(message, /admin dashboard/i, "handoff screen must describe the browser dashboard");
  assert.match(message, /browser window/i, "handoff screen must explain the redirect");
  assert.match(message, new RegExp(url.replaceAll(".", "\\.")), "handoff screen must include the portal URL");
  assert.match(message, /Explore the CLI at `roborepo`/, "handoff screen must point at the CLI");

  assert.equal(
    extractPortalUrl("roborepo portal: http://127.0.0.1:4319  (detached)"),
    "http://127.0.0.1:4319",
    "init must reuse the actual portal URL reported by roborepo web",
  );
}

// --- `roborepo library` and `roborepo package manage` must reach one implementation. Asserted
// through the real CLI in a sandboxed HOME so this covers dispatch, not just catalog shape. ---
function testAliasReachesSameImplementation() {
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: stateDir };
  const run = (args) => spawnSync(process.execPath, [cli, ...args, "--help"], { cwd: repoRoot, env, encoding: "utf8" });

  const library = run(["library"]);
  const manage = run(["package", "manage"]);
  assert.equal(library.status, 0, `library --help failed:\n${library.stderr}`);
  assert.equal(manage.status, 0, `package manage --help failed:\n${manage.stderr}`);
  assert.match(library.stdout, /packages/i, "library help should describe the package workflow");
}

function testInitDryRunShowsConfigurationChoice() {
  resetState();
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: stateDir, ROBOREPO_PRESETS_ONBOARD: "skip" };
  const result = spawnSync(process.execPath, [cli, "init", "--dry-run"], { cwd: repoRoot, env, encoding: "utf8", input: "" });
  assert.equal(result.status, 0, `init --dry-run failed:\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /open browser setup/i, "init must make browser setup the first-run entrypoint");
  assert.match(result.stdout, /CLI fallback/i, "init must still expose the terminal fallback");
}

// --- The shared bootstrap primitive that both `roborepo init` and `roborepo web` call. The
// porting plan (portal-web-first-run-bootstrap.md) exists so the two first-run entry points cannot
// drift: first-run `web` must produce the same machine state as first-run `init`, and an
// already-initialized `web` must be a no-op. These tests exercise the primitive directly rather
// than through a PTY so they stay CI-runnable. ---
function testEnsureInitializedBootstrapsMissing() {
  resetState();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(harnessStatePath, { force: true });
  const result = ensureInitialized();
  assert.equal(result.status, "bootstrapped", "a missing record must bootstrap");
  assert.equal(result.phase, "missing");
  assert.ok(Array.isArray(result.detected), "bootstrap must report detected harness ids");

  // The bootstrap performs the procedural work but must NOT finalize the record on its own: init's
  // browser/CLI configuration has not run yet, so the record stays in-progress and remains
  // resumable. finalizeInitialization() (which init calls after configuration succeeds) completes it.
  const record = readInitializationState();
  assert.equal(record.status, "in-progress", "bootstrap must leave the record in-progress, not complete");
  assert.equal(record.completedAt, null, "bootstrap must not stamp completion before configuration");
  assert.equal(initializationPhase(), "in-progress");
  assert.ok(fs.existsSync(workspaceRoot), "bootstrap must create the workspace root");
  assert.ok(fs.existsSync(stateRoot), "bootstrap must create the state root");
  assert.ok(fs.existsSync(harnessStatePath), "bootstrap must persist harness discovery state");

  finalizeInitialization();
  const finished = readInitializationState();
  assert.equal(finished.status, "complete", "finalize must mark the record complete");
  assert.ok(finished.completedAt, "finalize must stamp completion");
  assert.equal(initializationPhase(), "complete");
}

// Re-running after a successful full first run (bootstrap + finalized configuration) must not replay
// the procedural steps or rewrite the record's timestamps — otherwise every `roborepo web` after the
// first would look like a fresh initialization and destroy the "when did the user first start"
// provenance.
function testEnsureInitializedIsIdempotent() {
  resetState();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(harnessStatePath, { force: true });
  ensureInitialized();
  finalizeInitialization(); // a finished first run: bootstrap succeeded, configuration succeeded
  const before = readInitializationState();

  const result = ensureInitialized();
  assert.equal(result.status, "noop", "a completed bootstrap must be a no-op on re-entry");
  assert.equal(result.phase, "complete");
  const after = readInitializationState();
  assert.deepEqual(after, before, "re-entry must not rewrite the initialization record");
}

// An interrupted run (status in-progress, no completedAt) must be resumed to completion while
// preserving the original startedAt — the same preservation rule as `init`'s beginInitialization.
// Resume performs the procedural bootstrap again but stays in-progress until the caller finalizes.
function testEnsureInitializedResumesInProgress() {
  resetState();
  beginInitialization({ now: () => "2020-01-01T00:00:00.000Z" });
  assert.equal(initializationPhase(), "in-progress");

  const result = ensureInitialized();
  assert.equal(result.status, "bootstrapped", "an in-progress record must resume the bootstrap");
  assert.equal(result.phase, "in-progress", "the starting phase must be reported, not the final one");
  const record = readInitializationState();
  assert.equal(record.status, "in-progress", "a resumed init must stay in-progress until configuration finalizes it");
  assert.equal(record.completedAt, null, "resume must not stamp completion before configuration");
  assert.equal(record.startedAt, "2020-01-01T00:00:00.000Z", "resume must preserve the original startedAt");

  finalizeInitialization();
  const finished = readInitializationState();
  assert.equal(finished.status, "complete", "finalize after a resumed init must complete the record");
  assert.equal(finished.startedAt, "2020-01-01T00:00:00.000Z", "finalize must preserve the original startedAt");
}

// A record written by a newer RoboRepo must be refused without overwrite — the same downgrade
// protection `init` already has, now shared with `web`. `ensureInitialized` must report the refusal
// structurally so the caller can explain it rather than throwing a raw stack trace.
function testEnsureInitializedRefusesNewerSchema() {
  resetState();
  const newer = {
    schemaVersion: 99,
    workflowVersion: 9,
    status: "complete",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
  };
  fs.mkdirSync(path.dirname(initializationStatePath), { recursive: true });
  fs.writeFileSync(initializationStatePath, `${JSON.stringify(newer)}\n`);

  const result = ensureInitialized();
  assert.equal(result.status, "refused", "a newer-schema record must refuse the bootstrap");
  assert.equal(result.schemaVersion, 99);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(initializationStatePath, "utf8")),
    newer,
    "a refused bootstrap must leave the newer record byte-for-byte intact",
  );
  const lines = describeNewerSchemaRefusal(result.schemaVersion);
  assert.ok(lines.some((l) => /newer version of RoboRepo/i.test(l)), "refusal presentation must explain the downgrade");
  resetState();
}

// --dry-run reports the procedural steps without mutating any state. Shared by `init --dry-run`;
// `web` never passes dryRun.
function testEnsureInitializedDryRunDoesNotMutate() {
  resetState();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(harnessStatePath, { force: true });

  const result = ensureInitialized({ dryRun: true });
  assert.equal(result.status, "dryrun");
  assert.ok(Array.isArray(result.steps) && result.steps.length >= 3, "dry run must enumerate the procedural steps");
  assert.equal(readInitializationState(), null, "dry run must not write the initialization record");
  assert.ok(!fs.existsSync(workspaceRoot), "dry run must not create the workspace root");
  assert.ok(!fs.existsSync(harnessStatePath), "dry run must not persist harness state");
}

// `--force` (init only) re-runs the procedural bootstrap on an already-complete record. It must
// return `bootstrapped` (not `noop`), leave the record in-progress until configuration finalizes it,
// and preserve the original startedAt — the same provenance rule as every other re-entry. Nothing
// about a completed install exempts it from `--force`'s explicit "re-run initialization" meaning.
function testEnsureInitializedForceRebootstrapsComplete() {
  resetState();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(harnessStatePath, { force: true });
  ensureInitialized();
  finalizeInitialization(); // an already-complete install
  const before = readInitializationState();

  const result = ensureInitialized({ force: true });
  assert.equal(result.status, "bootstrapped", "force must re-run the bootstrap on a complete record");
  const mid = readInitializationState();
  assert.equal(mid.status, "in-progress", "a forced re-run must go back to in-progress until configuration finalizes it");
  assert.equal(mid.startedAt, before.startedAt, "a forced re-run must preserve the original startedAt");
  assert.ok(fs.existsSync(workspaceRoot), "a forced re-run must still ensure the workspace root");
  assert.ok(fs.existsSync(harnessStatePath), "a forced re-run must still refresh harness discovery");

  finalizeInitialization();
  const after = readInitializationState();
  assert.equal(after.status, "complete", "a forced re-run must end complete once configuration finalizes it");
  assert.equal(after.startedAt, before.startedAt, "finalize must preserve the original startedAt through a forced re-run");
}

// --- Regression: init's first-run configuration step must stay resumable. ---
//
// The shared bootstrap (`ensureInitialized()`) performs the procedural work but must NOT finalize the
// record; `finalizeInitialization()` is the explicit completion step init runs only after its
// browser/CLI configuration step succeeds. This models init's exact sequence — bootstrap succeeds,
// configuration is interrupted (finalize never runs), the phase stays "in-progress", and the next
// `roborepo init` resumes the bootstrap instead of reporting "already initialized". Before the
// split, `ensureInitialized()` marked the record `complete` during the bootstrap, so an interrupted
// configuration left the record `complete` and a subsequent `init` reported "already initialized".
function testInterruptedInitConfigStaysInProgressAndResumes() {
  resetState();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(harnessStatePath, { force: true });

  // init starts: the procedural bootstrap succeeds.
  const result = ensureInitialized();
  assert.equal(result.status, "bootstrapped", "init's procedural bootstrap must succeed");
  assert.equal(initializationPhase(), "in-progress", "bootstrap alone must not complete the record");

  // configuration is interrupted or fails → finalizeInitialization() is never reached.
  // (No call to finalizeInitialization here — this is the interrupted-config shape on disk.)

  assert.equal(initializationPhase(), "in-progress", "an interrupted configuration must leave the record in-progress");

  // the next `roborepo init` resumes instead of reporting "already initialized".
  const resume = ensureInitialized();
  assert.equal(resume.status, "bootstrapped", "the next init must resume the bootstrap, not no-op as already initialized");
  assert.equal(resume.phase, "in-progress", "resume reports the in-progress starting phase");
  assert.equal(initializationPhase(), "in-progress", "a resumed bootstrap must still await finalize");

  // configuration finally succeeds → finalize completes the record.
  finalizeInitialization();
  assert.equal(initializationPhase(), "complete", "finalize after a successful configuration completes the record");
}

// The same regression through the real CLI: a partial initialization record left by an interrupted
// `roborepo init` configuration must resume to `complete` on the next run, and must not print
// "already initialized". This is the public symptom the split restores.
function testInitResumesInterruptedConfigNotAlreadyInitialized() {
  resetState();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(harnessStatePath, { force: true });
  fs.mkdirSync(path.dirname(initializationStatePath), { recursive: true });
  fs.writeFileSync(
    initializationStatePath,
    `${JSON.stringify({
      schemaVersion: 1,
      workflowVersion: 1,
      status: "in-progress",
      startedAt: "2020-01-01T00:00:00.000Z",
      completedAt: null,
    })}\n`,
  );

  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: stateDir, ROBOREPO_PRESETS_ONBOARD: "skip" };
  const result = spawnSync(process.execPath, [cli, "init"], { cwd: repoRoot, env, encoding: "utf8", input: "" });
  assert.equal(result.status, 0, `init must resume, not fail:\n${result.stdout}${result.stderr}`);
  assert.doesNotMatch(result.stdout, /already initialized/i, "init must not report already initialized on a resumable record");

  const record = JSON.parse(fs.readFileSync(initializationStatePath, "utf8"));
  assert.equal(record.status, "complete", "a resumed init must reach complete after configuration");
  assert.equal(record.startedAt, "2020-01-01T00:00:00.000Z", "resume must preserve the original startedAt");
}

// `roborepo web` must refuse a newer-schema initialization record exactly like `roborepo init`
// does — including through the real CLI, where the refusal happens before any portal/reuse logic.
// The in-process `testEnsureInitializedRefusesNewerSchema` proves the primitive; this proves the
// `web` command's public behavior: exit 1, a plain-language explanation, and the record left
// byte-for-byte intact. No portal is started, so no port is needed and this stays CI-runnable.
function testWebRefusesNewerSchemaThroughRealCli() {
  resetState();
  const newer = {
    schemaVersion: 99,
    workflowVersion: 9,
    status: "complete",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
  };
  fs.mkdirSync(path.dirname(initializationStatePath), { recursive: true });
  fs.writeFileSync(initializationStatePath, `${JSON.stringify(newer)}\n`);

  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: stateDir, ROBOREPO_PRESETS_ONBOARD: "skip" };
  const result = spawnSync(process.execPath, [cli, "web", "--no-open", "--port", "0", "--allow-zero-port"], { cwd: repoRoot, env, encoding: "utf8", input: "" });
  assert.equal(result.status, 1, "web must refuse a newer-schema record");
  assert.match(result.stderr, /newer version of RoboRepo/i, "web must explain the refusal");
  assert.doesNotMatch(result.stderr, /at writeInitializationState/, "web must not surface a raw stack trace");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(initializationStatePath, "utf8")),
    newer,
    "web must leave the newer record byte-for-byte intact",
  );
  resetState();
}

// The browser-vs-CLI first-run configuration decision, as a pure function of the spawned
// `web --detach` result. The PTY side effects around it (welcome banner, presets onboarding,
// stdout relay) cannot run in CI by design, but the rule they wrap is testable without a terminal:
// a successful spawn hands the user to the browser with the portal URL the child actually
// reported, and anything else falls back to the CLI. This is the same split resolveFirstRunRoute
// makes for the entry-point routing decision.
function testResolveFirstRunConfigurationMode() {
  // Successful spawn -> browser, reusing the actual portal URL from web's output.
  const browser = resolveFirstRunConfigurationMode({
    spawnStatus: 0,
    spawnOutput: "roborepo portal: http://127.0.0.1:4319  (detached)",
  });
  assert.equal(browser.mode, "browser", "a successful web --detach must hand off to the browser");
  assert.equal(browser.url, "http://127.0.0.1:4319", "browser handoff must use the portal URL web reported");

  // Successful spawn but the portal URL is absent from output -> browser with the documented
  // default URL, never a crash.
  const noUrl = resolveFirstRunConfigurationMode({ spawnStatus: 0, spawnOutput: "" });
  assert.equal(noUrl.mode, "browser");
  assert.equal(noUrl.url, "http://127.0.0.1:4317", "missing portal URL must fall back to the default");

  // Failed spawn -> CLI fallback, regardless of what was printed.
  const fallback = resolveFirstRunConfigurationMode({ spawnStatus: 1, spawnOutput: "boom" });
  assert.equal(fallback.mode, "cli", "a failed web --detach must fall back to the CLI");
  const signalFallback = resolveFirstRunConfigurationMode({ spawnStatus: null, spawnOutput: "" });
  assert.equal(signalFallback.mode, "cli", "a signal-terminated web --detach must fall back to the CLI");
}
