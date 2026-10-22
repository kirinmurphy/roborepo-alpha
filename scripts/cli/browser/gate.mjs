// `roborepo browser` is a core namespace, because package `cli-command` resources can only wrap an
// external process and cannot register one. The feature still belongs to the feature-verification
// package, so every browser command checks that the package is effective before doing anything.

import { loadPackageCatalog } from "../package-catalog.mjs";
import { effectiveEnabledIds } from "../rules-render.mjs";

export const OWNING_PACKAGE = "feature-verification";

export function browserGateMessage() {
  if (effectiveEnabledIds(loadPackageCatalog()).includes(OWNING_PACKAGE)) return null;
  return `roborepo browser needs the ${OWNING_PACKAGE} package. Enable it with: roborepo package enable ${OWNING_PACKAGE}`;
}
