#!/usr/bin/env node
// computeServerCodeSignature drives the portal's restart notice: it must change when a server
// module changes on disk and return to its old value when nothing differs. The case adds a
// throwaway module under scripts/cli and removes it again, leaving the checkout as it was.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeServerCodeSignature } from "../cli/portal-source-hash.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const probe = path.join(repoRoot, "scripts", "cli", `.signature-probe-${process.pid}.mjs`);

const before = computeServerCodeSignature();
assert.equal(computeServerCodeSignature(), before, "the signature is stable while nothing changes");
try {
  fs.writeFileSync(probe, "export {};\n");
  assert.notEqual(computeServerCodeSignature(), before, "a new or changed server module changes the signature");
} finally {
  fs.rmSync(probe, { force: true });
}
assert.equal(computeServerCodeSignature(), before, "removing the change restores the signature");

const partial = fs.readFileSync(path.join(repoRoot, "portal", "shared", "chrome-partial.html"), "utf8");
const theme = fs.readFileSync(path.join(repoRoot, "portal", "shared", "theme.js"), "utf8");
assert.match(partial, /id="tpl-server-restart-notice"/, "the shared chrome carries the restart notice template");
assert.match(theme, /serverCodeChanged/, "theme.js shows the notice from the status endpoint");

console.log("portal-server-code-signature ok");
