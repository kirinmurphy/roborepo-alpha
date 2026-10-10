// Placeholder adapter methods for capabilities a provider declares but does not implement yet.
// They satisfy validateCapabilityAdapters()'s required-method shape check so the provider can be
// registered, while failing loudly (not silently no-opping) if anything calls them.

export function notYetMigrated(providerId, group, method) {
  return () => {
    throw new Error(
      `harness provider "${providerId}" adapter "${group}.${method}" is not implemented yet`
    );
  };
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
