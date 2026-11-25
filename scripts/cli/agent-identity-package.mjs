// Whether the github-agent-identity package is in the effective package set, so agent shells act on
// GitHub as the bot. Kept in its own module so the permission render and the `roborepo github`
// commands share one check without importing each other.
import fs from "node:fs";
import { AGENT_IDENTITY_PACKAGE_ID } from "../../modules/forge/agent-identity.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { effectiveEnabledIds } from "./package-state.mjs";
import { rootConfigActive } from "./paths.mjs";

// The Git settings file agent shells include so pushes go through the bot (credential helper, SSH
// rewritten to HTTPS), exactly as RoboRepo renders it into each harness's agent environment.
export const AGENT_GITCONFIG_INCLUDE = "~/.roborepo/package-runtime/github-agent-identity/gitconfig";

// Harnesses whose agent shells get Git settings from RoboRepo, with how to find the pairs in each
// live config. Gemini has no agent shell environment RoboRepo renders, so it is not listed.
const GIT_ROUTED_HARNESSES = [
  { id: "claude", label: "Claude Code", pairs: (text) => JSON.parse(text)?.env || {} },
  { id: "codex", label: "Codex", pairs: tomlPairs },
];

// The harnesses whose live config exists but does not include the bot's Git settings, so their
// agents' `git push` still goes out with your credentials even though `gh` uses the bot. A config
// that is missing (harness not installed) or unreadable is skipped: this reports only what it saw.
export function agentGitRoutingGaps({ configs = rootConfigActive, read = (file) => fs.readFileSync(file, "utf8") } = {}) {
  const gaps = [];
  for (const harness of GIT_ROUTED_HARNESSES) {
    const file = configs[harness.id];
    if (!file) continue;
    let pairs;
    try {
      pairs = harness.pairs(read(file));
    } catch {
      continue;
    }
    if (!includesAgentGitConfig(pairs)) gaps.push(harness.label);
  }
  return gaps;
}

function includesAgentGitConfig(pairs) {
  const count = Number.parseInt(pairs.GIT_CONFIG_COUNT ?? "", 10);
  for (let i = 0; Number.isInteger(count) && i < count; i += 1) {
    if (pairs[`GIT_CONFIG_KEY_${i}`] === "include.path" && pairs[`GIT_CONFIG_VALUE_${i}`] === AGENT_GITCONFIG_INCLUDE) return true;
  }
  return false;
}

// The `KEY = "value"` lines of Codex's [shell_environment_policy.set] table. Only that flat table is
// read, so a full TOML parser is not needed.
function tomlPairs(text) {
  const pairs = {};
  let inTable = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inTable = line === "[shell_environment_policy.set]";
      continue;
    }
    const match = inTable && line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
    if (match) pairs[match[1]] = match[2];
  }
  return pairs;
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
