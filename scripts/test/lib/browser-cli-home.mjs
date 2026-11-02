// A throwaway HOME and state root for driving `roborepo browser` through the real CLI, so checks
// never read or change the machine's own packages or evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "main.mjs");

export function createBrowserCliHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateRoot = path.join(home, ".roborepo");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const envFor = (extra) => ({ ...process.env, HOME: home, ROBOREPO_STATE_ROOT: stateRoot, SKIP_MCP: "1", ...extra });

  function run(args, env = {}) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: home, encoding: "utf8", env: envFor(env) });
  }

  // Asynchronous: returns the child as well as its result, so a check can signal it mid-run or
  // keep serving a fixture app from its own event loop while the command runs.
  function start(args, env = {}) {
    const child = spawn(process.execPath, [cli, ...args], { cwd: home, env: envFor(env) });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const done = new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout })));
    return { child, done };
  }

  return {
    home,
    stateRoot,
    run,
    stub: (args) => run(["browser", "run", "--provider", "stub", ...args], { ROBOREPO_BROWSER_STUB: "1" }),
    start,
    startStub: (args) => start(["browser", "run", "--provider", "stub", ...args], { ROBOREPO_BROWSER_STUB: "1" }),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}
