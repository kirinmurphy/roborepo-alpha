// Whether the github-agent-identity package is in the effective package set, so agent shells act on
// GitHub as the bot. Kept in its own module so the permission render and the `roborepo github`
// commands share one check without importing each other.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_IDENTITY_PACKAGE_ID } from "../../modules/forge/agent-identity.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { effectiveEnabledIds, readEnabledPackagesRegistry } from "./package-state.mjs";
import { enabledPackagesPath, stateDir } from "./state-paths.mjs";
import { resolveHarnessPath } from "../harnesses/paths.mjs";
import { listHarnessProviders } from "../harnesses/registry.mjs";
import { isProviderEnabled, readHarnessState } from "../harnesses/state.mjs";

// The Git settings file agent shells include so pushes go through the bot (credential helper, SSH
// rewritten to HTTPS), exactly as RoboRepo renders it into each harness's agent environment: the
// installed asset's absolute path under the state directory.
export const AGENT_GITCONFIG_INCLUDE = path.join(stateDir, "package-runtime", AGENT_IDENTITY_PACKAGE_ID, "gitconfig");
// How releases before the state directory was honored rendered the include. A harness config still
// carrying it names the same file only when the state directory is the default one; `roborepo
// update` re-renders it to the absolute path.
const HOME_RELATIVE_INCLUDE = "~/.roborepo/package-runtime/github-agent-identity/gitconfig";

// Whether an `include.path` value names the bot's Git settings file.
function namesAgentGitConfig(value) {
  if (value === AGENT_GITCONFIG_INCLUDE) return true;
  return value === HOME_RELATIVE_INCLUDE && path.join(os.homedir(), HOME_RELATIVE_INCLUDE.slice(2)) === AGENT_GITCONFIG_INCLUDE;
}

// The enabled harnesses whose live config exists but does not include the bot's Git settings, so
// their agents' `git push` still goes out with your credentials even though `gh` uses the bot. Each
// harness says where its agent shells' environment lives (its `agentShell` adapter); one without
// that group gets no RoboRepo-rendered shell environment and is not checked. A config that is
// missing or unreadable counts as a gap: its agents get no bot settings that this could confirm, and
// `roborepo update` writes it.
export function agentGitRoutingGaps({ providers = enabledAgentShellProviders(), read = readRootConfig } = {}) {
  const gaps = [];
  for (const provider of providers) {
    let includes = false;
    try {
      const text = read(provider);
      includes = includesAgentGitConfig((name) => provider.adapters.agentShell.envValue(text, name));
    } catch {}
    if (!includes) gaps.push(provider.manifest.displayName);
  }
  return gaps;
}

function enabledAgentShellProviders() {
  let state;
  try {
    state = readHarnessState();
  } catch {
    return [];
  }
  return listHarnessProviders().filter((provider) => provider.adapters.agentShell && isProviderEnabled(state, provider.id));
}

// Every harness that gives its agents a RoboRepo-rendered shell environment, enabled or not: a
// disabled harness's config can still be launched, and an unreadable harness state must not hide it.
function agentShellProviders() {
  return listHarnessProviders().filter((provider) => provider.adapters.agentShell);
}

const readRootConfig = (provider) => fs.readFileSync(resolveHarnessPath(provider.manifest, "rootConfig"), "utf8");

export function includesAgentGitConfig(env) {
  const count = Number.parseInt(env("GIT_CONFIG_COUNT") ?? "", 10);
  for (let i = 0; Number.isInteger(count) && i < count; i += 1) {
    if (env(`GIT_CONFIG_KEY_${i}`) === "include.path" && namesAgentGitConfig(env(`GIT_CONFIG_VALUE_${i}`))) return true;
  }
  return false;
}

// An unreadable package catalog reads as "not enabled", the safer rendering.
export function agentIdentityPackageEnabled() {
  try {
    return effectiveEnabledIds(loadPackageCatalog()).includes(AGENT_IDENTITY_PACKAGE_ID);
  } catch {
    return false;
  }
}

// Turns the package on through the normal package enable path, which re-renders Claude and Codex
// config. Enabling again re-applies every resource, which repairs one left missing when an earlier
// enable failed partway. `ok` only when the package came out fully enabled: a partial outcome (a
// setting the package could not claim, such as a GH_CONFIG_DIR you set yourself) would leave agents
// on the wrong identity. Callers check the bot account first; this does not.
export async function turnOnAgentIdentityPackage() {
  const { enablePackage, PackageMutationError } = await import("./packages.mjs");
  try {
    const result = await enablePackage([AGENT_IDENTITY_PACKAGE_ID]);
    const outcome = result.outcomes?.find((entry) => entry.id === AGENT_IDENTITY_PACKAGE_ID);
    if (!result.ok || outcome?.outcome !== "enabled") {
      return { ok: false, message: `The package did not install completely${outcome?.message ? `: ${outcome.message}` : ""}.` };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof PackageMutationError) return { ok: false, message: error.message };
    throw error;
  }
}

// Whether the package is selected and every resource it installs is actually in place. A package
// can be selected with a resource missing, for example after a copy failed partway through an
// enable, and setup then re-applies it rather than reporting it done. The probes load on demand
// because the permission render imports this module and must not pull them in.
export async function agentIdentityPackageInstalled() {
  try {
    const { buildPackageLiveState } = await import("./package-probes.mjs");
    const catalog = loadPackageCatalog();
    return buildPackageLiveState(catalog).get(AGENT_IDENTITY_PACKAGE_ID)?.status === "enabled";
  } catch {
    return false;
  }
}

// Whether the package is selected, or null when that cannot be read: a catalog that fails to load,
// or a selection file that exists but does not parse (the registry reader treats that as no file).
function readAgentIdentitySelection() {
  try {
    const registry = readEnabledPackagesRegistry();
    if (!registry.exists && fs.existsSync(enabledPackagesPath)) return null;
    return effectiveEnabledIds(loadPackageCatalog(), registry).includes(AGENT_IDENTITY_PACKAGE_ID);
  } catch {
    return null;
  }
}

// The harnesses whose agent-shell settings still point away from your own sign-in: the bot's Git
// include, or any GH_CONFIG_DIR (the package's, or one you set). Deselecting the package does not by
// itself prove those were removed. A config that does not exist carries nothing; one that exists but
// cannot be read is listed as unreadable, since nothing about it could be confirmed.
export function agentIdentityLeftovers({ providers = agentShellProviders(), read = readRootConfig } = {}) {
  const leftover = [];
  const unreadable = [];
  for (const provider of providers) {
    let text;
    try {
      text = read(provider);
    } catch (error) {
      if (error?.code !== "ENOENT") unreadable.push(provider.manifest.displayName);
      continue;
    }
    try {
      const env = (name) => provider.adapters.agentShell.envValue(text, name);
      // A token gh would use ahead of any stored login also leaves the account agents use unknown.
      const set = (name) => String(env(name) ?? "") !== "";
      if (includesAgentGitConfig(env) || set("GH_CONFIG_DIR") || set("GH_TOKEN") || set("GITHUB_TOKEN")) leftover.push(provider.manifest.displayName);
    } catch {
      unreadable.push(provider.manifest.displayName);
    }
  }
  return { leftover, unreadable };
}

// What the package leaves agents with, for messages that must not guess at an identity:
// - "on": selected and every resource in place.
// - "partial": selected with a resource missing.
// - "unknown": the selection, or a harness config that would say, could not be read.
// - "leftover": not selected, but a harness config still carries its settings (`harnesses`).
// - "off": not selected and no harness config carries its settings, the only state in which
//   agents verifiably act on GitHub as you.
export async function agentIdentityPackageState() {
  if (await agentIdentityPackageInstalled()) return { state: "on" };
  const selected = readAgentIdentitySelection();
  if (selected === null) return { state: "unknown" };
  if (selected) return { state: "partial" };
  const { leftover, unreadable } = agentIdentityLeftovers();
  if (unreadable.length > 0) return { state: "unknown" };
  if (leftover.length > 0) return { state: "leftover", harnesses: leftover };
  return { state: "off" };
}
