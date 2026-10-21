// The providers `roborepo browser` can drive. A static map rather than a registry: Playwright is the
// one real provider, and the stub exists so the contract is tested against more than one
// implementation. Replacing Playwright means adding an entry here that returns the same shapes.

import { playwrightProvider } from "./playwright-provider.mjs";
import { STUB_ENV, stubEnabled, stubProvider } from "./stub-provider.mjs";

export const DEFAULT_PROVIDER = "playwright";

const PROVIDERS = { playwright: playwrightProvider, stub: stubProvider };

// Returns { provider } or { error } for the CLI to report as a usage problem.
export function selectProvider(id = DEFAULT_PROVIDER) {
  if (id === "stub" && !stubEnabled()) return { error: `the stub provider is for contract tests only (set ${STUB_ENV}=1)` };
  const provider = PROVIDERS[id];
  if (!provider) return { error: `unknown provider: ${id} (available: ${DEFAULT_PROVIDER})` };
  return { provider };
}
