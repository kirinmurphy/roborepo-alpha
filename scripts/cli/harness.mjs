// `roborepo harness ...` command implementations. Thin CLI layer over
// scripts/harnesses/{registry,discovery,state,harness-runtime}.mjs — this module owns argument parsing
// and console output only; harness provider logic stays in scripts/harnesses/.

import { listHarnessProviders, getHarnessProvider, hasHarnessProvider } from "../harnesses/registry.mjs";
import { refreshHarnessState, setHarnessEnabled } from "../harnesses/service.mjs";
import { readHarnessState } from "../harnesses/state.mjs";
import { resolveHarnessPath, hasHarnessPath } from "../harnesses/paths.mjs";
import fs from "node:fs";

function requireProviderId(rest, label) {
  const id = rest[0];
  if (!id) {
    console.error(`usage: roborepo harness ${label} <id>`);
    process.exit(2);
  }
  if (!hasHarnessProvider(id)) {
    const known = listHarnessProviders().map((p) => p.id).join(", ");
    console.error(`unknown harness: ${id}. Known harnesses: ${known}`);
    process.exit(2);
  }
  return id;
}

export function harnessList() {
  const state = readHarnessState();
  for (const provider of listHarnessProviders()) {
    const entry = state.providers[provider.id];
    const status = entry?.enabled ? "enabled" : "disabled";
    const confidence = entry?.confidence ?? "absent";
    console.log(`${provider.id}\t${provider.manifest.displayName}\t${status}\t${confidence}`);
  }
}

export function harnessInspect(rest) {
  const id = requireProviderId(rest, "inspect");
  const provider = getHarnessProvider(id);
  const state = readHarnessState();
  console.log(JSON.stringify({ manifest: provider.manifest, state: state.providers[id] ?? null }, null, 2));
}

export function harnessRefresh() {
  refreshHarnessState();
  harnessList();
}

export function harnessEnable(rest) {
  const id = requireProviderId(rest, "enable");
  setHarnessEnabled(id, true);
  console.log(`enabled: ${id}`);
}

export function harnessDisable(rest) {
  const id = requireProviderId(rest, "disable");
  setHarnessEnabled(id, false);
  console.log(`disabled: ${id}`);
}

// Live filesystem discovery, independent of ~/.roborepo/harnesses/state.json — install/uninstall/
// repair/doctor need to know which harnesses are present before any state file exists (a fresh
// install has none yet), so this must not depend on readHarnessState(). This is the row source
// shell installers consume instead of re-implementing provider presence checks
// (manifests/platform/harnesses.tsv's harness_present) or the provider manifest schema themselves.
//
// "present" here is deliberately narrower than discovery's "detected" (which also counts an
// executable on PATH with no home dir yet as present, useful for `harness list`/`refresh` signal).
// Shell install/uninstall/repair actions gate on home-dir existence only, matching the exact
// semantics of the harness_present() function this replaces, so swapping the source is
// behavior-preserving. Install-time writes stay home-gated so RoboRepo never creates a home
// directory the harness itself has not created.
// One row per provider: id, home path, "1"/"0" home-dir presence, display name, root-config home
// path (empty string if the provider declares no "rootConfig" manifest path). The root-config
// path's basename follows the same convention as this repo's generated/<id>/<basename> build
// output, so shell installers can derive their generated-source path from it instead of
// hardcoding a per-harness filename.
export function harnessDetected() {
  for (const provider of listHarnessProviders()) {
    const homePath = resolveHarnessPath(provider.manifest, "home");
    const present = fs.existsSync(homePath) ? "1" : "0";
    const rootConfigPath = hasHarnessPath(provider.manifest, "rootConfig")
      ? resolveHarnessPath(provider.manifest, "rootConfig")
      : "";
    console.log(`${provider.id}\t${homePath}\t${present}\t${provider.manifest.displayName}\t${rootConfigPath}`);
  }
}
