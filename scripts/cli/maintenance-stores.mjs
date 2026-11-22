// `roborepo maintenance stores` — inspect and reset the bounded local stores.
//
// One command over the whole registry rather than a per-store flag on each feature's CLI: a user
// asking "what is roborepo keeping on my disk" should not have to know that telemetry, developer-runtime,
// and the capture packages each own part of the answer.
//
// Reset applies a store's own policy (the same measurement its write path uses), or with --all
// clears it outright. Nothing here invents a second retention rule.

import fs from "node:fs";
import path from "node:path";
import { isMainModule } from "./roots.mjs";
import { stateDir } from "./state-paths.mjs";
import { withCleanupStoreLock } from "../../modules/repositories/worktree-cleanup-lock.mjs";
import { loadSettings } from "../../modules/developer-runtime/settings.mjs";
import {
  FILE_SET_SHAPE,
  FOLDER_SET_SHAPE,
  LOG_SHAPE,
  describeFileSet,
  describeFolderSet,
  findRetentionStore,
  folderAgeDays,
  folderSetEntries,
  formatBytes,
  measureFileSet,
  measureFolderSet,
  measureLog,
  removeFolderSetEntries,
  resolveStorePolicy,
  retentionStores,
} from "../../modules/retention/index.mjs";

export function maintenanceStores(args = []) {
  const [sub, ...rest] = args;
  if (!sub || sub === "list") return listStores(rest);
  if (sub === "reset") return resetStore(rest);
  console.error("usage: roborepo maintenance stores [list | reset <id> [--all] [--dry-run]]");
  return 2;
}

function listStores(args) {
  if (args.length) {
    console.error("usage: roborepo maintenance stores list");
    return 2;
  }
  const rows = retentionStores(stateDir).map((store) => {
    const policy = policyFor(store);
    const { bytes, detail } = inspect(store);
    return {
      id: store.id,
      label: store.label,
      bytes,
      detail,
      bound: describeBound(policy),
      headroom: policy.maxBytes ? Math.round((bytes / policy.maxBytes) * 100) : null,
    };
  });

  const width = Math.max(...rows.map((row) => row.id.length));
  for (const row of rows) {
    const used = row.headroom === null ? "" : ` (${row.headroom}% of cap)`;
    console.log(`${row.id.padEnd(width)}  ${formatBytes(row.bytes).padStart(9)}${used}`);
    console.log(`${" ".repeat(width)}  ${row.label} — ${row.bound}`);
    if (row.detail) console.log(`${" ".repeat(width)}  ${row.detail}`);
  }
  console.log("");
  console.log(`state root: ${stateDir}`);
  console.log("reset one with: roborepo maintenance stores reset <id> [--all] [--dry-run]");
  return 0;
}

async function resetStore(args) {
  const all = args.includes("--all");
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((arg) => arg !== "--all" && arg !== "--dry-run");
  if (rest.length !== 1) {
    console.error("usage: roborepo maintenance stores reset <id> [--all] [--dry-run]");
    return 2;
  }

  const store = findRetentionStore(stateDir, rest[0]);
  if (!store) {
    console.error(`unknown store: ${rest[0]}`);
    console.error(`known: ${retentionStores(stateDir).map((s) => s.id).join(", ")}`);
    return 2;
  }

  // A dry run only reads, so it takes no lock.
  if (dryRun) return all ? previewClear(store) : previewTrim(store);
  const reset = () => all ? clearStore(store) : trimStore(store);
  if (!["worktree-removal-log", "worktree-cleanup-transactions"].includes(store.id)) return reset();
  try {
    return await withCleanupStoreLock(stateDir, reset);
  } catch (error) {
    console.error(`${store.id}: ${error.message}`);
    return 1;
  }
}

// Apply the store's own policy. This is the same measurement its write path performs, so a reset
// that reports "nothing to do" is telling the truth about the store being within its bound.
function measureStore(store) {
  const policy = policyFor(store);
  if (store.shape === LOG_SHAPE) return measureLog({ filePath: store.target, policy });
  if (store.shape === FOLDER_SET_SHAPE) return measureFolderSet({ dirPath: store.target, policy });
  return measureFileSet({ dirPath: store.target, policy, filter: store.filter });
}

function unitOf(store) {
  if (store.shape === LOG_SHAPE) return "record";
  return store.shape === FOLDER_SET_SHAPE ? "folder" : "file";
}

function trimStore(store) {
  const verdict = measureStore(store);
  if (!verdict.act) {
    console.log(`${store.id}: already within policy (${verdict.reason})`);
    return 0;
  }

  let removed;
  if (store.shape === LOG_SHAPE) removed = trimLog(store.target, verdict.dropCount);
  else if (store.shape === FOLDER_SET_SHAPE) {
    const result = removeFolderSetEntries({ dirPath: store.target, paths: verdict.files });
    for (const refusal of result.refused) console.error(`${store.id}: left ${refusal.path} (${refusal.reason})`);
    removed = result.removed.length;
  } else removed = removeFiles(verdict.files);
  console.log(`${store.id}: removed ${removed} ${unitOf(store)}(s) (${verdict.reason})`);
  return 0;
}

// --dry-run: what trimStore would remove, with sizes and ages, removing nothing. A log's records
// carry no per-record listing worth printing, so a log reports the count.
function previewTrim(store) {
  if (isLinkedFolderSet(store)) {
    console.log(`${store.id}: ${store.target} is a link, not a real folder; a reset would refuse it and remove nothing`);
    return 0;
  }
  const verdict = measureStore(store);
  if (!verdict.act) {
    console.log(`${store.id}: already within policy (${verdict.reason}); nothing would be removed`);
    return 0;
  }
  if (store.shape === LOG_SHAPE) {
    console.log(`${store.id}: would remove ${verdict.dropCount} record(s) (${verdict.reason})`);
    return 0;
  }
  const entries = store.shape === FOLDER_SET_SHAPE ? verdict.entries : verdict.files.map(statEntry).filter(Boolean);
  printPreview(store, entries, `would remove ${entries.length} ${unitOf(store)}(s) (${verdict.reason})`);
  return 0;
}

// --all --dry-run: everything --all would delete. --all removes the whole target, so every entry in
// the directory is listed, not only the ones the store's filter counts.
function previewClear(store) {
  if (store.shape === LOG_SHAPE) {
    const { bytes, detail } = inspect(store);
    console.log(`${store.id}: would clear ${detail === "absent" ? "nothing (absent)" : formatBytes(bytes)}`);
    return 0;
  }
  if (isLinkedFolderSet(store)) {
    console.log(`${store.id}: would remove only the link at ${store.target}; its target is left alone`);
    return 0;
  }
  const entries = folderSetEntries({ dirPath: store.target }) ?? [];
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  printPreview(store, entries, `would clear ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
  return 0;
}

// A folder set whose root was replaced by a link: the reset refuses it (removeFolderSetEntries) and
// --all removes only the link, so a preview must not list the link target's contents.
function isLinkedFolderSet(store) {
  if (store.shape !== FOLDER_SET_SHAPE) return false;
  try {
    return fs.lstatSync(store.target).isSymbolicLink();
  } catch {
    return false;
  }
}

function printPreview(store, entries, headline) {
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`${store.id}: ${headline}, ${formatBytes(total)} — dry run, nothing removed`);
  const now = new Date();
  for (const entry of entries) {
    const age = `${folderAgeDays(entry, now).toFixed(1)}d old`;
    console.log(`  ${formatBytes(entry.bytes).padStart(9)}  ${age.padStart(10)}  ${path.basename(entry.path)}`);
  }
}

function statEntry(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return { path: filePath, bytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

// --all is the destructive form: everything goes, not just what policy would drop. Reporting the
// byte count makes the difference visible in the transcript. rmSync removes links inside the tree
// as links and never follows them.
function clearStore(store) {
  const { bytes } = inspect(store);
  try {
    fs.rmSync(store.target, { recursive: true, force: true });
  } catch (error) {
    console.error(`${store.id}: ${error.message}`);
    return 1;
  }
  console.log(`${store.id}: cleared (${formatBytes(bytes)})`);
  return 0;
}

function trimLog(filePath, dropCount) {
  let lines;
  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim());
  } catch {
    return 0;
  }
  const dropped = Math.min(dropCount, lines.length - 1);
  // Rewrites in place rather than via a temp file. A reset is a foreground command, so no reader
  // holds a cursor across it; the write-path callers keep their own commit strategies.
  try {
    fs.writeFileSync(filePath, lines.slice(dropped).join("\n") + "\n");
  } catch {
    return 0;
  }
  return dropped;
}

function removeFiles(files) {
  let removed = 0;
  for (const filePath of files) {
    try {
      fs.rmSync(filePath, { force: true });
      removed += 1;
    } catch {
      // Skip; the next reset re-measures.
    }
  }
  return removed;
}

// Runtime's window is a user preference, so the displayed and applied bound must be the live
// value rather than the registry's default. Every other store's policy is its literal.
function policyFor(store) {
  if (!store.preferenceKey) return store.policy;
  let preferences = null;
  try {
    preferences = loadSettings({ stateRoot: stateDir })?.preferences ?? null;
  } catch {
    preferences = null;
  }
  return resolveStorePolicy(store, preferences);
}

function inspect(store) {
  if (store.shape === FOLDER_SET_SHAPE) {
    const { entryCount, totalBytes, sparedBytes } = describeFolderSet({ dirPath: store.target });
    return { bytes: totalBytes, sparedBytes, detail: entryCount ? `${entryCount} folder(s)` : "empty" };
  }
  if (store.shape === FILE_SET_SHAPE) {
    const { fileCount, totalBytes } = describeFileSet({ dirPath: store.target, filter: store.filter });
    return { bytes: totalBytes, detail: fileCount ? `${fileCount} file(s)` : "empty" };
  }
  try {
    return { bytes: fs.statSync(store.target).size, detail: null };
  } catch {
    return { bytes: 0, detail: "absent" };
  }
}

function describeBound(policy) {
  const parts = [];
  if (policy.maxAgeDays !== null) parts.push(`${policy.maxAgeDays}d`);
  if (policy.maxBytes !== null) parts.push(formatBytes(policy.maxBytes));
  return parts.length ? `bound ${parts.join(" / ")}` : "unbounded";
}


// `--check` mode for doctor: exit 0 when every store is within its byte cap, 1 with one line per
// offender otherwise. Kept beside the command so the reported bound and the enforced bound are read
// from the same place.
//
// Only the byte cap is checked. Age is enforced on the write path and a store that has not been
// written to lately is legitimately holding old records — flagging that would report normal
// behavior as a fault.
// A store over its cap with every byte in recently changed folders the byte cap spares is reported
// as a hint, not a failure: a reset cannot act on it yet, and it is capped once those folders go quiet.
export function checkStoreBounds() {
  const health = storeHealth();
  for (const store of health.filter((entry) => entry.spared)) {
    console.log(
      `hint: ${store.id} is ${formatBytes(store.bytes)}, over its ${formatBytes(store.maxBytes)} cap, but`
      + ` all of it is in folders changed in the last hour; the cap applies once they go quiet`,
    );
  }
  const over = health.filter((store) => store.over);
  for (const store of over) {
    console.error(
      `fail: ${store.id} is ${formatBytes(store.bytes)}, over its ${formatBytes(store.maxBytes)} cap`
      + ` — run: roborepo maintenance stores reset ${store.id}`,
    );
  }
  return over.length === 0 ? 0 : 1;
}

// Registry-backed store list for doctor, which needs sizes and bounds without the CLI formatting.
// `over`: over the cap with something a reset can remove (the byte walk removes quiet folders
// first). `spared`: over the cap, but every byte is in folders the cap spares for now.
export function storeHealth() {
  return retentionStores(stateDir).map((store) => {
    const policy = policyFor(store);
    const { bytes, sparedBytes = 0 } = inspect(store);
    const capped = policy.maxBytes !== null && bytes > policy.maxBytes;
    const over = capped && bytes - sparedBytes > 0;
    return {
      id: store.id,
      bytes,
      sparedBytes,
      maxBytes: policy.maxBytes,
      over,
      spared: capped && !over,
      path: path.relative(stateDir, store.target),
    };
  });
}

// Direct-invocation entry, so scripts/doctor.sh can run `node maintenance-stores.mjs --check`
// without going through the CLI dispatcher — matching how local-config-repair.mjs is called.
// Uses isMainModule() from roots.mjs rather than a hand-rolled argv-to-module-URL comparison:
// path normalization does not resolve symlinks, so that comparison silently no-ops when the script
// is reached through a symlinked path — which is how an installed roborepo runs it.
if (isMainModule(import.meta.url)) {
  process.exit(process.argv.includes("--check") ? checkStoreBounds() : await maintenanceStores(process.argv.slice(2)));
}
