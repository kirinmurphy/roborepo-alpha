// The app a run checks against. A service already answering at the URL is reused and never touched:
// it may be the user's own dev server. A service is started only when `--serve` names the command
// and nothing answers yet, and only that process (with its children) is stopped afterward.

import { spawn, spawnSync } from "node:child_process";
import { own } from "./owned-resources.mjs";

const POLL_MS = 250;
const SHUTDOWN_GRACE_MS = 1000;
const SHUTDOWN_POLL_MS = 25;

export async function ensureLocalService({ url, serve, timeoutMs }) {
  if (!url) {
    return serve
      ? { blocked: "--serve needs --url, so the run knows when the service is ready", stop: noop }
      : { stop: noop };
  }
  if (await responds(url)) return { reused: true, stop: noop };
  if (!serve) {
    return { blocked: `no local service responded at ${url}; start it, or pass --serve with its dev command`, stop: noop };
  }

  // Its own process group (POSIX), so stop() reaches the dev server the shell spawned, not just
  // the shell.
  const child = spawn(serve, { shell: true, detached: process.platform !== "win32", stdio: "ignore" });
  let stopping;
  const stop = () => stopping ??= stopProcessTree(child).finally(release);
  const release = own(stop);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A command that backgrounds its server (`npm run dev &`) exits 0 while the server keeps
    // starting in the same process group, so only a failing exit ends the wait early.
    if (child.exitCode !== null && child.exitCode !== 0) {
      await stop();
      return { blocked: `--serve command exited (${child.exitCode}) before ${url} responded`, stop: noop };
    }
    if (await responds(url)) return { started: child.pid, stop };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  await stop();
  return { blocked: `${url} did not respond within ${timeoutMs}ms of starting --serve`, stop: noop };
}

async function responds(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

// Signals the whole group even when the shell that led it has exited: a backgrounded server
// outlives its shell and is still in the group.
async function stopProcessTree(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  if (!signalGroup(child.pid, "SIGTERM")) return;
  if (await waitForGroupExit(child.pid)) return;
  signalGroup(child.pid, "SIGKILL");
  // A killed group can retain zombie entries until its parent reaps them; no member can serve
  // requests after SIGKILL. Bound this wait as well so cleanup cannot hang on a zombie.
  await waitForGroupExit(child.pid);
}

async function waitForGroupExit(pid) {
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (Date.now() < deadline) {
    if (!signalGroup(pid, 0)) return true;
    await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS));
  }
  return false;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function noop() {}
