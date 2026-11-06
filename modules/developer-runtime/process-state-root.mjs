// Which RoboRepo state root a listener's process was started with, read from its environment.
//
// A listener's cwd says which checkout it belongs to, not whose data it serves: a hermetic test
// portal started from a worktree has that worktree's cwd and its own temp ROBOREPO_STATE_ROOT.
// Only the variable is kept. The rest of each process's environment can hold secrets, so it is
// matched here and dropped, never returned, logged, or included in a warning.

import path from "node:path";
import { defaultRunCommand } from "./command-exec.mjs";

export const PROCESS_STATE_ROOT_TIMEOUT_MS = 1500;

// `ps` separates variables with single spaces and does not quote values, so a value runs to the next
// NAME= token. That keeps paths such as "Application Support" whole.
const STATE_ROOT_PATTERN = /(?:^|\s)ROBOREPO_STATE_ROOT=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/;

export async function collectProcessStateRoots(pids, {
  platform = process.platform,
  runCommand = defaultRunCommand,
  timeoutMs = PROCESS_STATE_ROOT_TIMEOUT_MS,
  warnings = [],
} = {}) {
  const uniquePids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (platform !== "darwin" || uniquePids.length === 0) return new Map();
  try {
    const result = await runCommand("ps", ["ewww", "-o", "pid=,command=", "-p", uniquePids.join(",")], { timeoutMs });
    return parseProcessStateRoots(result.stdout ?? result);
  } catch (err) {
    // Without this reading a test server looks like a real one again, so it is worth saying once.
    // `err.message` is safe here: a failed `ps` reports the command line, not the output.
    warnings.push(`state root lookup failed: ${err.message}`);
    return new Map();
  }
}

// A process with no variable is absent from the map: it uses the default root, or is not RoboRepo at
// all. A relative value is absent too, because it depends on a directory this reading does not have.
export function parseProcessStateRoots(output) {
  const byPid = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!match) continue;
    const value = STATE_ROOT_PATTERN.exec(match[2])?.[1];
    if (value && path.isAbsolute(value)) byPid.set(Number(match[1]), value);
  }
  return byPid;
}
