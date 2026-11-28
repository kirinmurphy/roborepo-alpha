// Entry point for Git host calls. `forgeClient(host)` returns the raw client of the provider that
// serves the host, or `{ supported: false }` so callers report an unsupported host instead of
// failing. New code asks the registry for the repo's provider and the capability it needs.
import { providerForHost } from "./registry.mjs";

export function forgeClient(host, options) {
  return providerForHost(host, options)?.client ?? { host: host || null, supported: false };
}

export { forgeTargetForRepositoryId } from "./repository-id.mjs";
export { ForgeError } from "./errors.mjs";
export {
  capabilityHostNames, forgeProviderById, listForgeProviders, providerForHost, providerForRemoteUrl, providerForRepositoryId, providersWithCapability,
} from "./registry.mjs";
export { hasForgeCapability } from "./contract.mjs";
