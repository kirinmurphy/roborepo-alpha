// A cheap stand-in for "would buildPlanSnapshot return something different?", so a poller can
// check it every tick and pay for a full rebuild only when it changes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkoutRootsFor, loadRegistry, resolveGitDir } from "../repositories/index.mjs";
import { repositoryCheckouts } from "./checkouts.mjs";
import { plannableRepositories } from "./canonical-scan.mjs";
import { PLANS_DIR, locateStore } from "./plan-store.mjs";

// Covers the scanned repositories, each one's checkouts (Home joins plans to worktrees by name), the
// path, mtime, and size of every entry under the store's plans folder (plans-config.json included,
// since it changes validation), and the store's HEAD and branch refs. Only directory reads, stats,
// and Git's small administrative files — no plan contents, no Git subprocesses, and never a fetch:
// remote changes arrive through startup and explicit refresh. Per-plan Git fields (last commit time,
// review state) are not covered; readPlanRecord caches those by file mtime too, so a rebuild would
// not refresh them.
export function planSnapshotFingerprint({ stateRoot, registry = null } = {}) {
  const known = registry || loadRegistry({ stateRoot });
  const parts = [];
  for (const record of plannableRepositories(known)) {
    if (!checkoutRootsFor(known, record.id).length) continue;
    parts.push(`repo\0${record.id}\0${record.displayName}`);
    const checkouts = repositoryCheckouts(known, record.id);
    for (const checkout of checkouts) parts.push(`checkout\0${checkout.path}\0${checkout.label ?? ""}\0${checkout.isWorktree}`);
    const store = checkouts.length ? locateStore(checkouts[0].path) : null;
    if (!store) {
      parts.push("store\0none");
      continue;
    }
    parts.push(`store\0${store.root}\0${store.missing}`);
    statPlanTree(path.join(store.root, PLANS_DIR), parts);
    storeRefs(store, parts);
  }
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex");
}

function statPlanTree(dir, parts) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    parts.push(`unreadable\0${dir}\0${err?.code || ""}`);
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      statPlanTree(full, parts);
      continue;
    }
    try {
      const stat = fs.statSync(full);
      parts.push(`file\0${full}\0${stat.mtimeMs}\0${stat.size}`);
    } catch {
      parts.push(`gone\0${full}`);
    }
  }
}

// A loose ref holds its commit id, so its contents are read; a packed ref lives in packed-refs, whose
// stat changes whenever Git rewrites it. The tracking ref is read too, since pending-commit counts
// depend on it. A reftable repository keeps every ref in binary tables, and rewrites tables.list on
// each ref update.
function storeRefs(store, parts) {
  const git = resolveGitDir(store.root);
  if (!git) return;
  parts.push(`head\0${readOrEmpty(path.join(git.gitDir, "HEAD")).trim()}`);
  for (const ref of ["refs/heads/repo-plans", "refs/remotes/origin/repo-plans"]) {
    parts.push(`ref\0${ref}\0${readOrEmpty(path.join(git.commonDir, ref)).trim()}`);
  }
  try {
    const stat = fs.statSync(path.join(git.commonDir, "packed-refs"));
    parts.push(`packed\0${stat.mtimeMs}\0${stat.size}`);
  } catch {
    parts.push("packed\0none");
  }
  for (const dir of new Set([git.commonDir, git.gitDir])) {
    parts.push(`reftable\0${readOrEmpty(path.join(dir, "reftable", "tables.list")).trim()}`);
  }
}

function readOrEmpty(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
