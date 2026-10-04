#!/usr/bin/env node
// stop.mjs: which listeners belong to a checkout, and what stopping them reports. Every external
// effect is injected — `lsof`, the Git top-level lookup, signals, and sleep — so the assertions
// hold on Linux and macOS runners alike. plan-suite-commands-check.mjs covers real processes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCheckoutServers, stopCheckoutServers } from "../../modules/developer-runtime/stop.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-runtime-stop-")));
const primary = path.join(tmp, "primary");
const nested = path.join(primary, ".claude", "worktrees", "nested");
const worktree = path.join(tmp, "worktrees", "feature");
const sub = path.join(worktree, "apps", "web");
for (const dir of [nested, sub]) fs.mkdirSync(dir, { recursive: true });

// The Git top level of each directory: a subdirectory belongs to its worktree, while the nested
// worktree is its own checkout even though its path sits inside the primary.
function resolveTopLevel(cwd) {
  if (cwd.startsWith(nested)) return nested;
  if (cwd.startsWith(worktree)) return worktree;
  if (cwd.startsWith(primary)) return primary;
  return null;
}

const SELF = 999;
const listeners = [
  { pid: 101, command: "node", ports: [3001, 3000, 3000], cwd: worktree },
  { pid: 102, command: "vite", ports: [5173], cwd: sub },
  { pid: 201, command: "node", ports: [4317], cwd: primary },
  { pid: 202, command: "node", ports: [4318], cwd: nested },
  { pid: 203, command: "python3", ports: [8000], cwd: null },
  { pid: SELF, command: "node", ports: [9000], cwd: worktree },
];

// `cwdAtSignal` answers the re-read stop.mjs makes just before signalling; discovery always sees
// the listener's original working directory.
// `stat` is the `ps` state per PID; "Z" marks an exited process its parent has not reaped.
function fakeLsof({ cwdAtSignal = {}, stat = {} } = {}) {
  const calls = [];
  const lookups = new Map();
  const runCommand = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "ps") return { stdout: `${stat[Number(args.at(-1))] || "S"}\n` };
    assert.equal(command, "lsof");
    if (args.includes("-iTCP")) {
      return { stdout: listeners.flatMap((item) => [`p${item.pid}`, `c${item.command}`, ...item.ports.map((port) => `n127.0.0.1:${port}`)]).join("\n") };
    }
    const pid = Number(args[args.indexOf("-p") + 1]);
    lookups.set(pid, (lookups.get(pid) || 0) + 1);
    const cwd = lookups.get(pid) > 1 && pid in cwdAtSignal ? cwdAtSignal[pid] : listeners.find((item) => item.pid === pid)?.cwd;
    if (!cwd) throw new Error(`no such process ${pid}`);
    return { stdout: `p${pid}\nfcwd\nn${cwd}\n` };
  };
  return { runCommand, calls };
}

// `alive` holds running PIDs; SIGTERM removes one unless it is stubborn. `errors` maps a PID to the
// error code its SIGTERM raises.
function fakeSignals({ alive, stubborn = [], errors = {} }) {
  const sent = [];
  const signal = (pid, sig) => {
    if (sig === 0) {
      if (!alive.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return;
    }
    sent.push([pid, sig]);
    if (errors[pid]) throw Object.assign(new Error(errors[pid]), { code: errors[pid] });
    if (!stubborn.includes(pid)) alive.delete(pid);
  };
  return { signal, sent };
}

const base = { platform: "darwin", resolveTopLevel, selfPid: SELF, sleep: async () => {}, waitMs: 300 };

// ── Selection ───────────────────────────────────────────────────────────────────────────────────
{
  const { runCommand } = fakeLsof();
  const found = await findCheckoutServers(worktree, { ...base, runCommand });
  assert.equal(found.supported, true);
  assert.equal(found.checkout, worktree);
  assert.deepEqual(found.servers, [
    { pid: 101, command: "node", cwd: worktree, ports: [3000, 3001] },
    { pid: 102, command: "vite", cwd: sub, ports: [5173] },
  ], "the worktree and its subdirectories are selected; the primary, a nested worktree, an unknown cwd, and this process are not");

  const primaryFound = await findCheckoutServers(primary, { ...base, runCommand });
  assert.deepEqual(primaryFound.servers.map((server) => server.pid), [201],
    "a worktree nested inside the primary checkout is not the primary's");
}

// ── Dry run signals nothing ─────────────────────────────────────────────────────────────────────
{
  const { runCommand } = fakeLsof();
  const { signal, sent } = fakeSignals({ alive: new Set([101, 102]) });
  const result = await stopCheckoutServers(worktree, { ...base, runCommand, signal, dryRun: true });
  assert.deepEqual(result.servers.map((server) => server.result), ["would-stop", "would-stop"]);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.deepEqual(sent, [], "a dry run sends no signal");
}

// ── Stopped, and a survivor that is reported rather than killed ─────────────────────────────────
{
  const { runCommand } = fakeLsof();
  const { signal, sent } = fakeSignals({ alive: new Set([101, 102]), stubborn: [102] });
  let sleeps = 0;
  const result = await stopCheckoutServers(worktree, { ...base, runCommand, signal, sleep: async () => { sleeps += 1; } });
  assert.deepEqual(result.servers.map((server) => [server.pid, server.result]), [[101, "stopped"], [102, "still-running"]]);
  assert.equal(result.ok, false, "a survivor fails the run");
  assert.deepEqual(sent, [[101, "SIGTERM"], [102, "SIGTERM"]], "only SIGTERM is ever sent");
  assert.equal(sleeps, 3, "the wait is bounded by waitMs");
}

// ── A zombie has exited, even though signal 0 still finds it ────────────────────────────────────
{
  const { runCommand } = fakeLsof({ stat: { 102: "Z" } });
  const { signal } = fakeSignals({ alive: new Set([101, 102]), stubborn: [102] });
  const result = await stopCheckoutServers(worktree, { ...base, runCommand, signal });
  assert.deepEqual(result.servers.map((server) => [server.pid, server.result]), [[101, "stopped"], [102, "stopped"]],
    "an unreaped child that exited is stopped, not a survivor");
  assert.equal(result.ok, true);
}

// ── A reused PID is left alone ──────────────────────────────────────────────────────────────────
{
  const { runCommand } = fakeLsof({ cwdAtSignal: { 101: "/somewhere/else" } });
  const { signal, sent } = fakeSignals({ alive: new Set([101, 102]) });
  const result = await stopCheckoutServers(worktree, { ...base, runCommand, signal });
  assert.deepEqual(result.servers.map((server) => [server.pid, server.result]), [[101, "changed"], [102, "stopped"]]);
  assert.deepEqual(sent, [[102, "SIGTERM"]], "a PID whose working directory changed is never signalled");
  assert.equal(result.ok, true);
}

// ── Gone before the signal, and a refused signal ────────────────────────────────────────────────
{
  const { runCommand } = fakeLsof({ cwdAtSignal: { 102: null } });
  const { signal } = fakeSignals({ alive: new Set([101]), errors: { 101: "EPERM" } });
  const result = await stopCheckoutServers(worktree, { ...base, runCommand, signal });
  assert.deepEqual(result.servers.map((server) => [server.pid, server.result, server.error]), [[101, "failed", "EPERM"], [102, "gone", undefined]]);
  assert.equal(result.ok, false, "a refused signal fails the run");

  const raced = fakeSignals({ alive: new Set([101, 102]), errors: { 101: "ESRCH" } });
  const racedResult = await stopCheckoutServers(worktree, { ...base, runCommand: fakeLsof().runCommand, signal: raced.signal });
  assert.equal(racedResult.servers[0].result, "gone", "ESRCH on the signal means it already exited");
  assert.equal(racedResult.ok, true);
}

// ── Unsupported platforms run nothing ───────────────────────────────────────────────────────────
{
  const { runCommand, calls } = fakeLsof();
  const result = await stopCheckoutServers(worktree, { ...base, platform: "linux", runCommand, signal: () => assert.fail("must not signal") });
  assert.equal(result.supported, false);
  assert.match(result.warnings[0], /not yet supported on Linux/);
  assert.deepEqual(result.servers, []);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [], "no lsof call on an unsupported platform");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("developer-runtime stop: ok");
