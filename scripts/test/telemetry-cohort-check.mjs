#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  emptyCohortFilter, normalizeCohortFilter, applyCohortFilter, describeCohortFilter,
  activeFilterCount, filterSessionsByTaskCategory,
} from "../cli/telemetry-cohort.mjs";
import { repositoryRefForEvent } from "../cli/telemetry-repository.mjs";

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
testOutsideListedRepositories();
testReadTimeRepositoryResolution();
testLegacyRepoLabelDimensionIsGone();
console.log("telemetry cohort checks passed");

function testCanonicalRepositoryScope() {
  const direct = event({ repo: { label: "roborepo", repository_id: "git:github.com/kirinmurphy/roborepo" } });
  const other = event({ repo: { label: "other", repository_id: "git:github.com/kirinmurphy/other" } });
  const filter = { ...emptyCohortFilter(), repository_ids: ["git:github.com/kirinmurphy/roborepo"] };
  const kept = applyCohortFilter([direct, other], filter);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].repo.repository_id, "git:github.com/kirinmurphy/roborepo");

  // An event without a repository_id belongs to no repository, whatever else it carries: a label
  // or an old fingerprint hash never matches a repository scope.
  const unattributed = event({ repo: { label: "roborepo", normalized_remote_hash: "0123456789abcdef01234567" } });
  assert.equal(applyCohortFilter([unattributed], filter).length, 0, "an event with no repository_id matches no repository scope");
}

// Activity outside listed repos: excluded_repository_ids keeps every event not attributed to a
// listed repository, including one with no repository at all, and together with each listed
// repository's own scope it partitions the whole set.
function testOutsideListedRepositories() {
  const listed = ["git:github.com/o/listed-a", "git:github.com/o/listed-b"];
  const events = [
    event({ session_id: "a", repo: { label: "a", repository_id: listed[0] } }),
    event({ session_id: "b", repo: { label: "b", repository_id: listed[1] } }),
    event({ session_id: "unknown", repo: { label: "unknown", repository_id: "git:github.com/o/not-registered" } }),
    event({ session_id: "ignored", repo: { label: "ignored", repository_id: "local:ignored0000" } }),
    event({ session_id: "none", repo: { label: "scratch" } }),
    event({ session_id: "no-repo", repo: undefined }),
  ];
  const outside = applyCohortFilter(events, normalizeCohortFilter({ excluded_repository_ids: listed }));
  assert.deepEqual(outside.map((e) => e.session_id), ["unknown", "ignored", "none", "no-repo"]);
  const perRepository = listed.map((id) => applyCohortFilter(events, normalizeCohortFilter({ repository_ids: [id] })).length);
  assert.equal(perRepository.reduce((sum, n) => sum + n, 0) + outside.length, events.length, "listed scopes plus outside equal all");
  assert.match(describeCohortFilter(normalizeCohortFilter({ excluded_repository_ids: listed })), /outside listed repos/);
  assert.equal(activeFilterCount(normalizeCohortFilter({ excluded_repository_ids: listed })), 1);
}

function testReadTimeRepositoryResolution() {
  assert.equal(repositoryRefForEvent(event({ repo: { label: "x", repository_id: "git:h/o/r" } })).provenance, "direct");
  assert.equal(repositoryRefForEvent(event({ repo: { label: "x", normalized_remote_hash: "0123456789abcdef01234567" } })).provenance, "unresolved");
  assert.equal(repositoryRefForEvent(event({ repo: { label: "x" } })).provenance, "unresolved");
  assert.equal(repositoryRefForEvent(event({})).repositoryId, null);
}

// The folder-name label filter was a second way to say "this repository"; it no longer exists.
function testLegacyRepoLabelDimensionIsGone() {
  const normalized = normalizeCohortFilter({ repos: ["roborepo"] });
  assert.equal("repos" in normalized, false);
  const events = [event({ repo: { label: "roborepo" } }), event({ repo: { label: "other" } })];
  assert.equal(applyCohortFilter(events, normalized).length, 2, "a repos filter restricts nothing");
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
  const described = describeCohortFilter(normalizeCohortFilter({ harnesses: ["claude"], repository_ids: ["git:github.com/o/roborepo"] }));
  assert.match(described, /claude/);
  assert.match(described, /roborepo/);
}

function testActiveFilterCount() {
  assert.equal(activeFilterCount(emptyCohortFilter()), 0);
  assert.equal(activeFilterCount(normalizeCohortFilter({ harnesses: ["claude"], models: ["sonnet"] })), 2);
}
