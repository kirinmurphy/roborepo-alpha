// A temp folder per test run, set as TMPDIR for everything the run starts, so the many suites that
// call mkdtemp leave nothing behind: the runner removes the folder when it ends, and every run
// first removes the folders of earlier runs whose process is gone, which catches a crashed or
// SIGKILLed run.
//
// Folders are named `roborepo-tests-<account>/run-<pid>-<time>`. The root is per account and
// private (0700): a shared /tmp root made by one account under umask 022 would refuse every other
// account's runs. A folder is swept only when signalling its
// pid reports ESRCH (no such process). Any other answer, including EPERM from a sandbox that hides
// other processes, counts as alive, so a concurrent run in another session is never swept.
//
//   node scripts/test/lib/run-tmpdir.mjs open <pid>   # sweep, create, print the folder
//   node scripts/test/lib/run-tmpdir.mjs close <dir>  # remove the folder (shell runners' trap)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "../../cli/roots.mjs";

const RUN_PATTERN = /^run-(\d+)-\d+$/;

const RUNS_ROOT_PREFIX = "roborepo-tests-";

export function runsRoot(base = os.tmpdir()) {
  return path.join(base, `${RUNS_ROOT_PREFIX}${accountKey()}`);
}

// The numeric uid where the platform has one; Windows has no uid and a per-user TMPDIR already.
function accountKey() {
  const uid = process.getuid?.();
  if (uid !== undefined) return String(uid);
  try {
    return os.userInfo().username.replace(/[^A-Za-z0-9._-]/g, "_") || "user";
  } catch {
    return "user";
  }
}

export function openRunTmpdir({ pid = process.pid, base = os.tmpdir(), isAlive = processAlive } = {}) {
  const root = runsRoot(base);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  ensurePrivateRoot(root);
  sweepFinishedRuns(root, isAlive);
  const dir = path.join(root, `run-${pid}-${Date.now()}`);
  fs.mkdirSync(dir);
  return dir;
}

// mkdir's mode applies only when it creates the folder, so an existing root is checked here: it must
// be a real folder this account owns, and is narrowed to 0700 if it was made wider.
function ensurePrivateRoot(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) throw new Error(`${root} is not a folder; refusing to use it for test runs`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${root} belongs to another account; refusing to use it for test runs`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) fs.chmodSync(root, 0o700);
}

export function closeRunTmpdir(dir) {
  // Only a folder this helper named; a stray argument must not become a recursive delete.
  if (!RUN_PATTERN.test(path.basename(dir)) || !path.basename(path.dirname(dir)).startsWith(RUNS_ROOT_PREFIX)) return false;
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
// chmod and readdir follow links, so a link is skipped: rmSync removes it as a link.
function makeWritable(dir) {
  let entries;
  try {
    if (!fs.lstatSync(dir).isDirectory()) return;
    fs.chmodSync(dir, 0o700);
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) makeWritable(path.join(dir, entry.name));
  }
}

if (isMainModule(import.meta.url)) {
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
