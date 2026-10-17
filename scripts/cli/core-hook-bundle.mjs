// Which optional bundle installs a harness's core hooks, and whether the user selected it. Hook
// readiness asks this on every status read, so it reads the two manifests and the preset state
// directly instead of loading the bundle-apply module and everything it imports.

import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mjs";
import { presetsStatePath, readJsonState } from "./state-paths.mjs";

const PRESET_MANIFEST = path.join(repoRoot, "manifests", "platform", "presets.json");
const INSTALL_MANIFEST = path.join(repoRoot, "manifests", "platform", "manifest.tsv");

// Null when the harness's core hooks arrive another way: Claude's ride in its root config, which
// every install applies.
export function coreHookBundle(harness) {
  const key = hookFragmentRowKey(harness);
  if (!key) return null;
  const bundles = JSON.parse(fs.readFileSync(PRESET_MANIFEST, "utf8")).bundles ?? [];
  const bundle = bundles.find((entry) => (entry.rows ?? []).includes(key));
  if (!bundle) return null;
  return { id: bundle.id, selected: (readJsonState(presetsStatePath, {}).selected ?? []).includes(bundle.id) };
}

// The `<harness>:<home_sub>` key presets.json uses for the harness's hook_fragment row.
function hookFragmentRowKey(harness) {
  for (const line of fs.readFileSync(INSTALL_MANIFEST, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [rowHarness, kind, , homeSub] = line.split("\t");
    if (rowHarness === harness && kind === "hook_fragment") return `${rowHarness}:${homeSub}`;
  }
  return null;
}
