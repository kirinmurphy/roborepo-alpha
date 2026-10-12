import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { scanForString } from "../lib/scan-for-string.mjs";

export function assertNoSourceCoupling(homeDir, checkoutPath) {
  const matches = scanForString(homeDir, checkoutPath);
  assert.equal(
    matches.length,
    0,
    `found source-checkout path leaked into generated files: ${matches.join(", ")}`,
  );
}

// State-root pointer files that are expected to hold the concrete npm install directory:
// - install-state.json records which installation last wrote into the home directory, so a new
//   install can reclaim links an older one left behind. Its value is meant to go stale.
// - app-root.json tells installed harness hooks, which run as copies outside the package, where the
//   package's manifests live. Every CLI run rewrites it when the install directory has moved, and a
//   stale value only makes the hooks defer, as they would with no record.
// Generated harness files and workspace records must never hold the path.
const STATE_POINTER_FILES = new Set(["install-state.json", "app-root.json"]);

export function assertNoVersionedPathCoupling(scanRoot, prefixDir, packageName, { allowStatePointers = true } = {}) {
  const versionedRoot = fs.realpathSync(path.join(prefixDir, "lib", "node_modules", packageName));
  const rawMatches = scanForString(scanRoot, versionedRoot);
  const isPointer = (relPath) => allowStatePointers && STATE_POINTER_FILES.has(path.basename(relPath));
  const matches = rawMatches.filter((relPath) => !isPointer(relPath));
  const exempted = rawMatches.filter(isPointer);
  if (exempted.length) {
    console.log(`exempted from versioned-path check (state pointer files): ${exempted.join(", ")}`);
  }
  assert.equal(
    matches.length,
    0,
    `found versioned npm install path leaked into generated files outside the state pointer files (${[...STATE_POINTER_FILES].join(", ")}): ${matches.join(", ")}`,
  );
}
