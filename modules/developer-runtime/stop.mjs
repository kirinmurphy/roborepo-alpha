// Stop the dev servers one checkout is running. `/plan-close` uses this, through
// `roborepo plans stop-servers`, once a plan's work has landed and its worktree only serves stale
// code.
//
// A "server" is a process listening on a TCP port whose working directory's Git top level IS the
// checkout. This is the same working-directory attribution Runtime uses (listeners.mjs), so what
// Home shows as running in a worktree is exactly what this stops. Two near-misses stay excluded:
//   - path-prefix matching would claim `.claude/worktrees/*` nested inside a primary checkout;
//   - processes that do not listen (agent sessions, shells, editors, watchers) are never
//     candidates, even though their working directory is often the same worktree.
//
// Only SIGTERM is sent. A server that survives it is reported, never killed: forcing it is the
// user's call.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { capabilityForPlatform } from "./capabilities.mjs";
import {
  defaultRunCommand,
  discoverListenerRecords,
  LISTENER_DISCOVERY_TIMEOUT_MS,
  resolvePidCwd,
} from "./listeners.mjs";

export const STOP_WAIT_MS = 5000;
const POLL_MS = 100;
const GIT_TIMEOUT_MS = 5000;

export async function findCheckoutServers(checkoutPath, {
  platform = process.platform,
  runCommand = defaultRunCommand,
  resolveTopLevel = gitTopLevel,
  selfPid = process.pid,
} = {}) {
  const checkout = fs.realpathSync(checkoutPath);
  const capabilities = capabilityForPlatform(platform);
  if (capabilities.discovery !== "supported") {
    return { checkout, supported: false, warnings: [capabilities.message], servers: [] };
  }

  const { warnings, records } = await discoverListenerRecords({ platform, runCommand });
  const topLevelByCwd = new Map();
  const byPid = new Map();
  for (const { listener, cwd } of records) {
    if (!cwd || listener.pid === selfPid) continue;
    if (!topLevelByCwd.has(cwd)) topLevelByCwd.set(cwd, resolveTopLevel(cwd));
    if (topLevelByCwd.get(cwd) !== checkout) continue;
    const server = byPid.get(listener.pid) ?? { pid: listener.pid, command: listener.command, cwd, ports: [] };
    if (!server.ports.includes(listener.port)) server.ports.push(listener.port);
    byPid.set(listener.pid, server);
  }
  const servers = [...byPid.values()].sort((a, b) => a.pid - b.pid);
  for (const server of servers) server.ports.sort((a, b) => a - b);
  return { checkout, supported: true, warnings, servers };
}

// Result per server:
//   would-stop     --dry-run; nothing was signalled
//   stopped        exited after SIGTERM
//   still-running  outlived the wait; reported, not escalated
//   gone           exited on its own before it was signalled
//   changed        the PID now has a different working directory (reused); left alone
//   failed         the signal itself was refused, e.g. EPERM for another user's process
export async function stopCheckoutServers(checkoutPath, {
  dryRun = false,
  runCommand = defaultRunCommand,
  signal = defaultSignal,
  sleep = defaultSleep,
  waitMs = STOP_WAIT_MS,
  ...findOptions
} = {}) {
  const found = await findCheckoutServers(checkoutPath, { ...findOptions, runCommand });
  const warnings = [...found.warnings];
  if (dryRun) {
    return summarize({ ...found, warnings, dryRun, servers: found.servers.map((server) => ({ ...server, result: "would-stop" })) });
  }

  const servers = [];
  for (const server of found.servers) {
    // Discovery and the signal are separate moments; re-read so a PID reused in between is never hit.
    const cwd = await resolvePidCwd(server.pid, runCommand, LISTENER_DISCOVERY_TIMEOUT_MS, []);
    if (cwd !== server.cwd) {
      servers.push({ ...server, result: (await isRunning(server.pid, signal, runCommand)) ? "changed" : "gone" });
      continue;
    }
    try {
      signal(server.pid, "SIGTERM");
      servers.push({ ...server, result: "signalled" });
    } catch (err) {
      servers.push({ ...server, result: err.code === "ESRCH" ? "gone" : "failed", ...(err.code === "ESRCH" ? {} : { error: err.code || err.message }) });
    }
  }

  const pending = async () => {
    const running = [];
    for (const server of servers) {
      if (server.result === "signalled" && await isRunning(server.pid, signal, runCommand)) running.push(server.pid);
    }
    return running;
  };
  let survivors = await pending();
  for (let waited = 0; waited < waitMs && survivors.length > 0; waited += POLL_MS) {
    await sleep(POLL_MS);
    survivors = await pending();
  }
  survivors = new Set(survivors);
  for (const server of servers) {
    if (server.result === "signalled") server.result = survivors.has(server.pid) ? "still-running" : "stopped";
  }
  return summarize({ ...found, warnings, dryRun, servers });
}

function summarize(result) {
  return { ...result, ok: !result.servers.some((server) => server.result === "still-running" || server.result === "failed") };
}

// A zombie — exited, but not yet reaped by a busy parent — still answers signal 0, yet it has
// already released its ports. Counting it as running would report a stopped server as a survivor.
async function isRunning(pid, signal, runCommand) {
  if (!isAlive(pid, signal)) return false;
  try {
    const result = await runCommand("ps", ["-o", "stat=", "-p", String(pid)], { timeoutMs: LISTENER_DISCOVERY_TIMEOUT_MS });
    return !String(result.stdout ?? result).trim().startsWith("Z");
  } catch {
    // `ps` exits non-zero when the PID is gone; any other failure falls back to the signal probe.
    return isAlive(pid, signal);
  }
}

// Signal 0 probes existence without delivering anything. EPERM means the process exists but
// belongs to someone else.
function isAlive(pid, signal) {
  try {
    signal(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function defaultSignal(pid, sig) {
  process.kill(pid, sig);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gitTopLevel(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (result.status !== 0) return null;
  try {
    return fs.realpathSync(result.stdout.trim());
  } catch {
    return null;
  }
}
