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
