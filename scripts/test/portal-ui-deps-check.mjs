#!/usr/bin/env node
// The portal UI suite installs this checkout's dev dependencies on demand
// (scripts/test/portal-ui/ensure-deps.mjs). This checks when it decides an install is needed:
// a missing node_modules, a version that differs from package-lock.json, and the platform-skipped
// optional package that must not trigger an install on every run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installReason, staleDependencies } from "./portal-ui/ensure-deps.mjs";

const lockfile = {
  packages: {
    "": { name: "fixture", devDependencies: { "@playwright/test": "^1.62.1" } },
    "node_modules/@playwright/test": { version: "1.62.1", dev: true },
    "node_modules/playwright": { version: "1.62.1", dev: true },
    "node_modules/fsevents": { version: "2.3.2", dev: true, optional: true },
  },
};
const installed = (overrides = {}) => ({
  packages: {
    "node_modules/@playwright/test": { version: "1.62.1" },
    "node_modules/playwright": { version: "1.62.1" },
    ...overrides,
  },
});

assert.deepEqual(staleDependencies(lockfile, installed()), [], "matching install is current");
assert.deepEqual(
  staleDependencies(lockfile, installed({ "node_modules/fsevents": { version: "2.3.2" } })),
  [],
  "an installed optional package that matches is current",
);
assert.deepEqual(
  staleDependencies(lockfile, installed({ "node_modules/playwright": { version: "1.60.0" } })),
  ["node_modules/playwright@1.62.1"],
  "a version bump on the branch is stale",
);
assert.deepEqual(
  staleDependencies(lockfile, { packages: {} }),
  ["node_modules/@playwright/test@1.62.1", "node_modules/playwright@1.62.1"],
  "an empty install lists every required package, not the optional one",
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-deps-"));
try {
  assert.equal(installReason(dir), null, "a checkout without package-lock.json needs nothing");
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(lockfile));
  assert.equal(installReason(dir), "node_modules is missing");
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", ".package-lock.json"), JSON.stringify(installed()));
  assert.equal(installReason(dir), null, "a current node_modules needs no install");
  fs.writeFileSync(
    path.join(dir, "node_modules", ".package-lock.json"),
    JSON.stringify(installed({ "node_modules/playwright": { version: "1.60.0" } })),
  );
  assert.match(installReason(dir), /does not match package-lock\.json \(node_modules\/playwright@1\.62\.1\)/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("portal-ui-deps-check: ok");
