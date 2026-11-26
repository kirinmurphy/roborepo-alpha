// Whether the github-agent-identity package is in the effective package set, so agent shells act on
// GitHub as the bot. Kept in its own module so the permission render and the `roborepo github`
// commands share one check without importing each other.
import fs from "node:fs";
import { AGENT_IDENTITY_PACKAGE_ID } from "../../modules/forge/agent-identity.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { effectiveEnabledIds } from "./package-state.mjs";
import { resolveHarnessPath } from "../harnesses/paths.mjs";
import { listHarnessProviders } from "../harnesses/registry.mjs";
import { isProviderEnabled, readHarnessState } from "../harnesses/state.mjs";

// The Git settings file agent shells include so pushes go through the bot (credential helper, SSH
// rewritten to HTTPS), exactly as RoboRepo renders it into each harness's agent environment.
export const AGENT_GITCONFIG_INCLUDE = "~/.roborepo/package-runtime/github-agent-identity/gitconfig";

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

const readRootConfig = (provider) => fs.readFileSync(resolveHarnessPath(provider.manifest, "rootConfig"), "utf8");

export function includesAgentGitConfig(env) {
  const count = Number.parseInt(env("GIT_CONFIG_COUNT") ?? "", 10);
  for (let i = 0; Number.isInteger(count) && i < count; i += 1) {
    if (env(`GIT_CONFIG_KEY_${i}`) === "include.path" && env(`GIT_CONFIG_VALUE_${i}`) === AGENT_GITCONFIG_INCLUDE) return true;
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
