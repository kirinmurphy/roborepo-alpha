// Resolve only the app bundle locations declared by a provider manifest. The directory levels
// are bounded so an app install never turns discovery into a filesystem search.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MAX_ENTRIES_PER_LEVEL = 64;

export function resolveDesktopRuntimes(candidates = [], { rootPath = expandRoot, probe } = {}) {
  const observations = [];
  const warnings = [];
  for (const candidate of candidates) {
    let sawRuntime = false;
    for (const root of candidate.roots) {
      for (const bundle of matchingBundles(rootPath(root), candidate.layouts)) {
        sawRuntime = true;
        if (bundleId(bundle) !== candidate.bundleId || (candidate.verifiedMarker && !fs.existsSync(path.join(path.dirname(bundle), candidate.verifiedMarker)))) {
          warnings.push(`${candidate.label} runtime failed app identity validation.`);
          continue;
        }
        const executable = path.join(bundle, candidate.executable);
        const version = probe(executable);
        if (!version) {
          warnings.push(`${candidate.label} runtime failed its version check.`);
          continue;
        }
        observations.push({ kind: "executable", value: candidate.label, source: "desktop", resolvedPath: executable, version });
      }
    }
    if (!sawRuntime && candidate.parentApp) {
      const parent = candidate.parentApp;
      if (parent.roots.some((root) => bundleId(path.join(rootPath(root), parent.bundle)) === parent.bundleId)) {
        warnings.push(`Open ${candidate.parentApp.label}’s Code tab to install ${candidate.label}, then run roborepo harness refresh.`);
      }
    }
  }
  observations.sort((a, b) => compareVersions(b.version, a.version));
  return { observations, warnings };
}

function expandRoot(root) {
  return root.startsWith("~/") ? path.join(os.homedir(), root.slice(2)) : root;
}

function matchingBundles(root, layouts) {
  const found = new Set();
  for (const layout of layouts) {
    let paths = [root];
    for (const segment of layout) {
      paths = paths.flatMap((parent) => segment === "*"
        ? directoryNames(parent).map((name) => path.join(parent, name))
        : [path.join(parent, segment)]);
    }
    for (const bundle of paths) if (fs.existsSync(bundle)) found.add(bundle);
  }
  return [...found];
}

function directoryNames(parent) {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => compareVersions(b.name, a.name))
      .slice(0, MAX_ENTRIES_PER_LEVEL)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function bundleId(bundle) {
  const info = path.join(bundle, "Contents", "Info.plist");
  try {
    const content = fs.readFileSync(info, "utf8");
    const match = content.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    if (match) return match[1];
    if (process.platform === "darwin") {
      return execFileSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", info], { encoding: "utf8", timeout: 2000 }).trim();
    }
  } catch { /* A missing or unreadable bundle is not valid evidence. */ }
  return null;
}

function compareVersions(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
