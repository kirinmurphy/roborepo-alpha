// Files and folders a package copies to ~/.roborepo/package-runtime/<package-id>/ so harness
// config can point at them (a status-line script, a plugin folder). Config patches name an
// installed asset as `${package-runtime:<source basename>}`.

import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mjs";
import { stateDir } from "./state-paths.mjs";

export function packageRuntimeAssetDestination(pkg, component) {
  const target = component.target || path.basename(component.source);
  return path.join(stateDir, "package-runtime", pkg.id, target);
}

// A folder is replaced wholesale so a file dropped from the source does not linger; a file is
// copied and made executable.
export function installPackageRuntimeAsset(pkg, component, { dryRun = false } = {}) {
  const sourcePath = path.join(repoRoot, component.source);
  const destPath = packageRuntimeAssetDestination(pkg, component);
  if (dryRun) {
    console.log(`  [dry-run] install package-runtime asset ${component.source} -> ${destPath}`);
    return destPath;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.statSync(sourcePath).isDirectory()) {
    fs.rmSync(destPath, { recursive: true, force: true });
    fs.cpSync(sourcePath, destPath, { recursive: true });
  } else {
    fs.copyFileSync(sourcePath, destPath);
    fs.chmodSync(destPath, fs.statSync(sourcePath).mode | 0o755);
  }
  console.log(`  package-runtime asset: ${destPath}`);
  return destPath;
}

export function removePackageRuntimeAsset(pkg, component, { dryRun = false } = {}) {
  const destPath = packageRuntimeAssetDestination(pkg, component);
  if (dryRun) {
    console.log(`  [dry-run] remove package-runtime asset ${destPath}`);
    return;
  }
  if (!fs.existsSync(destPath)) {
    console.log(`  ok: package-runtime asset already absent: ${destPath}`);
    return;
  }
  fs.rmSync(destPath, { recursive: true, force: true });
  console.log(`  removed package-runtime asset: ${destPath}`);
}

function packageRuntimeSubstitutions(pkg) {
  return new Map(
    (pkg.components || pkg.resources || [])
      .filter((component) => component.type === "package-runtime-asset")
      .map((component) => [path.basename(component.source), packageRuntimeAssetDestination(pkg, component)])
  );
}

function expandValue(value, substitutions) {
  if (typeof value === "string") {
    return value.replace(/\$\{package-runtime:([^}]+)\}/g, (match, name) => substitutions.get(name) || match);
  }
  if (Array.isArray(value)) return value.map((entry) => expandValue(entry, substitutions));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandValue(entry, substitutions)]));
  }
  return value;
}

// Replaces each `${package-runtime:<name>}` with that asset's installed path.
export function expandPackageRuntimeRefs(value, pkg) {
  return expandValue(value, packageRuntimeSubstitutions(pkg));
}
