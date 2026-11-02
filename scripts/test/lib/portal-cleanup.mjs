// Boots a hermetic portal server for a test and guarantees it stops with the test.
//
// The server runs in the foreground as a direct child (not `web --detach`), so the test owns its PID
// from the moment it spawns. That matters for cleanup: a detached server's PID is only known once
// `web --detach` writes it, and it is recorded under the port it actually bound
// (server-<port>.pid), so a bare `web stop` — which defaults to 4317 — never finds it.
//
// Cleanup covers every exit path:
//   - normal exit, a thrown assertion, SIGINT, SIGTERM: the returned stop() / the exit handler
//   - SIGKILL, where no handler runs: a watchdog process (kill-when-orphaned.sh) stops the server
//     once this process is gone
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const cli = path.join(repoRoot, "scripts", "cli", "main.mjs");
const watchdog = path.join(here, "kill-when-orphaned.sh");

// Stops targetPid if this process dies without cleaning up. The watchdog is detached and unref'd
// so it neither holds this process open nor dies with its process group; it exits on its own once
// the target stops.
export function guardPortal(targetPid) {
  if (!Number.isInteger(targetPid) || targetPid <= 0) return;
  const guard = spawn("bash", [watchdog, String(process.pid), String(targetPid)], {
    detached: true,
    stdio: "ignore",
  });
  guard.unref();
}

// Starts `web --no-open --port 0 --allow-zero-port` with the given env (which must carry the
// test's temp HOME / ROBOREPO_STATE_ROOT) and resolves once it has bound a port.
// Returns { port, stop }. `readyFile` must live in the test's temp dir.
export async function startHermeticPortal({ env, readyFile, logFile, timeoutMs = 60_000 }) {
  const out = logFile ? fs.openSync(logFile, "a") : "ignore";
  const server = spawn(process.execPath, [cli, "web", "--no-open", "--port", "0", "--allow-zero-port"], {
    cwd: repoRoot,
    env: { ...env, PORTAL_READY_FILE: readyFile },
    stdio: ["ignore", out, out],
  });
  guardPortal(server.pid);
  // Never let the server keep the test alive: the test ends when its own work does, and the exit
  // handler below stops the server then.
  server.unref();

  let exited = false;
  server.once("exit", () => { exited = true; });
  const stop = () => {
    if (!exited) {
      try { server.kill("SIGTERM"); } catch { /* already gone */ }
    }
  };
  process.once("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { stop(); process.exit(1); });
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const port = Number(/ready:(\d+)/.exec(fs.readFileSync(readyFile, "utf8"))?.[1]);
      if (Number.isInteger(port) && port > 0) return { port, stop };
    } catch { /* not written yet */ }
    if (exited) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  stop();
  const log = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-2000) : "(no log)";
  throw new Error(`portal server never became ready\n${log}`);
}
