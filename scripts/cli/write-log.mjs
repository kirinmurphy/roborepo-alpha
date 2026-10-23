import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { appRoot, isMainModule } from "./roots.mjs";
import { stateDir } from "./state-paths.mjs";

// One JSON line per write roborepo makes to the user's harness config (root configs, rendered rules,
// hooks files, the enabled-packages registry), so "what changed my config, and when?" has an
// answer. Each line names the trigger: the portal request when one is in flight, otherwise the
// outermost roborepo command. main.mjs exports that command as ROBOREPO_WRITE_ACTOR, so a write
// made by a child process (the installer behind `roborepo update`) still names the command the
// user ran.
export const WRITE_LOG_PATH = path.join(stateDir, "logs", "config-writes.jsonl");
// Rotated to a single .1 file past this size; the log is for recent history, not an archive.
const MAX_LOG_BYTES = 512 * 1024;

const actorStore = new AsyncLocalStorage();

export function runWithWriteActor(actor, fn) {
  return actorStore.run(actor, fn);
}

export function currentWriteActor() {
  return actorStore.getStore() || process.env.ROBOREPO_WRITE_ACTOR || `roborepo ${process.argv.slice(2).join(" ")}`.trim();
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Never throws: a write that already happened must not fail because its log line could not be added.
export function recordConfigWrite(filePath, detail = null) {
  const file = path.resolve(filePath);
  // Harness config lives under HOME or roborepo's state root. Anything else is a fixture or scratch
  // file, and generated outputs inside the app checkout are build artifacts, not the user's config.
  const userConfig = isInside(file, os.homedir()) || isInside(file, stateDir);
  if (!userConfig || isInside(file, appRoot) || file === WRITE_LOG_PATH) return;
  try {
    fs.mkdirSync(path.dirname(WRITE_LOG_PATH), { recursive: true });
    try {
      if (fs.statSync(WRITE_LOG_PATH).size > MAX_LOG_BYTES) fs.renameSync(WRITE_LOG_PATH, `${WRITE_LOG_PATH}.1`);
    } catch {
      // No log yet.
    }
    const entry = { at: new Date().toISOString(), actor: currentWriteActor(), file, ...(detail ? { detail } : {}), pid: process.pid };
    fs.appendFileSync(WRITE_LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging is best effort.
  }
}

// The most recent logged write to filePath, or null.
export function lastConfigWrite(filePath) {
  const file = path.resolve(filePath);
  let text = "";
  try {
    text = fs.readFileSync(WRITE_LOG_PATH, "utf8");
  } catch {
    return null;
  }
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.file === file) return entry;
    } catch {
      // Skip a torn line.
    }
  }
  return null;
}

// The bash installer logs its own writes: node write-log.mjs record <file> [detail]
if (isMainModule(import.meta.url) && process.argv[2] === "record" && process.argv[3]) {
  recordConfigWrite(process.argv[3], process.argv[4] || null);
}
