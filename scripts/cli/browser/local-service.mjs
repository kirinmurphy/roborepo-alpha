// The app a run checks against. A service already answering at the URL is reused and never touched:
// it may be the user's own dev server. A service is started only when `--serve` names the command
// and nothing answers yet, and only that process (with its children) is stopped afterward.

import { spawn, spawnSync } from "node:child_process";

const POLL_MS = 250;

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
  const stop = () => stopProcessTree(child);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { blocked: `--serve command exited (${child.exitCode}) before ${url} responded`, stop };
    if (await responds(url)) return { started: child.pid, stop };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  stop();
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

function stopProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

function noop() {}
