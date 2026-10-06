#!/usr/bin/env node
// Repository sources (pljvmyh §1–§6): the sources store, folder and exact-repository refresh,
// canonical deduplication, removal semantics, per-source failure state, and path privacy.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ageOutCandidates,
  defaultSources,
  loadRegistry,
  loadSources,
  repositoryDetailPayload,
  sourcesPathFor,
} from "../../modules/repositories/index.mjs";
import { recordRepositoryDiscovery, loadRepositoriesPayload } from "../cli/repositories.mjs";
import {
  addRepositorySource,
  autoDiscoveryEnabled,
  loadRepositorySources,
  refreshRepositorySources,
  removeRepositorySource,
  setRepositorySourceEnabled,
} from "../cli/repository-sources.mjs";

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-repo-sources-")));
const homeDir = tempRoot;

function gitRepo(dir, remote) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  if (remote) spawnSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

function freshState(name) {
  return path.join(tempRoot, `state-${name}`);
}

function sourceByPath(payload, displayPath) {
  return payload.sources.find((source) => source.displayPath === displayPath);
}

try {
  // ---- Defaults: auto-discovery is off and nothing is observed until the user opts in ----
  {
    const stateRoot = freshState("defaults");
    assert.equal(defaultSources().sources[0].enabled, false, "auto-discovery defaults to off");
    assert.equal(autoDiscoveryEnabled({ stateRoot }), false);
    const payload = loadRepositorySources({ stateRoot, homeDir });
    assert.equal(payload.autoDiscovery.enabled, false);
    assert.deepEqual(payload.sources, []);
    assert.deepEqual(payload.repositories, []);
  }

  // ---- Folder + exact sources and auto-discovery converge on one canonical record ----
  const projects = path.join(tempRoot, "projects");
  const alpha = gitRepo(path.join(projects, "alpha"), "https://github.com/example/alpha.git");
  gitRepo(path.join(projects, "nested", "beta"), "git@github.com:example/beta.git");
  fs.mkdirSync(path.join(projects, "plans-only", "docs", "plans"), { recursive: true });
  {
    const stateRoot = freshState("converge");
    let payload = addRepositorySource({ path: "~/projects", stateRoot, homeDir });
    const folder = sourceByPath(payload, "~/projects");
    assert.equal(folder.kind, "directory", "a readable non-repository folder is classified as a directory");
    assert.equal(folder.status.state, "healthy");
    assert.equal(folder.status.repositoryCount, 3, "folder finds git and plans-only repositories");
    assert.deepEqual(payload.repositories.map((repo) => repo.displayName), ["alpha", "beta", "plans-only"]);

    payload = addRepositorySource({ path: alpha, stateRoot, homeDir });
    assert.equal(sourceByPath(payload, "~/projects/alpha").kind, "repository", "an eligible root is classified as a repository");
    assert.equal(payload.repositories.length, 3, "overlapping sources do not duplicate a repository");

    // Runtime discovering the same checkout adds evidence to the same record.
    recordRepositoryDiscovery({
      repositoryId: "git:github.com/example/alpha", kind: "git", displayName: "alpha", source: "developer-runtime",
      evidence: "git-remote", confidence: "high", localRoot: "x", localRootPath: alpha, stateRoot,
    });
    payload = loadRepositorySources({ stateRoot, homeDir });
    const alphaRow = payload.repositories.find((repo) => repo.displayName === "alpha");
    assert.deepEqual(alphaRow.foundBy.sort(), ["auto-discovery", "~/projects", "~/projects/alpha"].sort(), "Found by lists every source");
    const registry = loadRegistry({ stateRoot });
    assert.equal(Object.keys(registry.repositories).length, 3);

    // Duplicate source paths are refused.
    assert.throws(() => addRepositorySource({ path: projects, stateRoot, homeDir }), (err) => err.code === "DUPLICATE_SOURCE");

    // Removing the folder keeps repositories still known through other evidence and keeps
    // evidence-less ones as records that age out instead of being deleted.
    payload = removeRepositorySource({ id: folder.id, stateRoot, homeDir });
    const after = loadRegistry({ stateRoot });
    assert.equal(Object.keys(after.repositories).length, 3, "source removal never deletes repositories");
    assert.deepEqual(payload.repositories.find((repo) => repo.displayName === "alpha").foundBy.sort(), ["auto-discovery", "~/projects/alpha"].sort());
    const beta = Object.values(after.repositories).find((record) => record.displayName === "beta");
    assert.equal(beta.discoveries.length, 0, "beta has no evidence left");
    const later = Date.parse(beta.localRoots[0].lastSeenAt) + 31 * 24 * 60 * 60 * 1000;
    assert.ok(ageOutCandidates(after, { now: later }).some((candidate) => candidate.repositoryId === beta.id), "an evidence-less repository ages out");

    // Turning auto-discovery off removes its evidence; turning it on starts a scan.
    let scans = 0;
    setRepositorySourceEnabled({ id: "auto-discovery", enabled: true, onAutoDiscoveryEnabled: () => { scans += 1; }, stateRoot, homeDir });
    assert.equal(scans, 1, "enabling auto-discovery starts the first scan immediately");
    assert.equal(autoDiscoveryEnabled({ stateRoot }), true);
    payload = setRepositorySourceEnabled({ id: "auto-discovery", enabled: false, stateRoot, homeDir });
    assert.equal(payload.autoDiscovery.enabled, false);
    assert.deepEqual(payload.repositories.find((repo) => repo.displayName === "alpha").foundBy, ["~/projects/alpha"], "auto-discovery evidence is dropped when it is turned off");

    // Paths never reach identity payloads; the management payload uses home-collapsed paths.
    assert.ok(!JSON.stringify(loadRepositoriesPayload({ stateRoot })).includes(tempRoot), "repository list payload is path-free");
    for (const record of Object.values(after.repositories)) {
      assert.ok(!JSON.stringify(repositoryDetailPayload(record)).includes(tempRoot), "detail payload is path-free");
    }
    assert.ok(!JSON.stringify(loadRepositorySources({ stateRoot, homeDir })).includes(tempRoot), "management payload shows ~-collapsed paths only");
  }

  // ---- Concurrent Runtime discovery and source refresh on one repository ----
  {
    const stateRoot = freshState("concurrent");
    addRepositorySource({ path: alpha, stateRoot, homeDir });
    const interleaved = [
      () => recordRepositoryDiscovery({ repositoryId: "git:github.com/example/alpha", kind: "git", displayName: "alpha", source: "developer-runtime", evidence: "git-remote", confidence: "high", localRoot: "runtime-root", localRootPath: alpha, stateRoot }),
      () => refreshRepositorySources({ stateRoot, homeDir }),
    ];
    for (let i = 0; i < 4; i += 1) interleaved[i % 2]();
    const registry = loadRegistry({ stateRoot });
    const record = registry.repositories["git:github.com/example/alpha"];
    assert.equal(Object.keys(registry.repositories).length, 1);
    assert.deepEqual(record.discoveries.map((d) => d.source).sort(), ["developer-runtime", "repository-source"], "both writers' evidence survives");
  }

  // ---- Unresolved paths need an explicit intent, which later refreshes honor ----
  {
    const stateRoot = freshState("unresolved");
    const pending = path.join(tempRoot, "not-yet");
    assert.throws(() => addRepositorySource({ path: pending, stateRoot, homeDir }), (err) => err.code === "INTENT_REQUIRED");
    let payload = addRepositorySource({ path: pending, kind: "repository", stateRoot, homeDir });
    assert.equal(sourceByPath(payload, "~/not-yet").status.state, "unavailable");
    // The path appears later as a folder of repositories. The user said "one repository", so the
    // source must not broaden into a folder walk.
    gitRepo(path.join(pending, "inner"), "https://github.com/example/inner.git");
    payload = refreshRepositorySources({ stateRoot, homeDir });
    const source = sourceByPath(payload, "~/not-yet");
    assert.equal(source.kind, "repository");
    assert.equal(source.status.state, "stale", "a repository source whose path is not a repository is stale");
    assert.equal(payload.repositories.length, 0, "the configured intent is not broadened");
  }

  // ---- Per-source failure state: missing, truncated, malformed ----
  {
    const stateRoot = freshState("failures");
    const moving = path.join(tempRoot, "moving");
    gitRepo(path.join(moving, "gamma"), "https://github.com/example/gamma.git");
    addRepositorySource({ path: moving, stateRoot, homeDir });
    addRepositorySource({ path: projects, stateRoot, homeDir });
    fs.renameSync(moving, `${moving}-moved`);
    let payload = refreshRepositorySources({ stateRoot, homeDir });
    assert.equal(sourceByPath(payload, "~/moving").status.state, "unavailable", "a moved folder is unavailable");
    assert.equal(sourceByPath(payload, "~/projects").status.state, "healthy", "one failed source does not affect others");
    assert.ok(payload.repositories.some((repo) => repo.displayName === "gamma"), "repositories from an unavailable source are not dropped");

    process.env.DISCOVERY_TIME_BUDGET_MS = "0";
    try {
      payload = refreshRepositorySources({ stateRoot, homeDir });
    } finally {
      delete process.env.DISCOVERY_TIME_BUDGET_MS;
    }
    assert.equal(sourceByPath(payload, "~/projects").status.state, "partial", "a truncated walk is partial, never complete");
    assert.ok(payload.repositories.find((repo) => repo.displayName === "alpha").foundBy.includes("~/projects"), "a partial walk keeps earlier evidence");

    // An unreadable subfolder makes the walk partial too, and must not drop what lies inside it.
    const locked = path.join(tempRoot, "locked");
    gitRepo(path.join(locked, "inner", "delta"), "https://github.com/example/delta.git");
    addRepositorySource({ path: locked, stateRoot, homeDir });
    fs.chmodSync(path.join(locked, "inner"), 0o000);
    try {
      payload = refreshRepositorySources({ stateRoot, homeDir });
    } finally {
      fs.chmodSync(path.join(locked, "inner"), 0o755);
    }
    if (process.getuid?.() !== 0) {
      assert.equal(sourceByPath(payload, "~/locked").status.state, "partial", "an unreadable subfolder makes the walk partial");
      assert.ok(payload.repositories.find((repo) => repo.displayName === "delta").foundBy.includes("~/locked"), "repositories behind an unreadable subfolder keep their evidence");
    }

    fs.writeFileSync(sourcesPathFor(stateRoot), "{ not json");
    const reset = loadSources({ stateRoot });
    assert.match(reset.loadError, /reset/);
    assert.equal(reset.sources.length, 1, "a malformed store falls back to defaults");
    assert.ok(fs.readdirSync(path.dirname(sourcesPathFor(stateRoot))).some((name) => name.startsWith("sources.json.invalid-")), "the malformed file is kept aside");
    assert.ok(Object.keys(loadRegistry({ stateRoot }).repositories).length > 0, "a malformed store does not invalidate the registry");
  }

  console.log("repositories-sources-check passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
