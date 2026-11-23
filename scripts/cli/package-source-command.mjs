// Terminal front end for package sources and the install lifecycle. Every decision lives in
// package-service.mjs; this module parses arguments, asks for confirmation on a terminal, prints,
// and turns a refusal into its exit code.
import { PackageServiceError, addSource, installPackage, listSources, packageView, previewInstall, refreshSources, removePackage, removeSource, setSourceEnabled, sourceInfo, trustedCatalog, updatePackage } from "./package-service.mjs";
import { formatContentsSummary } from "./package-source-git.mjs";
import { confirmYesNo, makePrompter } from "./prompts.mjs";

function parse(rest) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      if (value !== undefined) flags.set(key, value);
      else if (key === "id" && rest[i + 1] && !rest[i + 1].startsWith("--")) flags.set(key, rest[++i]);
      else flags.set(key, true);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// With --json, stdout carries only the JSON result: progress that the lifecycle prints while
// applying or removing a package goes to stderr.
async function run(action, flags) {
  const log = console.log;
  if (flags?.has("json")) console.log = console.error;
  try {
    await action();
  } catch (err) {
    if (!(err instanceof PackageServiceError)) throw err;
    console.error(err.message);
    process.exit(err.exitCode);
  } finally {
    console.log = log;
  }
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function interactive(flags) {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !flags.has("json");
}

async function confirm(question) {
  const prompter = makePrompter();
  try {
    return await confirmYesNo(prompter, question, false);
  } finally {
    prompter.close();
  }
}

const short = (sha) => (sha ? sha.slice(0, 12) : "-");

// ---------------------------------------------------------------------------------------------
// roborepo package source <list|add|remove|enable|disable|refresh|info|trusted>

export function packageSourceCommand(args = []) {
  const [sub, ...rest] = args;
  const { flags, positional } = parse(rest);
  const json = flags.has("json");
  return run(async () => {
    switch (sub) {
      case "list":
      case undefined: {
        const sources = listSources();
        if (json) return emitJson(sources);
        for (const source of sources) {
          const state = source.enabled ? "" : " (disabled)";
          const revision = source.revision ? ` @ ${short(source.revision)}` : "";
          console.log(`${source.id.padEnd(16)} ${source.tabLabel.padEnd(11)} ${source.trust.padEnd(10)} ${source.available} available, ${source.installed.length} installed${revision}${state}`);
          console.log(`${"".padEnd(16)} ${source.location}`);
        }
        return;
      }
      case "add": {
        const result = addSource({ location: positional[0], id: flags.get("id") || null });
        if (json) return emitJson(result);
        console.log(`added package source ${result.source.id} (${result.source.trust}): ${result.packages.length} package(s) available`);
        for (const id of result.packages) console.log(`  ${result.source.id}/${id}`);
        for (const collision of result.collisions || []) console.log(`warn: ${collision.candidates.join(" and ")} share a name; choose one with \`roborepo package install <source>/${collision.id}\``);
        if (result.source.trust === "unverified") console.log("This repository is not in RoboRepo's trusted catalog. Review each package's contents before installing it.");
        if (result.packages.length) console.log(`next: roborepo package install ${result.source.id}/${result.packages[0]}`);
        return;
      }
      case "remove": {
        const result = removeSource(positional[0], { keepInstalled: flags.has("keep-installed") });
        if (json) return emitJson(result);
        console.log(`removed package source ${result.removed}`);
        if (result.keptInstalled.length) console.log(`still installed without a source: ${result.keptInstalled.join(", ")}`);
        return;
      }
      case "enable":
      case "disable": {
        const result = setSourceEnabled(positional[0], sub === "enable");
        if (json) return emitJson(result);
        console.log(`package source ${result.id} ${sub}d`);
        return;
      }
      case "refresh": {
        const results = refreshSources(positional[0] || null);
        if (json) return emitJson(results);
        if (results.length === 0) console.log("no git package sources to refresh");
        for (const result of results) {
          if (result.live) console.log(`${result.id}: read from disk on every use; nothing to refresh`);
          else if (result.error) console.log(`${result.id}: refresh failed (${result.error}); keeping the listing at ${short(result.revision)}`);
          else console.log(`${result.id}: ${result.changed ? `now at ${short(result.revision)}` : `up to date at ${short(result.revision)}`} (${result.packages.length} package(s))`);
        }
        if (results.some((result) => result.error)) process.exitCode = 5;
        return;
      }
      case "info": {
        const info = sourceInfo(positional[0]);
        if (json) return emitJson(info);
        for (const [key, value] of Object.entries(info)) {
          if (value === null || (Array.isArray(value) && value.length === 0)) continue;
          console.log(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
        }
        return;
      }
      case "trusted": {
        const entries = trustedCatalog();
        if (json) return emitJson(entries);
        if (entries.length === 0) console.log("the trusted catalog is empty");
        for (const entry of entries) console.log(`${entry.display.padEnd(32)} ${entry.addedAs ? `added as ${entry.addedAs}` : `roborepo package source add ${entry.repo}`}\n  ${entry.description}`);
        return;
      }
      default:
        throw new PackageServiceError("usage: roborepo package source list|add|remove|enable|disable|refresh|info|trusted", { code: "usage" });
    }
  }, flags);
}

// ---------------------------------------------------------------------------------------------
// roborepo package install|update|remove

export function packageInstallCommand(rest = []) {
  const { flags, positional } = parse(rest);
  return run(async () => {
    const [reference] = positional;
    if (!reference) throw new PackageServiceError("usage: roborepo package install <package|source/package> [--yes]", { code: "usage" });
    const preview = previewInstall(reference);
    // Every remote package the install brings, dependencies included, is shown before any prompt.
    for (const entry of preview.packages.filter((item) => item.sourceType === "git")) {
      console.log(`${entry.qualifiedName} (${entry.trust}) at ${short(entry.revision)} contains:`);
      for (const line of formatContentsSummary(entry.contents)) console.log(line);
    }
    let confirmed = flags.has("yes");
    if (preview.needsConfirmation && !confirmed && interactive(flags)) {
      const unverified = preview.packages.filter((item) => item.trust === "unverified").map((item) => item.qualifiedName);
      confirmed = await confirm(`Install ${unverified.join(", ")} from an unverified source?`);
      if (!confirmed) {
        console.log("not installed");
        return;
      }
    }
    const result = installPackage(reference, { confirmed });
    if (flags.has("json")) return emitJson(result);
    for (const item of result.installed) {
      const where = item.kind === "live" ? `in place at ${item.path}` : `at ${short(item.revision)}`;
      console.log(`${item.changed ? "installed" : "already installed"}: ${item.qualifiedName} ${where}`);
      if (item.newerRevision) console.log(`  a newer revision ${short(item.newerRevision)} is available: roborepo package update ${item.qualifiedName.split("/").pop()}`);
    }
    console.log(`next: roborepo package enable ${preview.packageId}`);
  }, flags);
}

export function packageUpdateCommand(rest = []) {
  const { flags, positional } = parse(rest);
  return run(async () => {
    const [reference] = positional;
    if (!reference) throw new PackageServiceError("usage: roborepo package update <package> [--yes]", { code: "usage" });
    const { reapplyPackage } = await import("./packages.mjs");
    let result;
    try {
      result = await updatePackage(reference, { confirmed: flags.has("yes"), reapply: reapplyPackage });
    } catch (err) {
      if (!(err instanceof PackageServiceError) || err.code !== "confirmationRequired") throw err;
      const change = err.details.change;
      printChange(change);
      if (!interactive(flags) || !(await confirm(`Move ${change.qualifiedName} to ${short(change.to)}?`))) throw err;
      result = await updatePackage(reference, { confirmed: true, reapply: reapplyPackage });
    }
    if (flags.has("json")) return emitJson(result);
    if (result.live) console.log(`${result.qualifiedName}: ${result.message}`);
    else if (!result.changed) console.log(`${result.qualifiedName}: up to date at ${short(result.revision)}`);
    else console.log(`updated ${result.qualifiedName}: ${short(result.from)} -> ${short(result.to)}${result.reapplied ? " (re-applied)" : ""}`);
  }, flags);
}

function printChange(change) {
  console.log(`${change.qualifiedName}: ${short(change.from)} -> ${short(change.to)}`);
  for (const [label, files] of Object.entries(change.files)) {
    if (files.length) console.log(`  ${label}: ${files.join(", ")}`);
  }
  for (const line of formatContentsSummary(change.contents)) console.log(line);
}

export function packageRemoveCommand(rest = []) {
  const { flags, positional } = parse(rest);
  return run(async () => {
    const [reference] = positional;
    if (!reference) throw new PackageServiceError("usage: roborepo package remove <package>", { code: "usage" });
    const { disablePackage } = await import("./packages.mjs");
    const result = await removePackage(reference, { disable: (id) => disablePackage([id]) });
    if (flags.has("json")) return emitJson(result);
    if (!result.removed) console.log(`${result.qualifiedName}: ${result.message || "nothing to remove"}`);
    else console.log(`removed ${result.qualifiedName}${result.disabled ? " (disabled first)" : ""}${result.deletedCopy ? "; deleted its installed copy" : ""}`);
  }, flags);
}
