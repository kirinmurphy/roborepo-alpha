import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { repoRoot } from "./paths.mjs";

// Content hash of the portal's served/serving source (portal/ + scripts/cli/, the same tree
// portal-server.mjs reads from and is itself part of; plus modules/, which portal routes like
// portal-routes-developer-runtime.mjs import transitively). A running `roborepo web`/`runtime`
// server is detached on purpose so it outlives the CLI invocation that spawned it — but a Node
// process never re-reads .mjs files after a later git pull/merge changes them on disk, so it can
// keep serving stale portal code indefinitely with no visible sign anything is wrong. The server
// computes this once at startup and reports it via /api/portal/status; a new `serve`/`web`
// invocation recomputes it fresh from the current checkout and compares (see resolvePortalPort in
// telemetry.mjs) to detect "a portal is already running here, but its code is now stale."
export function computePortalSourceHash() {
  const hash = crypto.createHash("sha256");
  const roots = [
    path.join(repoRoot, "portal"),
    path.join(repoRoot, "scripts", "cli"),
    path.join(repoRoot, "modules"),
  ];
  for (const root of roots) {
    for (const rel of walkFiles(root)) {
      hash.update(rel);
      hash.update("\0");
      try {
        hash.update(fs.readFileSync(path.join(root, rel)));
      } catch {
        // File vanished between listing and read (rare race) — skip rather than fail.
      }
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

// Cheap signature of the code the running server process has loaded: scripts/cli, the harness
// adapters, and modules/. Unlike computePortalSourceHash it reads only file sizes and modification
// times, so the server can recompute it on every status poll and tell an open page "the code on disk
// has changed since this server started" — page assets under portal/ are left out because a reload
// already picks those up, while server modules stay as loaded until the process restarts.
export function computeServerCodeSignature() {
  const hash = crypto.createHash("sha256");
  const roots = [
    path.join(repoRoot, "scripts", "cli"),
    path.join(repoRoot, "scripts", "harnesses"),
    path.join(repoRoot, "modules"),
  ];
  for (const root of roots) {
    for (const rel of walkFiles(root)) {
      if (!/\.(mjs|cjs|js)$/.test(rel)) continue;
      try {
        const stat = fs.statSync(path.join(root, rel));
        hash.update(`${rel}\0${stat.size}\0${stat.mtimeMs}\0`);
      } catch {
        // File vanished between listing and stat (rare race) — skip rather than fail.
      }
    }
  }
  return hash.digest("hex");
}

function walkFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, base, out);
    else if (entry.isFile()) out.push(path.relative(base, abs));
  }
  return out;
}
