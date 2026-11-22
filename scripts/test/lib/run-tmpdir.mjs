// A temp folder per test run, set as TMPDIR for everything the run starts, so the many suites that
// call mkdtemp leave nothing behind: the runner removes the folder when it ends, and every run
// first removes the folders of earlier runs whose process is gone, which catches a crashed or
// SIGKILLed run.
//
// Folders are named `roborepo-tests/run-<pid>-<time>`. A folder is swept only when signalling its
// pid reports ESRCH (no such process). Any other answer, including EPERM from a sandbox that hides
// other processes, counts as alive, so a concurrent run in another session is never swept.
//
//   node scripts/test/lib/run-tmpdir.mjs open <pid>   # sweep, create, print the folder
//   node scripts/test/lib/run-tmpdir.mjs close <dir>  # remove the folder (shell runners' trap)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RUN_PATTERN = /^run-(\d+)-\d+$/;

export function runsRoot(base = os.tmpdir()) {
  return path.join(base, "roborepo-tests");
}

export function openRunTmpdir({ pid = process.pid, base = os.tmpdir(), isAlive = processAlive } = {}) {
  const root = runsRoot(base);
  fs.mkdirSync(root, { recursive: true });
  sweepFinishedRuns(root, isAlive);
  const dir = path.join(root, `run-${pid}-${Date.now()}`);
  fs.mkdirSync(dir);
  return dir;
}

export function closeRunTmpdir(dir) {
  // Only a folder this helper named; a stray argument must not become a recursive delete.
  if (!RUN_PATTERN.test(path.basename(dir)) || path.basename(path.dirname(dir)) !== "roborepo-tests") return false;
  makeWritable(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function sweepFinishedRuns(root, isAlive = processAlive) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const swept = [];
  for (const name of names) {
    const match = RUN_PATTERN.exec(name);
    if (!match || isAlive(Number(match[1]))) continue;
    try {
      closeRunTmpdir(path.join(root, name));
      swept.push(name);
    } catch {
      // A folder the sandbox will not let this run remove waits for a run that can.
    }
  }
  return swept;
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

// Some suites chmod folders to 000 to test permission handling; restore access so removal works.
function makeWritable(dir) {
  let entries;
  try {
    fs.chmodSync(dir, 0o700);
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) makeWritable(path.join(dir, entry.name));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, value] = process.argv.slice(2);
  if (command === "open" && /^\d+$/.test(value ?? "")) {
    console.log(openRunTmpdir({ pid: Number(value) }));
  } else if (command === "close" && value) {
    try {
      closeRunTmpdir(value);
    } catch (error) {
      console.error(`run-tmpdir: ${error.message}`);
    }
  } else {
    console.error("usage: run-tmpdir.mjs open <pid> | close <dir>");
    process.exit(2);
  }
}
