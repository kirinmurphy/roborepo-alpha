// Narrow query surface core consumers (CLI, portal, packages, install) use instead of importing
// the registry or state modules directly. Combines the static registry (what RoboRepo supports)
// with persisted state (what's enabled on this machine) into provider lookups scoped by
// enablement and harness capability.

import { listHarnessProviders, getHarnessProvider } from "./registry.mjs";
import { readHarnessState, isProviderEnabled } from "./state.mjs";

export function createHarnessRuntime({ state = readHarnessState() } = {}) {
  function enabledProviders() {
    return listHarnessProviders().filter((provider) => isProviderEnabled(state, provider.id));
  }

  // Repo inspection reads files a repo carries whether or not this machine runs that harness, so it
  // asks every supported provider, never only the enabled ones.
  function projectInventoryProviders() {
    return listHarnessProviders().map((provider) => ({
      provider,
      enabled: isProviderEnabled(state, provider.id),
      inventory: provider.adapters.projectInventory ?? null,
    }));
  }

  function providersFor(capability) {
    return enabledProviders().filter((provider) => provider.manifest.capabilities.includes(capability));
  }

  return Object.freeze({
    enabledProviders,
    projectInventoryProviders,
    providersFor,
    get: getHarnessProvider,
  });
}

export function requireHarnessCapability(provider, capability) {
  if (!provider.manifest.capabilities.includes(capability)) {
    throw new Error(`harness provider "${provider.id}" does not declare capability "${capability}"`);
  }
}
