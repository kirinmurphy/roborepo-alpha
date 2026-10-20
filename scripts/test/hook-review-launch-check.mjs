#!/usr/bin/env node
// The portal's hook review handoff below the browser: the one-click launch (which only opens the
// harness's own review screen, never sends a trust decision), the terminal launcher's platform and
// failure handling, the status cache a hook change must invalidate, and the review route's refusal
// of any browser-supplied command.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchHookReview } from "../cli/hook-review-launch.mjs";
import { hookReadinessLines, printHookReviewHint } from "../cli/hook-review-guidance.mjs";
import { launchInTerminal, terminalLaunchSupported } from "../cli/terminal-launch.mjs";
import { invalidateHookReadiness, loadHookReadiness, reportPackageHookChange } from "../cli/hook-readiness-status.mjs";
import { configRoutes } from "../cli/portal-routes-config.mjs";
import { dispatchRoutes } from "../cli/portal-router.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-hook-review-launch-"));
try {
  await launchOnlyWhenReviewIsPending();
  terminalLauncherHandlesPlatformsAndFailures();
  await statusCacheFollowsHookChanges();
  await reviewRouteAcceptsNoCommand();
  await mixedGroupsStillNameHooksAwaitingReview();
  console.log("ok: hook review launch, terminal fallback, and readiness freshness");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function launchOnlyWhenReviewIsPending() {
  const pending = { harness: "codex", reviewRevision: "abc", groups: [] };
  const route = { executable: "/Applications/ChatGPT.app/Contents/Resources/codex", args: [] };
  const launches = [];
  const launch = (request) => { launches.push(request); return { ok: true }; };
  const reads = [];
  const readStatus = (harness, options) => { reads.push(options); return Promise.resolve(options.fresh ? currentStatus : null); };
  let currentStatus = pending;

  let result = await launchHookReview("codex", { platform: "darwin", launch, readStatus, routeFor: () => route });
  assert.equal(result.launched, true);
  assert.deepEqual(launches, [{ name: "codex-hook-review", executable: route.executable, args: [] }]);
  assert.equal(reads.at(-1).fresh, true, "the click rechecks readiness, bypassing the cache");

  // Review finished elsewhere: no empty Codex session, the portal gets the new status instead.
  currentStatus = { harness: "codex", reviewRevision: null, groups: [] };
  result = await launchHookReview("codex", { platform: "darwin", launch, readStatus, routeFor: () => route });
  assert.deepEqual([result.launched, result.reason, result.status], [false, "no_review", currentStatus]);
  assert.equal(launches.length, 1);

  // A read that could not see the hooks is not "nothing to review": the click still opens Codex.
  currentStatus = { harness: "codex", reviewRevision: null, state: "unknown", groups: [{ owner: "telemetry", state: "unknown", hooks: [{ event: "Stop", state: "unknown" }] }] };
  result = await launchHookReview("codex", { platform: "darwin", launch, readStatus, routeFor: () => route });
  assert.equal(result.launched, true);

  currentStatus = pending;
  result = await launchHookReview("codex", { platform: "linux", launch, readStatus, routeFor: () => route });
  assert.equal(result.reason, "unsupported_platform");
  result = await launchHookReview("codex", { platform: "darwin", launch, readStatus, routeFor: () => null });
  assert.equal(result.reason, "no_executable", "CLI missing from both PATH and the desktop bundle");
  result = await launchHookReview("codex", { platform: "darwin", launch: () => ({ ok: false, reason: "launch_failed", error: "denied" }), readStatus, routeFor: () => route });
  assert.deepEqual([result.launched, result.reason, result.error], [false, "launch_failed", "denied"]);
  assert.equal(launches.length, 2, "only the two launches that should happen did");
}

// A group reports its worst hook, so a package with a missing hook and an untrusted one is a
// `missing` group. Its untrusted hook must still be named for review.
async function mixedGroupsStillNameHooksAwaitingReview() {
  const readiness = {
    harness: "codex", displayName: "Codex", state: "missing", reviewRevision: "abc", coreBundle: "hooks",
    guidance: { review_required: "Trust only those.", command: "codex" },
    groups: [{ owner: "telemetry", label: "Token Telemetry", state: "missing", hooks: [
      { event: "PreToolUse", command: "a", state: "missing" },
      { event: "PostToolUse", command: "b", state: "review_required" },
    ] }],
  };
  const lines = hookReadinessLines(readiness);
  assert.ok(lines.some((line) => /hooks missing: Token Telemetry \(PreToolUse\)/.test(line)));
  assert.ok(lines.some((line) => /hooks awaiting review: Token Telemetry \(PostToolUse\)/.test(line)));
  const printed = [];
  await printHookReviewHint(["codex"], { log: (line) => printed.push(line), read: async () => readiness });
  assert.ok(printed.includes("Codex hooks need review: Token Telemetry (PostToolUse)."));
}

function terminalLauncherHandlesPlatformsAndFailures() {
  assert.equal(terminalLaunchSupported("darwin"), true);
  assert.equal(terminalLaunchSupported("linux"), false);
  assert.equal(terminalLaunchSupported("win32"), false);

  const executable = path.join(tmp, "Codex Bin", "codex");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
  const dir = path.join(tmp, "launch");
  const calls = [];
  const ok = launchInTerminal({ name: "codex-hook-review", executable }, {
    platform: "darwin", dir, run: (command, args) => { calls.push([command, ...args]); return { status: 0 }; },
  });
  assert.deepEqual(ok, { ok: true });
  const script = path.join(dir, "codex-hook-review.command");
  assert.deepEqual(calls, [["open", script]], "hands a script to open; no Apple Events, so no Automation permission");
  const body = fs.readFileSync(script, "utf8");
  assert.ok(body.split("\n").includes(`cd ${dir} || exit 1`), "starts in a neutral folder RoboRepo owns");
  assert.match(body, /^exec '.*Codex Bin\/codex'$/m, "the executable path is quoted for the shell");

  const failed = launchInTerminal({ name: "codex-hook-review", executable }, {
    platform: "darwin", dir, run: () => ({ status: 1, stderr: "LSOpenURLsWithRole() failed" }),
  });
  assert.deepEqual([failed.ok, failed.reason], [false, "launch_failed"]);
  assert.match(failed.error, /LSOpenURLsWithRole/);

  assert.equal(launchInTerminal({ name: "x", executable: "codex" }, { platform: "darwin", dir, run: () => ({ status: 0 }) }).reason, "no_executable");
  assert.equal(launchInTerminal({ name: "x", executable: path.join(tmp, "absent") }, { platform: "darwin", dir }).reason, "no_executable");
  assert.equal(launchInTerminal({ name: "x", executable }, { platform: "linux", dir }).reason, "unsupported_platform");
}

// Gemini reports no readiness, so these reads never start a harness runtime.
async function statusCacheFollowsHookChanges() {
  const first = loadHookReadiness("gemini", { now: 1_000 });
  assert.equal(loadHookReadiness("gemini", { now: 20_000 }), first, "routine reads share the cached result");
  assert.equal(loadHookReadiness("gemini", { now: 1_500, fresh: true }), first, "a fresh read joins one that just started");
  const fresh = loadHookReadiness("gemini", { now: 20_000, fresh: true });
  assert.notEqual(fresh, first, "a fresh read past the join window starts a new read");

  invalidateHookReadiness();
  const afterChange = loadHookReadiness("gemini", { now: 20_001 });
  assert.notEqual(afterChange, fresh, "a hook change drops the cached read, even one still in flight");

  const reported = reportPackageHookChange({ ok: true }, ["telemetry"]);
  assert.deepEqual(reported.hookHarnesses.sort(), ["claude", "codex"]);
  assert.notEqual(loadHookReadiness("gemini", { now: 20_002 }), afterChange, "a package change with hooks invalidates");
  const unchanged = loadHookReadiness("gemini", { now: 20_003 });
  assert.deepEqual(reportPackageHookChange({ ok: true }, ["code-style"]).hookHarnesses, [], "a package without hooks names no harness");
  assert.equal(loadHookReadiness("gemini", { now: 20_004 }), unchanged, "and leaves the cache alone");
  assert.deepEqual(reportPackageHookChange({ ok: false }, ["telemetry"]).hookHarnesses, [], "a failed change offers nothing");
  await Promise.all([first, fresh, afterChange, unchanged]);
}

async function reviewRouteAcceptsNoCommand() {
  const launches = [];
  const handlers = { launchHookReview: async (harness) => { launches.push(harness); return { launched: true }; } };
  for (const body of [{ executable: "/bin/sh" }, { command: "rm -rf ~" }, { args: ["--dangerously-bypass-hook-trust"] }, { cwd: "/" }, ["x"]]) {
    const res = await post(`/api/config/hooks/codex/review`, body, handlers);
    assert.equal(res.status, 400, `rejects ${JSON.stringify(body)}`);
  }
  assert.deepEqual(launches, []);
  const res = await post(`/api/config/hooks/codex/review`, {}, handlers);
  assert.equal(res.status, 200);
  assert.deepEqual(launches, ["codex"]);

  const unknown = await post(`/api/config/hooks/nope/review`, {}, { launchHookReview: async () => { throw new Error("unsupported harness: nope"); } });
  assert.equal(unknown.status, 404);

  const reads = [];
  const statusHandlers = { loadHookReadiness: async (harness, options) => { reads.push(options); return { harness }; } };
  await get("/api/config/hooks/codex/status", "fresh=1", statusHandlers);
  await get("/api/config/hooks/codex/status", "", statusHandlers);
  assert.deepEqual(reads, [{ fresh: true }, { fresh: false }]);
}

async function post(urlPath, body, handlers) {
  const res = response();
  const req = { method: "POST", on(event, callback) { if (event === "data") callback(JSON.stringify(body)); if (event === "end") callback(); } };
  dispatchRoutes([configRoutes], req, res, urlPath, "", handlers);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  return res;
}

async function get(urlPath, qs, handlers) {
  const res = response();
  dispatchRoutes([configRoutes], { method: "GET" }, res, urlPath, qs, handlers);
  await new Promise(setImmediate);
  return res;
}

function response() {
  return { status: null, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
}
