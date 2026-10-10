// Shared harness state mutations for CLI and portal adapters. Discovery evidence stays private to
// the harness domain; callers receive only the state/result they need to render their own view.
import { getHarnessProvider } from "./registry.mjs";
import { refreshHarnessState } from "./refresh.mjs";
import { readHarnessState, setProviderEnabled, writeHarnessState } from "./state.mjs";

export { refreshHarnessState };

export function setHarnessEnabled(providerId, enabled) {
  getHarnessProvider(providerId);
  const next = setProviderEnabled(readHarnessState(), providerId, enabled);
  writeHarnessState(next);
  return next;
}
