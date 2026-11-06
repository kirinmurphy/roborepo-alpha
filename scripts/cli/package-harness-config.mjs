import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mjs";
import { stateDir } from "./state-paths.mjs";
import { writeRootConfig } from "./root-config-writes.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { requireHarnessCapability } from "../harnesses/harness-runtime.mjs";
import { validateAdapterComputeResult } from "../harnesses/schemas.mjs";

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

// A Claude plugin folder is registered through CLAUDE_CODE_PLUGIN_DIRS because it is the one route
// Claude Code reads for desktop-hosted sessions as well as terminal ones, with no marketplace step.
const CLAUDE_PLUGIN_DIRS_ENV = "CLAUDE_CODE_PLUGIN_DIRS";

export function claudePluginDirDestination(pkg, component) {
  return path.join(stateDir, "package-runtime", pkg.id, path.basename(component.source));
}

function pluginDirList(settings) {
  const value = settings.env?.[CLAUDE_PLUGIN_DIRS_ENV];
  return typeof value === "string" ? value.split(path.delimiter).filter(Boolean) : [];
}

export function claudePluginDirRegistered(settings, pkg, component) {
  return pluginDirList(settings).includes(claudePluginDirDestination(pkg, component));
}

// Replaces the installed copy wholesale so a file dropped from the source does not linger. The
// variable can name folders from elsewhere, so entries are added and removed one at a time.
export function installClaudePluginDir(pkg, component, { dryRun = false, readSettings, writeSettings, settingsPath } = {}) {
  const sourcePath = path.join(repoRoot, component.source);
  const destPath = claudePluginDirDestination(pkg, component);
  if (dryRun) {
    console.log(`  [dry-run] install Claude plugin folder ${component.source} -> ${destPath}`);
    return;
  }
  fs.rmSync(destPath, { recursive: true, force: true });
  fs.cpSync(sourcePath, destPath, { recursive: true });
  const settings = readSettings(settingsPath);
  const dirs = pluginDirList(settings);
  if (!dirs.includes(destPath)) {
    settings.env = { ...settings.env, [CLAUDE_PLUGIN_DIRS_ENV]: [...dirs, destPath].join(path.delimiter) };
    writeSettings(settingsPath, settings);
  }
  console.log(`  Claude plugin folder: ${destPath}`);
}

export function removeClaudePluginDir(pkg, component, { dryRun = false, readSettings, writeSettings, settingsPath } = {}) {
  const destPath = claudePluginDirDestination(pkg, component);
  if (dryRun) {
    console.log(`  [dry-run] remove Claude plugin folder ${destPath}`);
    return;
  }
  fs.rmSync(destPath, { recursive: true, force: true });
  const settings = readSettings(settingsPath);
  const dirs = pluginDirList(settings);
  if (dirs.includes(destPath)) {
    const remaining = dirs.filter((dir) => dir !== destPath);
    if (remaining.length) settings.env[CLAUDE_PLUGIN_DIRS_ENV] = remaining.join(path.delimiter);
    else delete settings.env[CLAUDE_PLUGIN_DIRS_ENV];
    if (Object.keys(settings.env).length === 0) delete settings.env;
    writeSettings(settingsPath, settings);
  }
  console.log(`  removed Claude plugin folder: ${destPath}`);
}

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

// Orchestrator only: reads the component config once, dispatches to the owning provider's
// rootConfig.mergePackageComponent/unmergePackageComponent, and performs the actual write for
// providers that return computed content rather than writing themselves (Codex's TOML path;
// Claude's JSON path writes directly via the caller-supplied writeSettings, matching how the rest
// of the Claude root-config write surface already works). Provider adapters cannot call
// writeRootConfig themselves without recreating the paths.mjs/registry.mjs import cycle this
// module already sits above.
export function mergeHarnessConfig(pkg, component, options) {
  const provider = getHarnessProvider(component.harness);
  requireHarnessCapability(provider, "package-config");
  const config = readHarnessConfig(component, pkg);
  const result = provider.adapters.rootConfig.mergePackageComponent(pkg, config, options);
  applyPackageComponentResult(component.harness, options, result, "wired");
}

export function unmergeHarnessConfig(pkg, component, options) {
  const provider = getHarnessProvider(component.harness);
  requireHarnessCapability(provider, "package-config");
  const config = readHarnessConfig(component, pkg);
  const result = provider.adapters.rootConfig.unmergePackageComponent(pkg, config, options);
  applyPackageComponentResult(component.harness, options, result, "removed");
}

// Some providers' mergePackageComponent/unmergePackageComponent return { changed, content } instead
// of writing directly (Codex's TOML path today; any future provider following that same
// convention), so there is nothing to apply here for a provider that writes inline (Claude's JSON
// path writes directly via the caller-supplied writeSettings and returns undefined). The target
// path comes from the caller-supplied `options` (keyed `<harness>ConfigPath`, e.g.
// `codexConfigPath`) rather than the registry's rootConfigActive map, since callers — including
// this file's own characterization tests — legitimately point at a path other than the real active
// root config (a scratch fixture, a roundtrip-test sandbox, etc.); the registry only knows the real
// one. Dispatches generically off the harness id for the write call and log label, mirroring
// hook-composition.mjs's writeHooksFile — the identical two-shape asymmetry, already solved there.
function applyPackageComponentResult(harness, options, result, verb) {
  if (!result) return;
  validateAdapterComputeResult(result);
  const { changed, content } = result;
  const configPath = options[`${harness}ConfigPath`];
  const label = getHarnessProvider(harness).manifest.displayName;
  if (!changed) {
    console.log(`  ok: ${label} package config unchanged -> ${configPath}`);
    return;
  }
  writeRootConfig(harness, configPath, content);
  const arrow = verb === "removed" ? "<-" : "->";
  console.log(`  ${verb}: ${label} package config ${arrow} ${configPath}`);
}

export function codexStatusLineIncludes(configText, item) {
  const match = configText.match(/^\[tui\]\s*\n([\s\S]*?)(?=^\[|\s*$)/m);
  if (!match) return false;
  const array = match[1].match(/^status_line\s*=\s*\[([^\]]*)\]/m);
  if (!array) return false;
  return [...array[1].matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((entry) => JSON.parse(`"${entry[1]}"`))
    .includes(item);
}
