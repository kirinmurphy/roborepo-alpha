#!/usr/bin/env node
// Keeps harness-specific code out of the package system. Package install, removal, validation, and
// status run every harness-touching resource through a provider's adapters, so these files may not
// name a provider id (in code, strings, or identifiers) or import a provider's own folder. Comments
// are exempt: they explain, they don't branch. Provider ids come from the registry, so a new
// provider is covered without editing this check.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listHarnessProviders } from "../harnesses/registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliDir = path.join(repoRoot, "scripts/cli");

const PACKAGE_FILES = fs
  .readdirSync(cliDir)
  .filter((name) => name === "packages.mjs" || /^package-.*\.mjs$/.test(name))
  .map((name) => path.join(cliDir, name));

const providerIds = listHarnessProviders().map((provider) => provider.id);
const idPattern = new RegExp(`(${providerIds.join("|")})`, "i");
const providerFolderImport = new RegExp(`harnesses/(${providerIds.join("|")})/`);

// Blank out comments while keeping line numbers, so a hit reports the line it is on. String
// contents stay, since a harness id inside a string is exactly what this check is for.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const violations = [];
for (const file of PACKAGE_FILES) {
  const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    if (providerFolderImport.test(line) || idPattern.test(line)) {
      violations.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
    }
  });
}

assert.ok(PACKAGE_FILES.length > 0, "found the package-system files to scan");
assert.deepEqual(
  violations,
  [],
  `package-system code names a harness provider; move it behind a provider adapter:\n  ${violations.join("\n  ")}`,
);
console.log(`ok: package system is provider-neutral (${PACKAGE_FILES.length} files)`);
