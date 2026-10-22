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
import { loadSettings } from "../../modules/developer-runtime/settings.mjs";
import {
  FILE_SET_SHAPE,
  LOG_SHAPE,
  describeFileSet,
  findRetentionStore,
  formatBytes,
  measureFileSet,
  measureLog,
  resolveStorePolicy,
  retentionStores,
} from "../../modules/retention/index.mjs";

export function maintenanceStores(args = []) {
  const [sub, ...rest] = args;
  if (!sub || sub === "list") return listStores(rest);
  if (sub === "reset") return resetStore(rest);
  console.error("usage: roborepo maintenance stores [list | reset <id> [--all]]");
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
  console.log("reset one with: roborepo maintenance stores reset <id> [--all]");
  return 0;
}

function resetStore(args) {
  const all = args.includes("--all");
  const rest = args.filter((arg) => arg !== "--all");
  if (rest.length !== 1) {
    console.error("usage: roborepo maintenance stores reset <id> [--all]");
    return 2;
  }

  const store = findRetentionStore(stateDir, rest[0]);
  if (!store) {
    console.error(`unknown store: ${rest[0]}`);
    console.error(`known: ${retentionStores(stateDir).map((s) => s.id).join(", ")}`);
    return 2;
  }

  if (all) return clearStore(store);

  // Apply the store's own policy. This is the same measurement its write path performs, so a reset
  // that reports "nothing to do" is telling the truth about the store being within its bound.
  const policy = policyFor(store);
  const verdict = store.shape === LOG_SHAPE
    ? measureLog({ filePath: store.target, policy })
    : measureFileSet({ dirPath: store.target, policy, filter: store.filter });

  if (!verdict.act) {
    console.log(`${store.id}: already within policy (${verdict.reason})`);
    return 0;
  }

  const removed = store.shape === LOG_SHAPE
    ? trimLog(store.target, verdict.dropCount)
    : removeFiles(verdict.files);
  console.log(`${store.id}: removed ${removed} ${store.shape === LOG_SHAPE ? "record" : "file"}(s) (${verdict.reason})`);
  return 0;
}

// --all is the destructive form: everything goes, not just what policy would drop. Reporting the
// byte count makes the difference visible in the transcript.
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
export function checkStoreBounds() {
  const over = storeHealth().filter((store) => store.over);
  for (const store of over) {
    console.error(
      `fail: ${store.id} is ${formatBytes(store.bytes)}, over its ${formatBytes(store.maxBytes)} cap`
      + ` — run: roborepo maintenance stores reset ${store.id}`,
    );
  }
  return over.length === 0 ? 0 : 1;
}

// Registry-backed store list for doctor, which needs sizes and bounds without the CLI formatting.
export function storeHealth() {
  return retentionStores(stateDir).map((store) => {
    const policy = policyFor(store);
    const { bytes } = inspect(store);
    return {
      id: store.id,
      bytes,
      maxBytes: policy.maxBytes,
      over: policy.maxBytes !== null && bytes > policy.maxBytes,
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
  process.exit(process.argv.includes("--check") ? checkStoreBounds() : maintenanceStores(process.argv.slice(2)));
}
