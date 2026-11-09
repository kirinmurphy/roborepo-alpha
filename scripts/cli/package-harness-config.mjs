import fs from "node:fs";
import path from "node:path";
import { repoRoot, rootConfigActive, rootConfigBaseline, harnessHome } from "./paths.mjs";
import { stateDir } from "./state-paths.mjs";
import { writeRootConfig } from "./root-config-writes.mjs";
import { getHarnessProvider, listHarnessProviders } from "../harnesses/registry.mjs";
import { requireHarnessCapability } from "../harnesses/harness-runtime.mjs";

export function packageRuntimeAssetDestination(pkg, component) {
  const target = component.target || path.basename(component.source);
  return path.join(stateDir, "package-runtime", pkg.id, target);
}

export function installPackageRuntimeAsset(pkg, component, { dryRun = false } = {}) {
  const sourcePath = path.join(repoRoot, component.source);
  const destPath = packageRuntimeAssetDestination(pkg, component);
  if (dryRun) {
    console.log(`  [dry-run] install package-runtime asset ${component.source} -> ${destPath}`);
    return destPath;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
  fs.chmodSync(destPath, fs.statSync(sourcePath).mode | 0o755);
  console.log(`  package-runtime asset: ${destPath}`);
  return destPath;
}

export function removePackageRuntimeAsset(pkg, component, { dryRun = false } = {}) {
  const destPath = packageRuntimeAssetDestination(pkg, component);
  if (dryRun) {
    console.log(`  [dry-run] remove package-runtime asset ${destPath}`);
    return;
  }
  try {
    fs.unlinkSync(destPath);
    console.log(`  removed package-runtime asset: ${destPath}`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    console.log(`  ok: package-runtime asset already absent: ${destPath}`);
  }
}

// What a provider's package adapter is handed for its harness: where its root config lives (active
// and the baseline that seeds it), its home folder, and a write that records the change the same
// way every root-config write does. Callers (tests, a scratch sandbox) may point configPath and
// write elsewhere.
export function providerIO(provider, { configPath = rootConfigActive[provider.id], write } = {}) {
  return {
    configPath,
    baselinePath: rootConfigBaseline[provider.id],
    homePath: harnessHome[provider.id],
    write: write || ((content) => writeRootConfig(provider.id, configPath, content)),
  };
}

// The provider that owns a harness-scoped resource, checked for the capability it needs.
export function resourceProvider(component, capability) {
  const provider = getHarnessProvider(component.harness);
  requireHarnessCapability(provider, capability);
  return provider;
}

// Every provider that declares `capability`, whether or not it is enabled on this machine: package
// resources are written for each harness RoboRepo supports, the same as rules and hooks.
export function capableProviders(capability) {
  return listHarnessProviders().filter((provider) => provider.manifest.capabilities.includes(capability));
}

// A resource scoped to one harness names it; one without a harness applies to every provider that
// declares the capability (the same rule rules resources follow).
export function resourceProviders(component, capability) {
  return component.harness ? [resourceProvider(component, capability)] : capableProviders(capability);
}

// --------------------------------------------------------------------------- plugin folders
//
// A plugin folder is copied whole to its install path, then the owning provider registers it.

export function pluginDirDestination(pkg, component) {
  return path.join(stateDir, "package-runtime", pkg.id, path.basename(component.source));
}

// Replaces the installed copy wholesale so a file dropped from the source does not linger.
export function installPluginDir(pkg, component, { dryRun = false } = {}) {
  const provider = resourceProvider(component, "package-plugin-dirs");
  const destPath = pluginDirDestination(pkg, component);
  if (dryRun) {
    console.log(`  [dry-run] install ${provider.manifest.displayName} plugin folder ${component.source} -> ${destPath}`);
    return;
  }
  fs.rmSync(destPath, { recursive: true, force: true });
  fs.cpSync(path.join(repoRoot, component.source), destPath, { recursive: true });
  provider.adapters.packages.registerPluginDir(destPath, providerIO(provider));
}

export function removePluginDir(pkg, component, { dryRun = false } = {}) {
  const provider = resourceProvider(component, "package-plugin-dirs");
  const destPath = pluginDirDestination(pkg, component);
  if (dryRun) {
    console.log(`  [dry-run] remove ${provider.manifest.displayName} plugin folder ${destPath}`);
    return;
  }
  fs.rmSync(destPath, { recursive: true, force: true });
  provider.adapters.packages.unregisterPluginDir(destPath, providerIO(provider));
}

// --------------------------------------------------------------------------- harness config

export function readHarnessConfig(component, pkg) {
  const data = JSON.parse(fs.readFileSync(path.join(repoRoot, component.source), "utf8"));
  return expandPackageRuntimeRefs(data, packageRuntimeSubstitutions(pkg));
}

function packageRuntimeSubstitutions(pkg) {
  return new Map(
    (pkg.components || [])
      .filter((component) => component.type === "package-runtime-asset")
      .map((component) => [path.basename(component.source), packageRuntimeAssetDestination(pkg, component)])
  );
}

function expandPackageRuntimeRefs(value, substitutions) {
  if (typeof value === "string") {
    return value.replace(/\$\{package-runtime:([^}]+)\}/g, (match, name) => substitutions.get(name) || match);
  }
  if (Array.isArray(value)) return value.map((entry) => expandPackageRuntimeRefs(entry, substitutions));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandPackageRuntimeRefs(entry, substitutions)]));
  }
  return value;
}

// Reads the component config once and hands it to the owning provider, which merges it into its
// own root config through io.write.
export function mergeHarnessConfig(pkg, component, options = {}) {
  const provider = resourceProvider(component, "package-config");
  provider.adapters.rootConfig.mergePackageComponent(pkg, readHarnessConfig(component, pkg), providerIO(provider, options));
}

export function unmergeHarnessConfig(pkg, component, options = {}) {
  const provider = resourceProvider(component, "package-config");
  provider.adapters.rootConfig.unmergePackageComponent(pkg, readHarnessConfig(component, pkg), providerIO(provider, options));
}
