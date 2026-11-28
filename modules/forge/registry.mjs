// Trusted static forge-provider registry: the Git hosts RoboRepo has an adapter for. Code outside a
// provider asks here for "the provider for this repo" and checks the capability it needs, instead of
// naming a host. Every lookup takes an optional `providers` list (default: the shipped ones), so a
// test can pass a fake provider without it ever shipping. See contract.mjs for the capabilities.
import { hasForgeCapability } from "./contract.mjs";
import { forgeTargetForRepositoryId } from "./repository-id.mjs";
import { githubProvider } from "./providers/github/index.mjs";

const SHIPPED = Object.freeze([githubProvider]);

export function listForgeProviders({ providers = SHIPPED } = {}) {
  return [...providers];
}

export function forgeProviderById(id, { providers = SHIPPED } = {}) {
  return providers.find((provider) => provider.id === id) ?? null;
}

export function providerForHost(host, { providers = SHIPPED } = {}) {
  const wanted = String(host || "").toLowerCase();
  return providers.find((provider) => provider.manifest.hosts.includes(wanted)) ?? null;
}

// `{ provider, host, repo }` for a repo on a known host; `provider` is null for a host no provider
// serves, and the whole result is null for an id that names no host (a `local:` repo).
export function providerForRepositoryId(repositoryId, { providers = SHIPPED } = {}) {
  const target = forgeTargetForRepositoryId(repositoryId);
  if (!target) return null;
  return { ...target, provider: providerForHost(target.host, { providers }) };
}

// The providers that implement one capability, in registry order.
export function providersWithCapability(capability, { providers = SHIPPED } = {}) {
  return providers.filter((provider) => hasForgeCapability(provider, capability));
}

// Names for messages about the hosts that offer a capability: "GitHub", or "GitHub or GitLab".
export function capabilityHostNames(capability, { providers = SHIPPED } = {}) {
  return providersWithCapability(capability, { providers }).map((provider) => provider.manifest.displayName).join(" or ");
}

// The provider that owns a parsed remote URL, with what it parsed: `{ provider, host, repo }`.
export function providerForRemoteUrl(url, { providers = SHIPPED } = {}) {
  for (const provider of providersWithCapability("repository", { providers })) {
    const parsed = provider.adapters.repository.parseRemote(url);
    if (parsed) return { provider, ...parsed };
  }
  return null;
}
