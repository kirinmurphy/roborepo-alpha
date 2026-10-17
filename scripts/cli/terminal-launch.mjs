// Open one program in a new terminal window on the user's behalf, after they click for it.
//
// macOS only, for now: the launcher writes a small `.command` script and hands it to `open`, which
// runs it in whichever terminal app the user has made the default for `.command` files (Terminal
// unless they changed it). Unlike `osascript … do script`, this sends no Apple Events, so it needs
// no Automation permission and cannot be stopped by a denied one. Linux and Windows report no
// support until a terminal launch path is tested there; callers fall back to a copyable command.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stateDir } from "./state-paths.mjs";
import { shellQuote } from "../harnesses/shell-quote.mjs";

const OPEN_TIMEOUT_MS = 10_000;

export function terminalLaunchSupported(platform = process.platform) {
  return platform === "darwin";
}

// `name` names the script file, so repeated launches reuse one file instead of piling up copies.
// The working directory is the script's own folder: neutral, empty, and owned by RoboRepo.
export function launchInTerminal({ name, executable, args = [] }, {
  platform = process.platform, dir = path.join(stateDir, "terminal-launch"), run = spawnSync,
} = {}) {
  if (!terminalLaunchSupported(platform)) return { ok: false, reason: "unsupported_platform" };
  if (!path.isAbsolute(executable) || !fs.existsSync(executable)) return { ok: false, reason: "no_executable" };
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, `${name}.command`);
  fs.writeFileSync(scriptPath, [
    "#!/bin/sh",
    `cd ${shellQuote(dir)} || exit 1`,
    `exec ${[executable, ...args].map(shellQuote).join(" ")}`,
    "",
  ].join("\n"), { mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);
  const result = run("open", [scriptPath], { encoding: "utf8", timeout: OPEN_TIMEOUT_MS });
  if (result.error || result.status !== 0) {
    return { ok: false, reason: "launch_failed", error: String(result.error?.message || result.stderr || `open exited ${result.status}`).trim() };
  }
  return { ok: true };
}
