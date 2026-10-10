#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  emptyCohortFilter, normalizeCohortFilter, applyCohortFilter, describeCohortFilter,
  activeFilterCount, filterSessionsByTaskCategory,
} from "../cli/telemetry-cohort.mjs";
import { buildRepositoryHashIndex, repositoryRefForEvent } from "../cli/telemetry-repository.mjs";

// The normalized cohort filter object shared by the CLI and portal, so all panels receive the same
// globally filtered event set. Pure module over already-loaded capture/marker arrays; no fs.

testNormalizeFillsDefaults();
testNormalizeIgnoresGarbage();
testApplyFilterByHarnessModelRepo();
testApplyFilterByOperationAndPhase();
testApplyFilterByOutcomeRequiresMarkers();
testApplyFilterByOutcomeIgnoredWithoutMarkers();
testApplyFilterByTaskCategory();
testApplyFilterByTaskCategoryIgnoredWithoutMarkers();
testFilterSessionsByTaskCategory();
testDescribeCohortFilter();
testActiveFilterCount();
testCanonicalRepositoryScope();
testReadTimeRepositoryResolution();
console.log("telemetry cohort checks passed");

// sha256/24 — must match telemetry-capture.mjs hash() so the registry index lines up with the
// normalized_remote_hash written at capture time.
function captureHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function testCanonicalRepositoryScope() {
  const direct = event({ repo: { label: "roborepo", repository_id: "git:github.com/kirinmurphy/roborepo" } });
  const other = event({ repo: { label: "other", repository_id: "git:github.com/kirinmurphy/other" } });
  const filter = { ...emptyCohortFilter(), repository_ids: ["git:github.com/kirinmurphy/roborepo"] };
  const kept = applyCohortFilter([direct, other], filter);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].repo.repository_id, "git:github.com/kirinmurphy/roborepo");

  // Legacy event (no repository_id) matched via normalized_remote_hash against a registry index.
  const registry = { repositories: { "git:github.com/kirinmurphy/roborepo": { id: "git:github.com/kirinmurphy/roborepo", normalizedRemote: "git:github.com/kirinmurphy/roborepo" } } };
  const hashIndex = buildRepositoryHashIndex(registry, captureHash);
  const legacy = event({ repo: { label: "roborepo", normalized_remote_hash: captureHash("git:github.com/kirinmurphy/roborepo") } });
  const legacyKept = applyCohortFilter([legacy, other], filter, { repositoryHashIndex: hashIndex });
  assert.equal(legacyKept.length, 1, "legacy event resolves via normalized-remote-hash");

  // Composes with legacy label filter (both must pass).
  const both = { ...filter, repos: ["roborepo"] };
  assert.equal(applyCohortFilter([direct], both).length, 1);
  assert.equal(applyCohortFilter([event({ repo: { label: "nope", repository_id: "git:github.com/kirinmurphy/roborepo" } })], both).length, 0);
}

function testReadTimeRepositoryResolution() {
  assert.equal(repositoryRefForEvent(event({ repo: { label: "x", repository_id: "git:h/o/r" } }), null).provenance, "direct");
  const registry = { repositories: { "git:h/o/r": { id: "git:h/o/r", normalizedRemote: "git:h/o/r" } } };
  const idx = buildRepositoryHashIndex(registry, captureHash);
  assert.equal(repositoryRefForEvent(event({ repo: { label: "x", normalized_remote_hash: captureHash("git:h/o/r") } }), idx).provenance, "legacy-remote-hash");
  assert.equal(repositoryRefForEvent(event({ repo: { label: "x" } }), idx).provenance, "unresolved");
  assert.equal(repositoryRefForEvent(event({}), idx).repositoryId, null);
}

function event(overrides) {
  return {
    harness: "claude",
    session_id: "s1",
    repo: { label: "roborepo" },
    ts: "2026-01-01T00:00:00Z",
    tokens: { total: 10 },
    session: { model: "sonnet" },
    ...overrides,
  };
}

function testNormalizeFillsDefaults() {
  const filter = normalizeCohortFilter(null);
  assert.deepEqual(filter, emptyCohortFilter());
}

function testNormalizeIgnoresGarbage() {
  const filter = normalizeCohortFilter({ harnesses: "not-an-array", models: [1, 2, "sonnet"], time: { range_ms: "bogus" } });
  assert.deepEqual(filter.harnesses, []);
  assert.deepEqual(filter.models, ["sonnet"]);
  assert.equal(filter.time.range_ms, null);
}

function testApplyFilterByHarnessModelRepo() {
  const events = [
    event({ harness: "claude", session: { model: "sonnet" }, repo: { label: "roborepo" } }),
    event({ harness: "codex", session: { model: "gpt" }, repo: { label: "other" } }),
  ];
  const filtered = applyCohortFilter(events, normalizeCohortFilter({ harnesses: ["claude"] }));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].harness, "claude");

  const byModel = applyCohortFilter(events, normalizeCohortFilter({ models: ["gpt"] }));
  assert.equal(byModel.length, 1);
  assert.equal(byModel[0].session.model, "gpt");

  const byRepo = applyCohortFilter(events, normalizeCohortFilter({ repos: ["other"] }));
  assert.equal(byRepo.length, 1);
}

function testApplyFilterByOperationAndPhase() {
  const events = [
    event({ operation: { category: "test" }, phase: { name: "debugging" } }),
    event({ operation: { category: "lint" }, phase: { name: "implementation" } }),
  ];
  const byOp = applyCohortFilter(events, normalizeCohortFilter({ operations: ["test"] }));
  assert.equal(byOp.length, 1);
  const byPhase = applyCohortFilter(events, normalizeCohortFilter({ phases: ["implementation"] }));
  assert.equal(byPhase.length, 1);
}

function testApplyFilterByOutcomeRequiresMarkers() {
  const events = [event({ session_id: "s1" }), event({ session_id: "s2" })];
  const markers = [
    { type: "outcome", session_id: "s1", status: "successful", ts: "2026-01-01T00:00:01Z" },
    { type: "outcome", session_id: "s2", status: "failed", ts: "2026-01-01T00:00:01Z" },
  ];
  const filtered = applyCohortFilter(events, normalizeCohortFilter({ outcomes: ["successful"] }), { markers });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].session_id, "s1");
}

function testApplyFilterByOutcomeIgnoredWithoutMarkers() {
  // Filtering by outcome with no markers passed must not silently drop everything — outcomes
  // are never inferred, so an outcome filter with no marker data degrades to a no-op
  // for that dimension rather than excluding every capture.
  const events = [event({ session_id: "s1" })];
  const filtered = applyCohortFilter(events, normalizeCohortFilter({ outcomes: ["successful"] }));
  assert.equal(filtered.length, 1);
}

function testApplyFilterByTaskCategory() {
  // task_categories must be a real per-capture filter through applyCohortFilter() (used by the
  // portal's cohort-vs-cohort analysis path), not only through the separate
  // filterSessionsByTaskCategory() helper experimentStatus() calls.
  const events = [event({ session_id: "s1" }), event({ session_id: "s2" })];
  const markers = [
    { type: "outcome", session_id: "s1", task_category: "bug-fix", ts: "2026-01-01T00:00:01Z" },
    { type: "outcome", session_id: "s2", task_category: "documentation", ts: "2026-01-01T00:00:01Z" },
  ];
  const filtered = applyCohortFilter(events, normalizeCohortFilter({ task_categories: ["bug-fix"] }), { markers });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].session_id, "s1");
}

function testApplyFilterByTaskCategoryIgnoredWithoutMarkers() {
  const events = [event({ session_id: "s1" })];
  const filtered = applyCohortFilter(events, normalizeCohortFilter({ task_categories: ["bug-fix"] }));
  assert.equal(filtered.length, 1, "task_categories filter with no marker data must not exclude everything");
}

function testFilterSessionsByTaskCategory() {
  const events = [event({ session_id: "s1" }), event({ session_id: "s2" })];
  const markers = [
    { type: "outcome", session_id: "s1", task_category: "bug-fix" },
    { type: "outcome", session_id: "s2", task_category: "documentation" },
  ];
  const filtered = filterSessionsByTaskCategory(events, ["bug-fix"], markers);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].session_id, "s1");

  const unfiltered = filterSessionsByTaskCategory(events, [], markers);
  assert.equal(unfiltered.length, 2, "empty task_categories filter must not restrict anything");
}

function testDescribeCohortFilter() {
  assert.equal(describeCohortFilter(emptyCohortFilter()), "all data");
  const described = describeCohortFilter(normalizeCohortFilter({ harnesses: ["claude"], repos: ["roborepo"] }));
  assert.match(described, /claude/);
  assert.match(described, /roborepo/);
}

function testActiveFilterCount() {
  assert.equal(activeFilterCount(emptyCohortFilter()), 0);
  assert.equal(activeFilterCount(normalizeCohortFilter({ harnesses: ["claude"], models: ["sonnet"] })), 2);
}
