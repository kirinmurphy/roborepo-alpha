// Claude's package-resource adapters: the permissions, marketplace plugins, and plugin folders a
// package can own in ~/.claude/settings.json. The package system hands each method an io object
// ({ configPath, write }) and never reads or writes Claude settings itself; write persists text
// through the package system's tracked root-config write.

import fs from "node:fs";
import path from "node:path";

// A Claude plugin folder is registered through CLAUDE_CODE_PLUGIN_DIRS because it is the one route
// that loads a plugin's hooks module from a folder without a marketplace install.
const PLUGIN_DIRS_ENV = "CLAUDE_CODE_PLUGIN_DIRS";
const PLUGIN_MANIFEST = path.join(".claude-plugin", "plugin.json");

function readSettings(configPath) {
  try { return JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { return {}; }
}

function writeSettings(io, settings) {
  io.write(`${JSON.stringify(settings, null, 2)}\n`);
}

// --- permissions ------------------------------------------------------------------------------

function mergePermissions(allow, io) {
  const settings = readSettings(io.configPath);
  const existing = settings.permissions?.allow || [];
  const toAdd = allow.filter((entry) => !existing.includes(entry));
  if (toAdd.length === 0) { console.log("ok: permissions already present"); return; }
  settings.permissions = { ...settings.permissions, allow: [...existing, ...toAdd] };
  writeSettings(io, settings);
  console.log(`wired: ${toAdd.length} permissions → ${io.configPath}`);
}

function unmergePermissions(allow, io) {
  const settings = readSettings(io.configPath);
  const existing = settings.permissions?.allow || [];
  const owned = new Set(allow);
  const next = existing.filter((entry) => !owned.has(entry));
  if (next.length === existing.length) { console.log("ok: permissions already absent"); return; }
  settings.permissions = { ...settings.permissions, allow: next };
  writeSettings(io, settings);
  console.log(`removed: ${existing.length - next.length} permissions ← ${io.configPath}`);
}

function probePermissions(allow, { configPath }) {
  const present = readSettings(configPath).permissions?.allow || [];
  const missing = allow.filter((entry) => !present.includes(entry));
  return {
    observed: missing.length === 0,
    detail: missing.length ? `${missing.length} permission(s) missing` : `${allow.length} permission(s) present`,
  };
}

// --- marketplace plugins ----------------------------------------------------------------------
//
// A plugin resource owns two settings keys: extraKnownMarketplaces[<marketplace.name>] (so Claude
// knows where to fetch it) and enabledPlugins[<id>]. Enable writes both and Claude downloads the
// plugin on its next launch; disable removes both and leaves downloaded files to Claude.

function enablePlugin(resource, io) {
  const settings = readSettings(io.configPath);
  let changed = false;
  if (resource.marketplace?.name) {
    settings.extraKnownMarketplaces ||= {};
    if (!settings.extraKnownMarketplaces[resource.marketplace.name]) {
      settings.extraKnownMarketplaces[resource.marketplace.name] = { source: resource.marketplace.source };
      changed = true;
    }
  }
  settings.enabledPlugins ||= {};
  if (settings.enabledPlugins[resource.id] !== true) {
    settings.enabledPlugins[resource.id] = true;
    changed = true;
  }
  if (!changed) { console.log(`  ok: plugin ${resource.id} already enabled`); return; }
  writeSettings(io, settings);
  console.log(`  plugin enabled: ${resource.id} → ${io.configPath}`);
  console.log("  note: the harness installs the plugin from the marketplace on its next launch");
}

function disablePlugin(resource, io) {
  const settings = readSettings(io.configPath);
  let changed = false;
  if (settings.enabledPlugins && resource.id in settings.enabledPlugins) {
    delete settings.enabledPlugins[resource.id];
    changed = true;
  }
  if (resource.marketplace?.name && settings.extraKnownMarketplaces?.[resource.marketplace.name]) {
    delete settings.extraKnownMarketplaces[resource.marketplace.name];
    changed = true;
  }
  if (!changed) { console.log(`  ok: plugin ${resource.id} already absent`); return; }
  writeSettings(io, settings);
  console.log(`  plugin disabled: ${resource.id} ← ${io.configPath}`);
}

function probePlugin(resource, { configPath }) {
  const observed = readSettings(configPath).enabledPlugins?.[resource.id] === true;
  return { observed, detail: observed ? "enabled in Claude settings" : "not enabled in Claude settings" };
}

// --- plugin folders ---------------------------------------------------------------------------
//
// The package system copies the folder to its install path; Claude owns what makes it a plugin
// (the manifest) and how it is loaded (the plugin-dirs list in settings env).

function pluginDirList(settings) {
  const value = settings.env?.[PLUGIN_DIRS_ENV];
  return typeof value === "string" ? value.split(path.delimiter).filter(Boolean) : [];
}

function validatePluginDir(sourcePath) {
  if (!fs.existsSync(path.join(sourcePath, PLUGIN_MANIFEST))) {
    throw new Error(`plugin-dir source has no ${PLUGIN_MANIFEST}`);
  }
}

function registerPluginDir(destPath, io) {
  const settings = readSettings(io.configPath);
  const dirs = pluginDirList(settings);
  if (!dirs.includes(destPath)) {
    settings.env = { ...settings.env, [PLUGIN_DIRS_ENV]: [...dirs, destPath].join(path.delimiter) };
    writeSettings(io, settings);
  }
  console.log(`  Claude plugin folder: ${destPath}`);
}

function unregisterPluginDir(destPath, io) {
  const settings = readSettings(io.configPath);
  const dirs = pluginDirList(settings);
  if (dirs.includes(destPath)) {
    const remaining = dirs.filter((dir) => dir !== destPath);
    if (remaining.length) settings.env[PLUGIN_DIRS_ENV] = remaining.join(path.delimiter);
    else delete settings.env[PLUGIN_DIRS_ENV];
    if (Object.keys(settings.env).length === 0) delete settings.env;
    writeSettings(io, settings);
  }
  console.log(`  removed Claude plugin folder: ${destPath}`);
}

function probePluginDir(destPath, { configPath }) {
  const installed = fs.existsSync(path.join(destPath, PLUGIN_MANIFEST));
  const registered = pluginDirList(readSettings(configPath)).includes(destPath);
  return {
    observed: installed && registered,
    detail: installed && registered
      ? `Claude plugin folder registered: ${destPath}`
      : !installed ? `Claude plugin folder missing: ${destPath}` : `Claude plugin folder not registered: ${destPath}`,
  };
}

export const claudePackageAdapters = {
  mergePermissions,
  unmergePermissions,
  probePermissions,
  enablePlugin,
  disablePlugin,
  probePlugin,
  validatePluginDir,
  registerPluginDir,
  unregisterPluginDir,
  probePluginDir,
};
