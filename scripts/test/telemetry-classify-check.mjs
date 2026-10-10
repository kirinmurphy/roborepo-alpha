#!/usr/bin/env node
import assert from "node:assert/strict";
import { classifyCommand, failureSignature, CLASSIFIER_VERSION } from "../cli/telemetry-classify.mjs";

// Pure semantic
// classification of Bash commands into operation category/runner/scope. This repo's own
// package.json (npm test -> full suite via test-cli.sh, npm run test:xxx -> targeted single
// files) is the canonical full-vs-targeted fixture.

testFullSuiteVsTargeted();
testOtherCategories();
testAmbiguousStaysUnknown();
testClassifierVersionStamped();
testNeverStoresRawCommand();
testFailureSignature();
console.log("telemetry classify checks passed");

function testFullSuiteVsTargeted() {
  const full = classifyCommand("npm test");
  assert.equal(full.category, "test");
  assert.equal(full.runner, "npm");
  assert.equal(full.scope, "full");

  const targeted = classifyCommand("node scripts/test/telemetry-classify-check.mjs");
  assert.equal(targeted.category, "test");
  assert.equal(targeted.scope, "targeted");

  const targetedNpmScript = classifyCommand("npm run test:telemetry-schemas");
  assert.equal(targetedNpmScript.category, "test");

  const grepFiltered = classifyCommand("npx vitest --grep \"marker validation\"");
  assert.equal(grepFiltered.category, "test");
  assert.equal(grepFiltered.runner, "vitest");
  assert.equal(grepFiltered.scope, "targeted");
}

function testOtherCategories() {
  assert.equal(classifyCommand("npx eslint scripts/cli").category, "lint");
  assert.equal(classifyCommand("npx tsc --noEmit").category, "typecheck");
  assert.equal(classifyCommand("npm run build").category, "build");
  assert.equal(classifyCommand("npx prettier --write .").category, "format");
  assert.equal(classifyCommand("npm install").category, "install");
  assert.equal(classifyCommand("git status").category, "git");
  assert.equal(classifyCommand("npm run serve").category, "serve");
  assert.equal(classifyCommand("cat package.json").category, "other");
}

function testAmbiguousStaysUnknown() {
  // Plan rule #5: "return unknown when the command is ambiguous" — never guess a scope.
  assert.equal(classifyCommand("").category, "other");
  assert.equal(classifyCommand(null).category, "other");
  assert.equal(classifyCommand("   ").category, "other");
  const bareWord = classifyCommand("run the tests please");
  assert.equal(bareWord.scope, "unknown");
}

function testClassifierVersionStamped() {
  // Plan rule #6: "store a rule/version identifier with the classification".
  const result = classifyCommand("npm test");
  assert.equal(result.classifier_version, CLASSIFIER_VERSION);
  assert.equal(typeof CLASSIFIER_VERSION, "number");
}

function testNeverStoresRawCommand() {
  const result = classifyCommand("npm test -- --secret-flag=leaked-value");
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("leaked-value"), "classifier output must never contain raw command text");
  assert.ok(!serialized.includes("--secret-flag"), "classifier output must never contain raw command text");
}

function testFailureSignature() {
  const a = failureSignature("Error: expected 5 to equal 6\n  at test.mjs:10");
  const b = failureSignature("Error: expected 5 to equal 6\n  at test.mjs:10");
  const c = failureSignature("Error: expected 1 to equal 2\n  at test.mjs:20");
  assert.equal(a, b, "identical failure text must hash identically for rerun detection");
  assert.notEqual(a, c);
  assert.equal(failureSignature(""), null);
  assert.equal(failureSignature(null), null);
}
