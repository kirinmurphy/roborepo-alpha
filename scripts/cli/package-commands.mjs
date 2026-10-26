import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { effectiveEnabledIds } from "./package-state.mjs";
import { requiredClosure } from "./package-graph.mjs";

function commandComponents(pkg) {
  return (pkg.components || []).filter((component) => component.type === "command");
}

function packageById(catalog) {
  return new Map(catalog.map((pkg) => [pkg.id, pkg]));
}

function commandDef(component, pkg) {
  return {
    packageId: pkg.id,
    packageLabel: pkg.label,
    name: component.name,
    mode: component.mode || "plain",
    commandOrUrl: component.commandOrUrl,
    args: [...(component.args || [])],
    fileSubcommand: component.fileSubcommand || "index-file",
    dirSubcommand: component.dirSubcommand || "index",
    watchSubcommand: component.watchSubcommand || "watch",
    extraArgs: [...(component.extraArgs || [])],
  };
}

function validateCommandComponent(pkg, component) {
  const errors = [];
  if (typeof component.name !== "string" || component.name.trim() === "") {
    errors.push(`${pkg.id}: command component missing name`);
  }
  if (typeof component.commandOrUrl !== "string" || component.commandOrUrl.trim() === "") {
    errors.push(`${pkg.id}:${component.name || "(unnamed)"} missing commandOrUrl`);
  }
  if (component.args !== undefined && !Array.isArray(component.args)) {
    errors.push(`${pkg.id}:${component.name || "(unnamed)"} args must be an array`);
  }
  if (component.extraArgs !== undefined && !Array.isArray(component.extraArgs)) {
    errors.push(`${pkg.id}:${component.name || "(unnamed)"} extraArgs must be an array`);
  }
  const mode = component.mode || "plain";
  if (!["plain", "index", "watch", "target"].includes(mode)) {
    errors.push(`${pkg.id}:${component.name || "(unnamed)"} unknown mode: ${mode}`);
  }
  if (mode === "index" && component.fileSubcommand !== undefined && typeof component.fileSubcommand !== "string") {
    errors.push(`${pkg.id}:${component.name || "(unnamed)"} fileSubcommand must be a string`);
  }
  if (mode === "index" && component.dirSubcommand !== undefined && typeof component.dirSubcommand !== "string") {
    errors.push(`${pkg.id}:${component.name || "(unnamed)"} dirSubcommand must be a string`);
  }
  if (mode === "watch" && component.watchSubcommand !== undefined && typeof component.watchSubcommand !== "string") {
    errors.push(`${pkg.id}:${component.name || "(unnamed)"} watchSubcommand must be a string`);
  }
  return errors;
}

export function validatePackageCommandCatalog({ catalog = loadPackageCatalog({ includeUnavailable: true }) } = {}) {
  const errors = [];
  for (const pkg of catalog) {
    for (const component of commandComponents(pkg)) {
      errors.push(...validateCommandComponent(pkg, component));
    }
    const ownership = validatePackageCommandOwnership(pkg, { catalog, enabledIds: [] });
    if (!ownership.ok) errors.push(ownership.message);
  }
  return { ok: errors.length === 0, errors };
}

export function listPackageCommands({ includeUnavailable = false } = {}) {
  const catalog = loadPackageCatalog({ includeUnavailable });
  return catalog.flatMap((pkg) => commandComponents(pkg).map((component) => commandDef(component, pkg)));
}

export function packageCommandNames(pkg) {
  const names = [
    ...(pkg.cliCommands || []),
    ...commandComponents(pkg).map((component) => component.name),
  ];
  return [...new Set(names)];
}

export function validatePackageCommandOwnership(pkg, { catalog = loadPackageCatalog({ includeUnavailable: true }), enabledIds = effectiveEnabledIds(catalog) } = {}) {
  const byId = packageById(catalog);
  // The package first, then what it requires, so a conflict names the package being enabled.
  const closure = requiredClosure(catalog, [pkg.id]).reverse().map((id) => byId.get(id));
  const closureIds = new Set(closure.map((item) => item.id));
  const claims = new Map();

  for (const item of closure) {
    for (const component of commandComponents(item)) {
      const owner = claims.get(component.name);
      if (owner && owner !== item.id) {
        return {
          ok: false,
          message: `command ${component.name} is claimed by multiple packages in the same enable set: ${owner}, ${item.id}`,
        };
      }
      claims.set(component.name, item.id);
    }
  }

  for (const [commandName, ownerId] of claims.entries()) {
    for (const item of catalog) {
      if (!enabledIds.includes(item.id) || closureIds.has(item.id)) continue;
      if (commandComponents(item).some((component) => component.name === commandName)) {
        return {
          ok: false,
          message: `command ${commandName} is already owned by enabled package ${item.id}; disable it before enabling ${ownerId}`,
        };
      }
    }
  }

  return { ok: true, message: null };
}

export function resolveEnabledCommand(commandName, { catalog = loadPackageCatalog({ includeUnavailable: true }) } = {}) {
  const enabledIds = new Set(effectiveEnabledIds(catalog));
  const matches = [];
  for (const pkg of catalog) {
    if (!enabledIds.has(pkg.id)) continue;
    for (const component of commandComponents(pkg)) {
      if (component.name === commandName) matches.push({ pkg, command: commandDef(component, pkg) });
    }
  }

  if (matches.length === 1) return { ok: true, ...matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      message: `command conflict: ${commandName} is owned by enabled packages ${matches.map((m) => m.pkg.id).join(", ")}`,
    };
  }

  const owners = listPackageCommands({ includeUnavailable: true }).filter((entry) => entry.name === commandName);
  if (owners.length === 0) {
    return { ok: false, message: `unknown command: ${commandName}` };
  }
  return {
    ok: false,
    message: `command ${commandName} is owned by ${owners.map((entry) => entry.packageId).join(", ")} but none of those packages are enabled. Enable ${owners[0].packageId} first.`,
  };
}

function resolveTarget(arg) {
  return arg ? path.resolve(process.cwd(), arg) : process.cwd();
}

export function runPackageCommand(commandName, rest, { beforeSpawn, afterSuccess } = {}) {
  const resolved = resolveEnabledCommand(commandName);
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exit(2);
  }

  const target = resolveTarget(rest[0]);
  if (beforeSpawn) beforeSpawn({ ...resolved, target });

  const command = resolved.command;
  const args = [...command.args];
  if (command.mode === "index") {
    const sub = fs.statSync(target).isFile() ? command.fileSubcommand : command.dirSubcommand;
    args.push(sub, ...command.extraArgs, target);
  } else if (command.mode === "watch") {
    args.push(command.watchSubcommand, target);
  } else {
    args.push(target);
  }

  const r = spawnSync(command.commandOrUrl, args, { stdio: "inherit" });
  const status = r.status ?? 1;
  if (status === 0 && afterSuccess) afterSuccess({ ...resolved, target });
  process.exit(status);
}
