// Whether a forge provider's agent identity package (github-agent-identity for GitHub) is in the
// effective package set, so agent shells act on that provider as its bot. Kept in its own module so
// the permission render and the provider commands share one check without importing each other.
// Every function takes the forge provider it asks about; the package id, Git settings path, and CLI
// variables come from that provider's manifest.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listOr } from "../../modules/forge/agent-identity-findings.mjs";
import { providersWithCapability } from "../../modules/forge/registry.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { effectiveEnabledIds, readEnabledPackagesRegistry } from "./package-state.mjs";
import { enabledPackagesPath, stateDir } from "./state-paths.mjs";
import { resolveHarnessPath } from "../harnesses/paths.mjs";
import { listHarnessProviders } from "../harnesses/registry.mjs";
import { isProviderEnabled, readHarnessState } from "../harnesses/state.mjs";

// The forge providers that have an agent account. `providers` replaces the shipped list (tests).
export const agentIdentityProviders = ({ providers } = {}) => providersWithCapability("agent-identity", providers ? { providers } : {});

const packageIdOf = (forgeProvider) => forgeProvider.manifest.agent.packageId;

// The Git settings file agent shells include so pushes go through the bot (credential helper, SSH
// rewritten to HTTPS), exactly as RoboRepo renders it into each harness's agent environment: the
// installed asset's absolute path under the state directory.
export const agentGitconfigInclude = (forgeProvider) => path.join(stateDir, "package-runtime", packageIdOf(forgeProvider), "gitconfig");
// How releases before the state directory was honored rendered the include. A harness config still
// carrying it names the same file only when the state directory is the default one; `roborepo
// update` re-renders it to the absolute path.
const homeRelativeInclude = (forgeProvider) => `~/.roborepo/package-runtime/${packageIdOf(forgeProvider)}/gitconfig`;

// The variables the package sets (the CLI's config folder) and clears (tokens that would outrank it).
export const packageIdentityVariables = (forgeProvider) => [forgeProvider.manifest.cli.configDirVariable, ...forgeProvider.manifest.cli.tokenVariables];
// "GH_CONFIG_DIR, GH_TOKEN, or GITHUB_TOKEN", for messages.
export const packageIdentityVariablesText = (forgeProvider) => listOr(packageIdentityVariables(forgeProvider));

// Whether an `include.path` value names the bot's Git settings file.
function namesAgentGitConfig(value, forgeProvider) {
  const include = agentGitconfigInclude(forgeProvider);
  if (value === include) return true;
  const legacy = homeRelativeInclude(forgeProvider);
  return value === legacy && path.join(os.homedir(), legacy.slice(2)) === include;
}

// The enabled harnesses whose live config exists but does not include the bot's Git settings, so
// their agents' `git push` still goes out with your credentials even though the CLI uses the bot.
// Each harness says where its agent shells' environment lives (its `agentShell` adapter); one
// without that group gets no RoboRepo-rendered shell environment and is not checked. A config that
// is missing or unreadable counts as a gap: its agents get no bot settings that this could confirm,
// and `roborepo update` writes it.
export function agentGitRoutingGaps(forgeProvider, { providers = enabledAgentShellProviders(), read = readRootConfig } = {}) {
  const gaps = [];
  for (const provider of providers) {
    let includes = false;
    try {
      const text = read(provider);
      includes = includesAgentGitConfig((name) => provider.adapters.agentShell.envValue(text, name), forgeProvider);
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

export function includesAgentGitConfig(env, forgeProvider) {
  const count = Number.parseInt(env("GIT_CONFIG_COUNT") ?? "", 10);
  for (let i = 0; Number.isInteger(count) && i < count; i += 1) {
    if (env(`GIT_CONFIG_KEY_${i}`) === "include.path" && namesAgentGitConfig(env(`GIT_CONFIG_VALUE_${i}`), forgeProvider)) return true;
  }
  return false;
}

// The forge providers whose agent identity package is in the effective package set, by id. This is
// what decides each provider's permission buckets and network access. An unreadable package
// catalog reads as none enabled, the safer rendering.
export function enabledAgentIdentityProviderIds({ providers } = {}) {
  const candidates = agentIdentityProviders({ providers });
  try {
    const enabled = new Set(effectiveEnabledIds(loadPackageCatalog()));
    return candidates.filter((forgeProvider) => enabled.has(packageIdOf(forgeProvider))).map((forgeProvider) => forgeProvider.id);
  } catch {
    return [];
  }
}

export const agentIdentityPackageEnabled = (forgeProvider) => enabledAgentIdentityProviderIds({ providers: [forgeProvider] }).includes(forgeProvider.id);

// Turns the package on through the normal package enable path, which re-renders Claude and Codex
// config. Enabling again re-applies every resource, which repairs one left missing when an earlier
// enable failed partway. `ok` only when the package came out fully enabled: a partial outcome (a
// setting the package could not claim, such as a GH_CONFIG_DIR you set yourself) would leave agents
// on the wrong identity. Callers check the bot account first; this does not.
export async function turnOnAgentIdentityPackage(forgeProvider) {
  const packageId = packageIdOf(forgeProvider);
  const { enablePackage, PackageMutationError } = await import("./packages.mjs");
  try {
    const result = await enablePackage([packageId]);
    const outcome = result.outcomes?.find((entry) => entry.id === packageId);
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
export async function agentIdentityPackageInstalled(forgeProvider) {
  try {
    const { buildPackageLiveState } = await import("./package-probes.mjs");
    const catalog = loadPackageCatalog();
    return buildPackageLiveState(catalog).get(packageIdOf(forgeProvider))?.status === "enabled";
  } catch {
    return false;
  }
}

// Whether the package is selected, or null when that cannot be read: a catalog that fails to load,
// or a selection file that exists but does not parse (the registry reader treats that as no file).
function readAgentIdentitySelection(forgeProvider) {
  try {
    const registry = readEnabledPackagesRegistry();
    if (!registry.exists && fs.existsSync(enabledPackagesPath)) return null;
    return effectiveEnabledIds(loadPackageCatalog(), registry).includes(packageIdOf(forgeProvider));
  } catch {
    return null;
  }
}

// The harnesses whose agent-shell settings still point away from your own sign-in: the bot's Git
// include, or any of the CLI's config folder or token variables (the package's, or one you set).
// Deselecting the package does not by itself prove those were removed. A config that does not exist
// carries nothing; one that exists but cannot be read is listed as unreadable, since nothing about
// it could be confirmed.
export function agentIdentityLeftovers(forgeProvider, { providers = agentShellProviders(), read = readRootConfig } = {}) {
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
      // A token the CLI would use ahead of any stored login also leaves the account agents use unknown.
      const set = (name) => String(env(name) ?? "") !== "";
      if (includesAgentGitConfig(env, forgeProvider) || packageIdentityVariables(forgeProvider).some(set)) leftover.push(provider.manifest.displayName);
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
//   agents verifiably act on the provider as you.
export async function agentIdentityPackageState(forgeProvider) {
  if (await agentIdentityPackageInstalled(forgeProvider)) return { state: "on" };
  const selected = readAgentIdentitySelection(forgeProvider);
  if (selected === null) return { state: "unknown" };
  if (selected) return { state: "partial" };
  const { leftover, unreadable } = agentIdentityLeftovers(forgeProvider);
  if (unreadable.length > 0) return { state: "unknown" };
  if (leftover.length > 0) return { state: "leftover", harnesses: leftover };
  return { state: "off" };
}
