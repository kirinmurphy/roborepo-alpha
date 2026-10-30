#!/usr/bin/env node
// Pure dependency-graph helpers shared by package state and install bundles: required closure,
// legacy-record root recovery, inverse relationships, and `requires`-only cycle detection.
import assert from "node:assert/strict";
import {
  dropRequiredIds,
  recommendedBy,
  requiredBy,
  requiredClosure,
  requiresCycles,
  rootsRequiring,
} from "../cli/package-graph.mjs";

const nodes = [
  { id: "parent-a", requires: ["shared"], recommends: ["helper"] },
  { id: "parent-b", requires: ["shared"] },
  { id: "shared", requires: ["leaf"] },
  { id: "leaf" },
  { id: "helper", recommends: ["parent-a"] },
  { id: "lonely" },
];

assert.deepEqual(requiredClosure(nodes, ["parent-a"]), ["leaf", "shared", "parent-a"],
  "closure lists dependencies before the packages that require them");
assert.deepEqual(requiredClosure(nodes, ["parent-a", "parent-b"]), ["leaf", "shared", "parent-a", "parent-b"],
  "a shared dependency appears once");
assert.deepEqual(requiredClosure(nodes, ["helper"]), ["helper"], "recommends never joins the closure");
assert.deepEqual(requiredClosure(nodes, ["ghost", "lonely"]), ["lonely"], "unknown roots are dropped");
assert.deepEqual(requiredClosure([{ id: "x", requires: ["ghost"] }], ["x"]), ["x"],
  "an unknown dependency is skipped, not thrown");

assert.deepEqual(dropRequiredIds(nodes, ["parent-a", "shared", "leaf", "lonely"]), ["parent-a", "lonely"],
  "ids another listed id requires (directly or transitively) are dropped");
assert.deepEqual(dropRequiredIds(nodes, ["parent-a", "shared"], { excluded: ["parent-a"] }), ["shared"],
  "an excluded parent does not keep its dependency off the root list");
assert.deepEqual(dropRequiredIds(nodes, ["shared", "leaf"]), ["shared"], "a mid-chain parent counts");

assert.deepEqual(requiredBy(nodes, "shared").sort(), ["parent-a", "parent-b"]);
assert.deepEqual(requiredBy(nodes, "shared", { activeIds: ["parent-b"] }), ["parent-b"],
  "activeIds limits inverse relationships");
assert.deepEqual(recommendedBy(nodes, "helper"), ["parent-a"]);
assert.deepEqual(recommendedBy(nodes, "leaf"), []);

assert.deepEqual(rootsRequiring(nodes, "leaf", ["parent-a", "lonely", "leaf"]), ["parent-a"],
  "roots keeping a package effective exclude the package itself and unrelated roots");

assert.deepEqual(requiresCycles(nodes), [], "mutual recommendations are not a cycle");
assert.deepEqual(
  requiresCycles([{ id: "a", requires: ["b"] }, { id: "b", requires: ["a"] }]),
  [["a", "b", "a"]],
);
assert.deepEqual(requiresCycles([{ id: "self", requires: ["self"] }]), [["self", "self"]]);

console.log("ok: package graph helpers");
