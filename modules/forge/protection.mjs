// Branch protection for one repo, through its provider's `branch-protection` capability. A repo on
// a host no provider protects resolves to an `unsupported` report naming the manual steps, so
// `roborepo protect`, doctor, setup, and the portal report it instead of failing.
import { UNSUPPORTED_PROTECTION_HEADLINE, emptyProtectionReport } from "./protection-report.mjs";
import { capabilityHostNames, providerForRepositoryId, providersWithCapability } from "./registry.mjs";
import { hasForgeCapability } from "./contract.mjs";

// States whose exit code is 0: the branches are protected, whoever owns the rulesets.
export const PROTECTED_STATES = new Set(["protected", "unmanaged"]);

// `target` is `{ repositoryId, cwd, timeoutMs, env }`; `providers` replaces the shipped list (tests).
// Always resolves to a report.
export async function readProtection(target, { providers } = {}) {
  const resolved = resolve(target, providers);
  return resolved.report ?? resolved.adapter.readProtection(target);
}

// Runs one action (`protect`, `skip`, or `unskip`); see the provider's applyProtection.
export async function applyProtection(target, options = {}) {
  const resolved = resolve(target, options.providers);
  if (resolved.report) {
    const action = options.action ?? "protect";
    if (!["protect", "skip", "unskip"].includes(action)) throw new Error(`Unknown protection action: ${JSON.stringify(action)}`);
    return { before: resolved.report, changes: [], refusal: "nothing was changed while the state is unsupported", report: resolved.report };
  }
  return resolved.adapter.applyProtection(target, options);
}

function resolve(target, providers) {
  const options = providers ? { providers } : {};
  const found = providerForRepositoryId(target?.repositoryId, options);
  const names = capabilityHostNames("branch-protection", options);
  if (!found) return { report: unsupported(null, `this repo has no ${names} remote`, options) };
  if (!hasForgeCapability(found.provider, "branch-protection")) return { report: unsupported(found.repo, `${found.host} is not ${names}`, options) };
  return { adapter: found.provider.adapters.branchProtection };
}

// The steps a person takes by hand, from every provider that can protect a repo.
function unsupported(repo, reason, options) {
  const manualSteps = providersWithCapability("branch-protection", options).flatMap((provider) => provider.adapters.branchProtection.manualSteps);
  return { ...emptyProtectionReport({ repo, state: "unsupported", headline: UNSUPPORTED_PROTECTION_HEADLINE }), reason, manualSteps };
}
