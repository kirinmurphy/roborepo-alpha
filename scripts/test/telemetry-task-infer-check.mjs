#!/usr/bin/env node
import assert from "node:assert/strict";
import { inferTaskCategory, inferTaskScale, categorizeFile, TASK_CLASSIFIER_VERSION } from "../cli/telemetry-task-infer.mjs";

// Explainable task
// category/scale inference over privacy-safe file-touch signals (extension-derived categories,
// never raw paths). Pure module — analysis-time callers build the `signals` object.

testCategorizeFileByExtension();
testCategorizeFileGenerated();
testDocsOnlyIsDocumentation();
testFailureBeforeEditsIsBugFix();
testUiOnlyIsUi();
testConfigOnlyIsDependencyConfiguration();
testMixedCategoriesWithNoStrongerSignalIsRefactorOrUnknown();
testNoSignalsIsUnknown();
testTaskScaleCrossCutting();
testTaskScaleSurfaceDerivation();
testClassifierVersionExported();
console.log("telemetry task-infer checks passed");

function testCategorizeFileByExtension() {
  assert.equal(categorizeFile("md"), "doc");
  assert.equal(categorizeFile("tsx"), "ui");
  assert.equal(categorizeFile("json"), "config");
  assert.equal(categorizeFile("mjs"), "code");
  assert.equal(categorizeFile(null), "unknown");
}

function testCategorizeFileGenerated() {
  assert.equal(categorizeFile("js", { looksGenerated: true }), "generated");
}

function testDocsOnlyIsDocumentation() {
  const result = inferTaskCategory({ changedFileCategories: ["doc", "doc"] });
  assert.equal(result.task_category, "documentation");
  assert.equal(result.task_category_source, "inferred");
}

function testFailureBeforeEditsIsBugFix() {
  const result = inferTaskCategory({ changedFileCategories: ["code"], hadTestFailureBeforeEdits: true, testFilesTouched: true });
  assert.equal(result.task_category, "bug-fix");
}

function testUiOnlyIsUi() {
  const result = inferTaskCategory({ changedFileCategories: ["ui", "ui"] });
  assert.equal(result.task_category, "ui");
}

function testConfigOnlyIsDependencyConfiguration() {
  const result = inferTaskCategory({ changedFileCategories: ["config"] });
  assert.equal(result.task_category, "dependency-configuration");
}

function testMixedCategoriesWithNoStrongerSignalIsRefactorOrUnknown() {
  const spread = inferTaskCategory({ changedFileCategories: ["code", "ui", "config"] });
  assert.ok(["refactor", "unknown"].includes(spread.task_category));
}

function testNoSignalsIsUnknown() {
  const result = inferTaskCategory({});
  assert.equal(result.task_category, "unknown");
}

function testTaskScaleCrossCutting() {
  const localized = inferTaskScale({ filesTouched: 2, directoriesTouched: 1 });
  const crossCutting = inferTaskScale({ filesTouched: 8, directoriesTouched: 4 });
  assert.equal(localized.cross_cutting, false);
  assert.equal(crossCutting.cross_cutting, true);
}

function testTaskScaleSurfaceDerivation() {
  const doc = inferTaskScale({ changedFileCategories: ["doc"] });
  const mixed = inferTaskScale({ changedFileCategories: ["doc", "code"] });
  const none = inferTaskScale({});
  assert.equal(doc.surface, "documentation");
  assert.equal(mixed.surface, "mixed");
  assert.equal(none.surface, "unknown");
}

function testClassifierVersionExported() {
  assert.equal(typeof TASK_CLASSIFIER_VERSION, "number");
}
