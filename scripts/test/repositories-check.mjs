#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeGitRemote,
  resolveProjectIdentity,
  canonicalRepositoryId,
  localRepositoryId,
  rootId,
  resolveGitDir,
  defaultRegistry,
  validateRegistry,
  loadRegistry,
  writeRegistry,
  updateRegistry,
  registryPathFor,
  upsertRepository,
  repositoryIdForUrlKey,
  repositoryUrl,
  recordDiscovery,
  recordDiscoveryIfKnown,
  registerLocalRoot,
  setEnrollment,
  hideRepository,
  wipeRepositoryRegistry,
  setAlias,
  resolveRegistryAlias,
  associateResolved,
  associateLegacyHashes,
  removeDiscoveries,
  importDeveloperRuntimeAliases,
  canonicalizeDeveloperRuntimeIdentity,
  repositoryScopedFinding,
  globalFinding,
  isRepositoryScoped,
  providerUrlForRepositoryId,
  createScanCache,
} from "../../modules/repositories/index.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-repositories-"));

function mkRepo(name, remote) {
  const repo = path.join(tempRoot, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  if (remote) fs.writeFileSync(path.join(repo, ".git", "config"), `[remote "origin"]\n  url = ${remote}\n`);
  return fs.realpathSync(repo);
}

try {
  // ---- Normalization equivalence: SSH and HTTPS forms correlate ----
  const ssh = normalizeGitRemote("git@github.com:kirinmurphy/roborepo.git");
  const https = normalizeGitRemote("https://token@github.com/kirinmurphy/roborepo.git?x=1#f");
  assert.equal(ssh, "git:github.com/kirinmurphy/roborepo");
  assert.equal(ssh, https, "SSH and HTTPS remotes must normalize identically");
  assert.equal(normalizeGitRemote("ssh://git@github.com:22/kirinmurphy/roborepo.git"), "git:github.com/kirinmurphy/roborepo");
  assert.equal(normalizeGitRemote("git@github.com:KirinMurphy/Visa_Planner.git"), "git:github.com/KirinMurphy/Visa_Planner", "owner/repo casing preserved");
  assert.equal(normalizeGitRemote("../../../etc/passwd"), null, "traversal rejected");
  assert.equal(normalizeGitRemote(""), null);
  assert.equal(normalizeGitRemote(null), null);

  // ---- canonicalRepositoryId across tiers ----
  const gitRepo = mkRepo("gitrepo", "git@github.com:kirinmurphy/roborepo.git");
  const gitId = resolveProjectIdentity(gitRepo, "node");
  assert.equal(gitId.identityKind, "git");
  assert.equal(canonicalRepositoryId(gitId), "git:github.com/kirinmurphy/roborepo");

  const noRemote = mkRepo("noremote", null);
  const pathId = resolveProjectIdentity(noRemote, "node");
  assert.equal(pathId.identityKind, "path");
  assert.match(canonicalRepositoryId(pathId), /^local:[a-f0-9]{16}$/, "no-remote repo gets opaque local id");
  assert.ok(!canonicalRepositoryId(pathId).includes(noRemote), "local id must not leak the path");
  assert.equal(canonicalRepositoryId(pathId), localRepositoryId(noRemote), "local id derives from realpath");

  const processOnly = resolveProjectIdentity(path.join(tempRoot, "no-git-here"), "node");
  assert.equal(processOnly.identityKind, "process");
  assert.equal(canonicalRepositoryId(processOnly), null, "process-only is not a repository");

  // ---- Worktree resolution: linked worktree -> same canonical repo, distinct rootId ----
  // Simulate a real linked worktree: primary repo's git dir holds the config; the worktree gitdir
  // has a commondir pointer back to it.
  const primary = mkRepo("wt-primary", "git@github.com:kirinmurphy/shared.git");
  const commonGitDir = path.join(primary, ".git");
  const wtGitDir = path.join(commonGitDir, "worktrees", "feature");
  fs.mkdirSync(wtGitDir, { recursive: true });
  fs.writeFileSync(path.join(wtGitDir, "commondir"), "../..\n");
  const worktree = path.join(tempRoot, "wt-feature");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);

  const primaryId = resolveProjectIdentity(primary, "node");
  const wtId = resolveProjectIdentity(worktree, "node");
  assert.equal(wtId.identity, primaryId.identity, "worktree resolves to primary's canonical git id");
  assert.equal(canonicalRepositoryId(wtId), canonicalRepositoryId(primaryId));
  assert.notEqual(rootId(wtId.projectRoot), rootId(primaryId.projectRoot), "worktree keeps a distinct rootId");

  const resolvedDir = resolveGitDir(worktree);
  assert.equal(resolvedDir.isWorktree, true);
  // The administrative name ("feature"), not the checkout directory's basename ("wt-feature").
  assert.equal(resolvedDir.worktreeName, "feature");
  assert.equal(resolveGitDir(primary).worktreeName, null);
  assert.equal(fs.realpathSync(resolvedDir.commonDir), fs.realpathSync(commonGitDir));

  // ---- Multiple clones of one remote: distinct roots, same canonical repo ----
  const cloneA = mkRepo("cloneA", "git@github.com:kirinmurphy/dup.git");
  const cloneB = mkRepo("cloneB", "https://github.com/kirinmurphy/dup.git");
  assert.equal(resolveProjectIdentity(cloneA, "node").identity, resolveProjectIdentity(cloneB, "node").identity);
  assert.notEqual(rootId(cloneA), rootId(cloneB));

  // ---- Registry: default + strict validation ----
  const reg = defaultRegistry();
  validateRegistry(reg);
  assert.throws(() => validateRegistry({ ...reg, bogus: 1 }), /unknown registry field/);
  assert.throws(() => validateRegistry({ ...reg, version: 99 }), /unsupported repository registry version/);

  // ---- Registry mutators are idempotent ----
  const now = "2026-07-24T00:00:00.000Z";
  const later = "2026-07-24T02:00:00.000Z";
  upsertRepository(reg, { id: "git:github.com/kirinmurphy/roborepo", kind: "git", displayName: "roborepo", providerUrl: "https://github.com/kirinmurphy/roborepo", now });
  upsertRepository(reg, { id: "git:github.com/kirinmurphy/roborepo", kind: "git", displayName: "roborepo", now: later });
  assert.equal(Object.keys(reg.repositories).length, 1, "upsert is idempotent");
  assert.equal(reg.repositories["git:github.com/kirinmurphy/roborepo"].urlKey, "roborepo");
  assert.equal(repositoryUrl("roborepo"), "/repositories/roborepo");

  upsertRepository(reg, { id: "git:github.com/example/roborepo", kind: "git", displayName: "RoboRepo", now });
  const collidedUrlKey = reg.repositories["git:github.com/example/roborepo"].urlKey;
  assert.match(collidedUrlKey, /^roborepo-[a-z0-9]{4,}$/);
  assert.notEqual(collidedUrlKey, "roborepo", "a display-name collision receives a deterministic suffix");
  assert.equal(repositoryIdForUrlKey(reg, collidedUrlKey), "git:github.com/example/roborepo");
  assert.equal(upsertRepository(reg, { id: "git:github.com/example/roborepo", kind: "git", displayName: "Renamed", now: later }).urlKey, collidedUrlKey, "urlKey is stable across display-name changes");
  assert.throws(() => validateRegistry({ ...reg, repositories: {
    ...reg.repositories,
    "git:github.com/example/duplicate": { ...reg.repositories["git:github.com/example/roborepo"], id: "git:github.com/example/duplicate" },
  } }), /duplicate repository urlKey/);

  assert.equal(recordDiscovery(reg, "git:github.com/kirinmurphy/roborepo", { source: "developer-runtime", evidence: "git-remote", confidence: "high", now }), true);
  assert.equal(recordDiscovery(reg, "git:github.com/kirinmurphy/roborepo", { source: "developer-runtime", evidence: "git-remote", confidence: "high", now }), false, "same-source rediscovery within debounce is a no-op");
  recordDiscovery(reg, "git:github.com/kirinmurphy/roborepo", { source: "plans", evidence: "configured-scan-root", confidence: "high", now });
  assert.equal(reg.repositories["git:github.com/kirinmurphy/roborepo"].discoveries.length, 2, "distinct sources both recorded");

  const wipeReg = defaultRegistry();
  upsertRepository(wipeReg, { id: "local:2222222222222222", kind: "local", displayName: "wipe-me", now });
  wipeReg.aliases["old-wipe-id"] = "local:2222222222222222";
  wipeReg.localRootPaths = {
    aaaa2222: { path: tempRoot, repositoryId: "local:2222222222222222", firstSeenAt: now, lastSeenAt: now },
  };
  assert.equal(wipeRepositoryRegistry(wipeReg), true, "wiping a populated registry changes it");
  assert.deepEqual(wipeReg.repositories, {});
  assert.deepEqual(wipeReg.aliases, {});
  assert.deepEqual(wipeReg.localRootPaths, {});
  assert.equal(wipeRepositoryRegistry(wipeReg), false, "wiping an empty registry is a no-op");

  assert.equal(registerLocalRoot(reg, "git:github.com/kirinmurphy/roborepo", { rootId: "aaaa1111", now }), true);
  assert.equal(registerLocalRoot(reg, "git:github.com/kirinmurphy/roborepo", { rootId: "aaaa1111", now }), false, "same root within debounce is a no-op");
  registerLocalRoot(reg, "git:github.com/kirinmurphy/roborepo", { rootId: "bbbb2222", kind: "worktree", now });
  const roots = reg.repositories["git:github.com/kirinmurphy/roborepo"].localRoots;
  assert.equal(roots.length, 2);
  assert.equal(roots[0].kind, "primary", "first root promotes to primary");
  assert.equal(roots[1].kind, "worktree");

  assert.equal(setEnrollment(reg, "git:github.com/kirinmurphy/roborepo", "plans", { enabled: true, sourceId: "src1", now }), true);
  assert.equal(setEnrollment(reg, "git:github.com/kirinmurphy/roborepo", "plans", { enabled: true, sourceId: "src1", now }), false, "unchanged enrollment is a no-op");
  assert.equal(hideRepository(reg, "git:github.com/kirinmurphy/roborepo", { hidden: true, now }), true);
  assert.equal(reg.repositories["git:github.com/kirinmurphy/roborepo"].visibility, "hidden");

  validateRegistry(reg);

  // ---- Aliases: confirm, transitive resolution, cycle rejection ----
  setAlias(reg, "path:/tmp/robo", "git:github.com/kirinmurphy/roborepo", { now });
  assert.equal(resolveRegistryAlias(reg, "path:/tmp/robo"), "git:github.com/kirinmurphy/roborepo");
  // transitive
  upsertRepository(reg, { id: "local:deadbeefdeadbeef", kind: "local", displayName: "legacy", now });
  setAlias(reg, "local:deadbeefdeadbeef", "git:github.com/kirinmurphy/roborepo", { now });
  setAlias(reg, "path:/tmp/old", "local:deadbeefdeadbeef", { now });
  assert.equal(resolveRegistryAlias(reg, "path:/tmp/old"), "git:github.com/kirinmurphy/roborepo", "transitive alias resolves to terminal");
  assert.equal(repositoryIdForUrlKey(reg, reg.repositories["local:deadbeefdeadbeef"].urlKey, { includeHidden: true }), "git:github.com/kirinmurphy/roborepo", "an old urlKey resolves through a canonical alias");
  // cycle rejection: a canonical id already aliases -> roborepo; aliasing roborepo back to it cycles.
  assert.throws(() => setAlias(reg, "git:github.com/kirinmurphy/roborepo", "local:deadbeefdeadbeef", { now }), /cycle/);

  // ---- Persistence: atomic write, load round-trip, migration/backup, corruption ----
  const stateRoot = path.join(tempRoot, "state");
  writeRegistry({ stateRoot, registry: reg });
  const loaded = loadRegistry({ stateRoot });
  assert.equal(loaded.revision, reg.revision);
  assert.equal(Object.keys(loaded.repositories).length, Object.keys(reg.repositories).length);

  // ENOENT -> default
  const emptyState = path.join(tempRoot, "empty-state");
  assert.deepEqual(loadRegistry({ stateRoot: emptyState }), defaultRegistry());

  // Corruption -> throws clearly
  const badState = path.join(tempRoot, "bad-state");
  fs.mkdirSync(path.join(badState, "repositories"), { recursive: true });
  fs.writeFileSync(registryPathFor(badState), "{ not json");
  assert.throws(() => loadRegistry({ stateRoot: badState }), /malformed JSON/);

  // Older registries (v1, and v2 since the repository-sources cutover) reset directly to a fresh
  // registry, without retaining a backup.
  const legacyState = path.join(tempRoot, "legacy-state");
  fs.mkdirSync(path.join(legacyState, "repositories"), { recursive: true });
  fs.writeFileSync(registryPathFor(legacyState), JSON.stringify({ version: 1, revision: 7, repositories: { old: {} }, aliases: { old: "new" } }));
  assert.deepEqual(loadRegistry({ stateRoot: legacyState }), defaultRegistry());
  assert.equal(fs.existsSync(path.join(legacyState, "repositories", "registry.v1.backup.json")), false, "v1 reset creates no backup");
  const v2State = path.join(tempRoot, "v2-state");
  fs.mkdirSync(path.join(v2State, "repositories"), { recursive: true });
  fs.writeFileSync(registryPathFor(v2State), JSON.stringify({ version: 2, revision: 9, repositories: {}, aliases: {} }));
  assert.deepEqual(loadRegistry({ stateRoot: v2State }), defaultRegistry(), "a v2 registry loads as an empty v3 registry");
  assert.equal(JSON.parse(fs.readFileSync(registryPathFor(v2State), "utf8")).version, 3, "the reset is persisted");

  // Unknown future versions are refused without rewriting the file.
  const futureState = path.join(tempRoot, "future-state");
  fs.mkdirSync(path.join(futureState, "repositories"), { recursive: true });
  fs.writeFileSync(registryPathFor(futureState), JSON.stringify({ version: 4, revision: 1, repositories: {}, aliases: {} }));
  assert.throws(() => loadRegistry({ stateRoot: futureState }), /unsupported repository registry version/);

  // Optimistic concurrency
  updateRegistry({ stateRoot, expectedRevision: reg.revision, mutate: (r) => { upsertRepository(r, { id: "local:1111111111111111", kind: "local", displayName: "x" }); } });
  assert.throws(() => updateRegistry({ stateRoot, expectedRevision: 1, mutate: () => {} }), /REVISION_CONFLICT|revision conflict/);
  // no-op mutation skips write (revision unchanged)
  const before = loadRegistry({ stateRoot }).revision;
  updateRegistry({ stateRoot, mutate: () => false });
  assert.equal(loadRegistry({ stateRoot }).revision, before, "returning false skips the write");

  // ---- Associations: evidence/confidence + never auto-merge on name/prompt ----
  const gitAssoc = associateResolved(withRepo(gitId), { registry: reg });
  assert.equal(gitAssoc.repositoryId, "git:github.com/kirinmurphy/roborepo");
  assert.equal(gitAssoc.autoAssociate, true);
  assert.equal(gitAssoc.evidence, "git-remote");

  const procAssoc = associateResolved(withRepo(processOnly), { registry: reg });
  assert.equal(procAssoc.repositoryId, null);
  assert.equal(procAssoc.autoAssociate, false);

  // A no-remote path repo is medium confidence (not upgraded to high) with path-root evidence.
  const pathAssoc = associateResolved(withRepo(pathId), {});
  assert.equal(pathAssoc.evidence, "path-root");
  assert.equal(pathAssoc.confidence, "medium", "path tier must not be upgraded to high");
  assert.equal(pathAssoc.autoAssociate, true);

  // user alias wins and is high-confidence
  const aliasReg = defaultRegistry();
  upsertRepository(aliasReg, { id: "git:github.com/kirinmurphy/roborepo", kind: "git", displayName: "roborepo" });
  setAlias(aliasReg, pathId.identity, "git:github.com/kirinmurphy/roborepo");
  const aliasAssoc = associateResolved(withRepo(pathId), { registry: aliasReg });
  assert.equal(aliasAssoc.repositoryId, "git:github.com/kirinmurphy/roborepo");
  assert.equal(aliasAssoc.evidence, "user-alias");
  assert.equal(aliasAssoc.confidence, "high");

  // ---- Legacy hash association (remote-hash only; no root-hash tier) ----
  const hashIndex = {
    byNormalizedRemoteHash: new Map([["rem123", "git:github.com/kirinmurphy/roborepo"]]),
  };
  assert.equal(associateLegacyHashes({ normalizedRemoteHash: "rem123", hashIndex }).provenance, "legacy-remote-hash");
  assert.equal(associateLegacyHashes({ normalizedRemoteHash: "nope", hashIndex }).provenance, "unresolved");
  assert.equal(associateLegacyHashes({ hashIndex }).repositoryId, null);

  // ---- Per-source discovery provenance (pljvmyh §4) ----
  const srcReg = defaultRegistry();
  const srcId = "git:github.com/x/sourced";
  upsertRepository(srcReg, { id: srcId, kind: "git", displayName: "sourced" });
  const t0 = "2026-09-01T00:00:00.000Z";
  recordDiscovery(srcReg, srcId, { source: "developer-runtime", evidence: "git-remote", confidence: "high", now: t0 });
  recordDiscovery(srcReg, srcId, { source: "repository-source", sourceId: "src-aaaaaa", evidence: "directory-source", confidence: "high", now: t0 });
  recordDiscovery(srcReg, srcId, { source: "repository-source", sourceId: "src-bbbbbb", evidence: "repository-source", confidence: "high", now: t0 });
  assert.equal(srcReg.repositories[srcId].discoveries.length, 3, "each configured source keeps its own entry");
  assert.equal(recordDiscovery(srcReg, srcId, { source: "repository-source", sourceId: "src-aaaaaa", evidence: "directory-source", confidence: "high", now: t0 }), false, "same source + id is idempotent");
  validateRegistry(srcReg);
  assert.throws(() => validateRegistry({ ...srcReg, repositories: { [srcId]: { ...srcReg.repositories[srcId], discoveries: [{ source: "repository-source", firstSeenAt: t0, lastSeenAt: t0, evidence: "x", confidence: "high" }] } } }), /sourceId/, "configured discoveries require a sourceId");
  assert.throws(() => validateRegistry({ ...srcReg, repositories: { [srcId]: { ...srcReg.repositories[srcId], discoveries: [{ source: "telemetry", sourceId: "src-aaaaaa", firstSeenAt: t0, lastSeenAt: t0, evidence: "x", confidence: "high" }] } } }), /sourceId/, "only configured discoveries carry a sourceId");
  assert.deepEqual(removeDiscoveries(srcReg, { source: "repository-source", sourceId: "src-aaaaaa" }), [srcId]);
  assert.deepEqual(srcReg.repositories[srcId].discoveries.map((d) => d.sourceId || d.source), ["developer-runtime", "src-bbbbbb"], "removal is scoped to one source");
  removeDiscoveries(srcReg, { source: "developer-runtime" });
  removeDiscoveries(srcReg, { source: "repository-source", sourceId: "src-bbbbbb" });
  assert.ok(srcReg.repositories[srcId], "a repository left with no evidence is kept, not deleted");
  assert.equal(srcReg.repositories[srcId].discoveries.length, 0);

  // ---- Evidence-only observers (agent sessions) attach but never create (pljvmyh) ----
  const telemetry = { source: "telemetry", evidence: "telemetry-session", confidence: "high", now: t0 };
  assert.equal(recordDiscoveryIfKnown(srcReg, "git:github.com/x/never-found", telemetry), false);
  assert.equal(srcReg.repositories["git:github.com/x/never-found"], undefined, "an unknown repository is not created");
  assert.equal(recordDiscoveryIfKnown(srcReg, srcId, telemetry), true);
  assert.deepEqual(srcReg.repositories[srcId].discoveries.map((d) => d.source), ["telemetry"], "a known repository gains the evidence");
  setAlias(srcReg, "local:0123456789abcdef", srcId);
  assert.equal(recordDiscoveryIfKnown(srcReg, "local:0123456789abcdef", { ...telemetry, source: "developer-runtime" }), true);
  assert.equal(srcReg.repositories["local:0123456789abcdef"], undefined, "an aliased identity consolidates onto its canonical record");
  assert.equal(srcReg.repositories[srcId].discoveries.length, 2);

  // ---- Runtime alias import: idempotent, canonical mapping, skips non-repo targets ----
  assert.equal(canonicalizeDeveloperRuntimeIdentity("git:github.com/kirinmurphy/roborepo").id, "git:github.com/kirinmurphy/roborepo");
  assert.equal(canonicalizeDeveloperRuntimeIdentity("path:/tmp/robo").kind, "local");
  assert.ok(!canonicalizeDeveloperRuntimeIdentity("path:/tmp/robo").id.includes("/tmp"), "path import must not leak path");
  assert.equal(canonicalizeDeveloperRuntimeIdentity("process:/tmp:node"), null);
  assert.equal(canonicalizeDeveloperRuntimeIdentity("builtin:portal"), null);

  const migReg = defaultRegistry();
  const lhSettings = {
    aliases: {
      "path:/tmp/robo": "git:github.com/kirinmurphy/roborepo",
      "process:/x:node": "process:/y:node", // not a canonical target -> skipped
    },
  };
  const first = importDeveloperRuntimeAliases(migReg, lhSettings);
  assert.equal(first.changed, true);
  assert.equal(first.imported.length, 1);
  assert.equal(first.skipped.length, 1);
  assert.equal(resolveRegistryAlias(migReg, "path:/tmp/robo"), "git:github.com/kirinmurphy/roborepo");
  assert.ok(migReg.repositories["git:github.com/kirinmurphy/roborepo"], "alias target repository created");
  const second = importDeveloperRuntimeAliases(migReg, lhSettings);
  assert.equal(second.changed, false, "re-import is idempotent");
  validateRegistry(migReg);

  // ---- Provider URL builder: recognized hosts only, never for local ids ----
  assert.equal(providerUrlForRepositoryId("git:github.com/kirinmurphy/roborepo"), "https://github.com/kirinmurphy/roborepo");
  assert.equal(providerUrlForRepositoryId("git:gitlab.com/g/p"), "https://gitlab.com/g/p");
  assert.equal(providerUrlForRepositoryId("git:git.example.com/g/p"), null, "unknown host gets no url");
  assert.equal(providerUrlForRepositoryId("local:deadbeefdeadbeef"), null);

  // ---- Findings contract: repo-scoped vs global; never force association ----
  const scoped = repositoryScopedFinding({ code: "X" }, { repositoryId: "git:github.com/kirinmurphy/roborepo", rootId: "aaaa1111" });
  assert.equal(scoped.scope, "repository");
  assert.equal(scoped.repositoryId, "git:github.com/kirinmurphy/roborepo");
  assert.equal(scoped.rootId, "aaaa1111");
  assert.equal(isRepositoryScoped(scoped), true);
  const glob = globalFinding({ code: "Y" });
  assert.equal(glob.scope, "global");
  assert.equal(glob.repositoryId, undefined, "global finding never carries a repositoryId");
  assert.equal(isRepositoryScoped(glob), false);
  assert.throws(() => repositoryScopedFinding({}, { repositoryId: "path:/x" }), /invalid repository id/);

  // ---- Per-scan cache ----
  const cache = createScanCache();
  let computed = 0;
  const compute = () => {
    computed += 1;
    return { value: computed };
  };
  assert.equal(cache.get("/a", compute).value, 1);
  assert.equal(cache.get("/a", compute).value, 1, "a repeated key reuses the memoized value");
  assert.equal(computed, 1);
  assert.equal(cache.get("/b", compute).value, 2, "a distinct root computes separately");
  assert.equal(cache.size, 2);

  // Async work caches the promise itself, so concurrent callers under one root share a single
  // in-flight read rather than each starting their own.
  let asyncRuns = 0;
  const slow = () => {
    asyncRuns += 1;
    return Promise.resolve("done");
  };
  const shared = await Promise.all([cache.get("/c", slow), cache.get("/c", slow)]);
  assert.equal(asyncRuns, 1, "concurrent callers share one in-flight computation");
  assert.deepEqual(shared, ["done", "done"]);

  // A rootless caller must not poison the cache with a null key.
  assert.equal(cache.get(null, compute).value, 3);
  assert.equal(cache.size, 3, "a null key bypasses the cache entirely");
  console.log("ok  per-scan cache memoizes by root and bypasses null keys");

  console.log("repositories-check passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

// Test helper: mimic what developer-runtime discovery does — attach repository fields to a resolved
// identity — so association sees the same shape production does.
function withRepo(identity) {
  return { ...identity, repositoryId: canonicalRepositoryId(identity), rootId: identity.projectRoot ? rootId(identity.projectRoot) : null };
}
