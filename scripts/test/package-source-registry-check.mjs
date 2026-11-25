#!/usr/bin/env node
// Package sources and catalog composition: the default sources, the bundled and path adapters, a
// second path source next to the workspace, and the same-ID rules (replace override, lock record,
// single candidate, collision, unresolved when the recorded source stops offering the package).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSourceRoots, runModules, writeReplaceOverride, writeRulesPackage } from "./fixtures/package-sources.mjs";

const MODULES = {
  c: "scripts/cli/package-catalog.mjs",
  s: "scripts/cli/package-sources.mjs",
  a: "scripts/cli/package-source-adapters.mjs",
  l: "scripts/cli/package-lock.mjs",
};

const roots = makeSourceRoots("roborepo-package-source-registry-");
const run = (body) => {
  const result = runModules(roots.env, MODULES, body);
  assert.ok(result.ok, result.error);
  return result.value;
};
const fails = (body) => {
  const result = runModules(roots.env, MODULES, body);
  assert.ok(!result.ok, `expected failure, got ${JSON.stringify(result.value)}`);
  return result.error;
};

try {
  writeRulesPackage(roots.builtInDir, "alpha");
  writeRulesPackage(roots.workspaceDir, "beta");

  // Defaults exist without a file, and reading them writes nothing.
  const defaults = run("return s.readSourceConfig();");
  assert.deepEqual(defaults.sources.map((r) => [r.id, r.type, r.trust]), [["builtin", "bundled", "official"], ["local", "path", "local"]]);
  assert.equal(defaults.persisted, false);
  assert.ok(!fs.existsSync(path.join(roots.stateRoot, "package-sources.json")), "reading sources never creates the file");

  // The adapter contract: each adapter lists entries, resolves one, and a live source materializes
  // to its own folder.
  const contract = run(`
    const out = {};
    for (const record of s.readSourceConfig().sources) {
      const adapter = a.createSourceAdapter(record);
      const entries = adapter.list();
      const resolution = adapter.resolve(entries[0].packageId);
      out[record.id] = { kind: adapter.kind, ids: entries.map((e) => e.packageId), resolution, folder: adapter.materialize(resolution), missing: adapter.resolve("nope") };
    }
    return out;
  `);
  assert.deepEqual(contract.builtin.ids, ["alpha"]);
  assert.deepEqual(contract.local.ids, ["beta"]);
  assert.equal(contract.local.resolution.kind, "live");
  assert.equal(contract.local.folder, path.join(roots.workspaceDir, "beta"), "a path source is used in place");
  assert.equal(contract.builtin.missing, null);
  assert.match(fails(`a.createPackageSource({ id: "x", kind: "y", list() {}, resolve() {} });`), /missing materialize/);

  // Every catalog package carries its provenance and tab.
  const provenance = run(`return c.loadPackageCatalog({ includeUnavailable: true }).map((p) => [p.id, p.sourceId, p.sourceType, p.trust, p.tab, p.qualifiedName, p.origin]);`);
  assert.deepEqual(provenance, [
    ["alpha", "builtin", "bundled", "official", "system", "builtin/alpha", "built-in"],
    ["beta", "local", "path", "local", "custom", "local/beta", "workspace"],
  ]);

  // A second path source outside the workspace lands in the Custom tab next to it.
  const extra = path.join(roots.tmp, "team-packages");
  writeRulesPackage(extra, "gamma");
  run(`s.writeSourceConfig([...s.readSourceConfig().sources, { id: "team", type: "path", path: ${JSON.stringify(extra)}, trust: "local" }]); return true;`);
  const withTeam = run(`return c.loadPackageCatalog({ includeUnavailable: true }).map((p) => [p.id, p.sourceId, p.tab]);`);
  assert.deepEqual(withTeam.find(([id]) => id === "gamma"), ["gamma", "team", "custom"]);
  // A disabled source contributes nothing.
  run(`s.writeSourceConfig(s.readSourceConfig().sources.map((r) => r.id === "team" ? { ...r, enabled: false } : r)); return true;`);
  assert.ok(!run(`return c.loadPackageCatalog({ includeUnavailable: true }).map((p) => p.id);`).includes("gamma"));

  // Source records are validated; the reserved registry type and a second bundled source are refused.
  assert.match(fails(`s.writeSourceConfig([{ id: "official", type: "registry", trust: "official" }]);`), /not supported yet/);
  assert.match(fails(`s.writeSourceConfig([{ id: "other", type: "bundled", trust: "official" }]);`), /only the builtin source is bundled/);
  assert.match(fails(`s.writeSourceConfig([{ id: "Bad Id", type: "path", path: "/x", trust: "local" }]);`), /invalid package source id/);
  // An unreadable source file is reported, not treated as the defaults.
  const sourcesFile = path.join(roots.stateRoot, "package-sources.json");
  const saved = fs.readFileSync(sourcesFile, "utf8");
  fs.writeFileSync(sourcesFile, "{ not json");
  assert.match(fails(`return s.readSourceConfig();`), /invalid package source file/);
  fs.writeFileSync(sourcesFile, saved);

  // Same-ID resolution, over the real catalog composition.
  writeRulesPackage(roots.workspaceDir, "alpha", { label: "Workspace Alpha" });
  // No override, no record: a collision naming both candidates and how to choose.
  const collision = fails(`return c.loadPackageCatalog();`);
  assert.match(collision, /'alpha'/);
  assert.match(collision, /replace override/);
  assert.match(collision, /roborepo package install <source>\/alpha/);
  const composed = run(`const r = c.composePackageCatalog(); return { collisions: r.collisions, ids: r.packages.map((p) => p.id) };`);
  assert.deepEqual(composed.collisions, [{ id: "alpha", candidates: ["builtin/alpha", "local/alpha"] }]);
  assert.ok(!composed.ids.includes("alpha"), "a collision is never resolved by picking one");

  // A lock record is a persisted choice.
  run(`l.writeLockRecord({ sourceId: "builtin", packageId: "alpha", kind: "live", resolved: "x" }); return true;`);
  assert.deepEqual(run(`return c.loadPackageCatalog().filter((p) => p.id === "alpha").map((p) => p.qualifiedName);`), ["builtin/alpha"]);
  // A replace override picks local, even over a record naming builtin.
  writeReplaceOverride(roots.workspace, ["alpha"]);
  assert.deepEqual(run(`return c.loadPackageCatalog().filter((p) => p.id === "alpha").map((p) => p.qualifiedName);`), ["local/alpha"]);
  fs.rmSync(path.join(roots.workspace, "overrides"), { recursive: true, force: true });

  // The recorded source stops offering the package: unresolved, and the other source's package is
  // not substituted.
  run(`l.writeLockRecord({ sourceId: "local", packageId: "beta", kind: "live", resolved: "x" }); return true;`);
  fs.rmSync(path.join(roots.workspaceDir, "beta"), { recursive: true, force: true });
  writeRulesPackage(path.join(roots.builtInDir), "beta");
  const unresolved = run(`const r = c.composePackageCatalog(); return { unresolved: r.unresolved.map((u) => [u.id, u.sourceId]), ids: r.packages.map((p) => p.qualifiedName) };`);
  assert.deepEqual(unresolved.unresolved, [["beta", "local"]]);
  assert.ok(!unresolved.ids.includes("builtin/beta"), "another source's package is never substituted");

  // Pure resolution over synthetic candidates: single candidate, and two non-local sources.
  const pure = run(`
    const pkg = (sourceId, id) => ({ id, sourceId, qualifiedName: sourceId + "/" + id });
    const empty = { schemaVersion: 1, packages: {} };
    return {
      single: c.resolvePackageCandidates([pkg("team", "x")], { overrides: [], lock: empty }).packages.map((p) => p.qualifiedName),
      pair: c.resolvePackageCandidates([pkg("team", "x"), pkg("git-a", "x")], { overrides: [], lock: empty }).collisions,
      message: c.collisionMessage({ id: "x", candidates: ["team/x", "git-a/x"] }),
    };
  `);
  assert.deepEqual(pure.single, ["team/x"]);

  // `local` is reserved for the workspace folder: no other record may take its ID, and no other
  // source may claim to be the workspace.
  assert.match(fails(`s.writeSourceConfig([{ id: "local", type: "git", url: "https://example.com/packages.git", trust: "unverified" }]);`), /only the local source is the workspace folder/);
  assert.match(fails(`s.writeSourceConfig([{ id: "local", type: "path", path: "/x", trust: "local" }]);`), /only the local source is the workspace folder/);
  assert.match(fails(`s.writeSourceConfig([{ id: "team", type: "path", workspace: true, trust: "local" }]);`), /only the local source is the workspace folder/);
  assert.equal(run(`return s.validateSourceRecord({ id: "team-git", type: "git", url: "https://example.com/p.git", trust: "unverified" }).id;`), "team-git", "a git source under another ID is fine");

  // A live record from a folder source names its folder. When the same source ID now offers the
  // package from another folder (its path was edited), the package is unresolved, not retargeted.
  // The workspace source follows the configured workspace, so it is exempt.
  const moved = run(`
    const pkg = (sourceId, id, root) => ({ id, sourceId, sourceType: "path", sourceRoot: root, qualifiedName: sourceId + "/" + id });
    const lock = { schemaVersion: 1, packages: {
      x: { sourceId: "team", packageId: "x", kind: "live", resolved: "/old/x" },
      w: { sourceId: "local", packageId: "w", kind: "live", resolved: "/old-workspace/packages/w" },
    } };
    const r = c.resolvePackageCandidates([pkg("team", "x", "/new/x"), pkg("local", "w", "/new-workspace/packages/w")], { overrides: [], lock });
    return { ids: r.packages.map((p) => p.qualifiedName), unresolved: r.unresolved.map((u) => [u.id, u.sourceId]) };
  `);
  assert.deepEqual(moved.unresolved, [["x", "team"]]);
  assert.deepEqual(moved.ids, ["local/w"], "the workspace source follows the workspace");
  assert.deepEqual(pure.pair, [{ id: "x", candidates: ["team/x", "git-a/x"] }]);
  assert.match(pure.message, /provided by more than one source \(team\/x, git-a\/x\)/);
} finally {
  roots.cleanup();
}

console.log("ok: package source registry, adapters, and same-ID resolution");
