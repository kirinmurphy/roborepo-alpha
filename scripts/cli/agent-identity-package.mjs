// Whether the github-agent-identity package is in the effective package set, so agent shells act on
// GitHub as the bot. Kept in its own module so the permission render and the `roborepo github`
// commands share one check without importing each other.
import { AGENT_IDENTITY_PACKAGE_ID } from "../../modules/forge/agent-identity.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { effectiveEnabledIds } from "./package-state.mjs";

// An unreadable package catalog reads as "not enabled", the safer rendering.
export function agentIdentityPackageEnabled() {
  try {
    return effectiveEnabledIds(loadPackageCatalog()).includes(AGENT_IDENTITY_PACKAGE_ID);
  } catch {
    return false;
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
