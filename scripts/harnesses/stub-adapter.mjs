// Placeholder adapter methods for capabilities a provider declares but does not implement yet.
// They satisfy validateCapabilityAdapters()'s required-method shape check so the provider can be
// registered, while failing loudly (not silently no-opping) if anything calls them.

const STUB = Symbol("notYetMigrated");

export function notYetMigrated(providerId, group, method) {
  const stub = () => {
    throw new Error(
      `harness provider "${providerId}" adapter "${group}.${method}" is not implemented yet`
    );
  };
  stub[STUB] = true;
  return stub;
}

// Lets a caller skip a provider whose method is still a placeholder (for example hook readiness on
// a harness without hooks.read) instead of catching the error it would throw.
export function isStubAdapter(method) {
  return typeof method !== "function" || method[STUB] === true;
}

export function stubAdapterGroups(providerId, groups) {
  const adapters = {};
  for (const [group, methods] of Object.entries(groups)) {
    adapters[group] = {};
    for (const method of methods) {
      adapters[group][method] = notYetMigrated(providerId, group, method);
    }
  }
  return adapters;
}
