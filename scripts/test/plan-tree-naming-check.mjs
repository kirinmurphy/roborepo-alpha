#!/usr/bin/env node
// This repository's real plan tree against its own namespace vocabulary, so a badly named plan fails
// here rather than waiting to be promoted. Other repositories get the same rule from
// `roborepo plans validate`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectNamespaces, validatePlanNaming } from "../../modules/plan-suite/naming.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = readProjectNamespaces(root);
assert.equal(config.error, undefined, "docs/plans/plans-config.json must parse");
assert.ok(config.namespaces.length > 0, "this repository declares its namespaces");

const offenders = [];
let checked = 0;
for (const lifecycle of fs.readdirSync(path.join(root, "docs", "plans"), { withFileTypes: true })) {
  if (!lifecycle.isDirectory()) continue;
  for (const filename of fs.readdirSync(path.join(root, "docs", "plans", lifecycle.name))) {
    if (!filename.endsWith(".md")) continue;
    checked += 1;
    for (const item of validatePlanNaming({ filename, lifecycle: lifecycle.name, projectNamespaces: config.namespaces })) {
      offenders.push(`docs/plans/${lifecycle.name}/${filename}: ${item.code}: ${item.message}`);
    }
  }
}
assert.ok(checked > 0, "the plan tree was found");
assert.deepEqual(offenders, [], "rename these plans, or declare their namespace in plans-config.json");
console.log(`plan tree naming: ${checked} plans ok`);
