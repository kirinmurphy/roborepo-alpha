#!/usr/bin/env node
// Package provenance: enable records each package's source in the selection and applied records
// and a lock record behind it; the records survive a restart; bare-ID state migrates without
// changing what is selected, and an ambiguous ID is reported instead of guessed; an interrupted or
// corrupt write is reported, never read as empty; a recorded source that stops offering a package
// leaves it unresolved, and reconcile neither forgets it nor applies another source's package.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { liveClaudeRules, makeSourceRoots, runCli, runModules, writeReplaceOverride, writeRulesPackage } from "./fixtures/package-sources.mjs";

const MODULES = {
  c: "scripts/cli/package-catalog.mjs",
  s: "scripts/cli/package-sources.mjs",
  l: "scripts/cli/package-lock.mjs",
  m: "scripts/cli/package-provenance-migration.mjs",
  d: "scripts/cli/package-provenance-doctor.mjs",
};

function within(roots) {
  const run = (body) => {
    const result = runModules(roots.env, MODULES, body);
    assert.ok(result.ok, result.error);
    return result.value;
  };
  const ok = (...args) => {
    const result = runCli(roots.env, args);
    assert.equal(result.status, 0, `${args.join(" ")} should succeed\n${result.output}`);
    return result.output;
  };
  const json = (name) => JSON.parse(fs.readFileSync(path.join(roots.stateRoot, name), "utf8"));
  return { run, ok, json };
}

// Enable records sources; the records round-trip through a fresh process.
{
  const roots = makeSourceRoots("roborepo-provenance-enable-");
  const { run, ok, json } = within(roots);
  try {
    writeRulesPackage(roots.builtInDir, "prov-builtin");
    writeRulesPackage(roots.workspaceDir, "prov-local", { requires: ["prov-builtin"] });
    ok("package", "enable", "prov-local");
    assert.deepEqual(json("enabled-packages.json").sources, { "prov-local": "local" });
    assert.deepEqual(json("applied-packages.json").sources, { "prov-builtin": "builtin", "prov-local": "local" });
    const lock = run(`return l.readPackageLock();`);
    assert.deepEqual(Object.keys(lock.packages).sort(), ["prov-builtin", "prov-local"]);
    const local = lock.packages["prov-local"];
    assert.equal(local.kind, "live");
    assert.equal(local.sourceId, "local");
    assert.equal(local.resolved, path.join(roots.workspaceDir, "prov-local"));
    assert.match(local.fingerprint, /^sha256v2-[0-9a-f]{64}$/);
    // Disable keeps the install record: disabled is still installed.
    ok("package", "disable", "prov-local");
    assert.ok(run(`return Boolean(l.readPackageLock().packages["prov-local"]);`), "disable keeps the lock record");
    assert.deepEqual(json("enabled-packages.json").sources, { "prov-local": "local" }, "an explicit deselection keeps its source");

    // Schema round trip of a source list.
    const extra = path.join(roots.tmp, "extra");
    fs.mkdirSync(extra);
    const written = run(`
      s.writeSourceConfig([...s.readSourceConfig().sources, { id: "extra", type: "path", path: ${JSON.stringify(extra)}, trust: "local", enabled: false }]);
      return s.readSourceConfig();
    `);
    assert.equal(written.persisted, true);
    assert.deepEqual(written.sources.map((r) => [r.id, r.enabled]), [["builtin", true], ["local", true], ["extra", false]]);

    // Doctor: a local edit since apply is a hint, not a failure.
    ok("package", "enable", "prov-local");
    fs.appendFileSync(path.join(roots.workspaceDir, "prov-local", "rules.md"), "edited\n");
    const findings = run(`return d.packageProvenanceFindings();`);
    assert.ok(findings.some((f) => f.level === "hint" && /prov-local changed since it was applied/.test(f.message)), JSON.stringify(findings));
    assert.ok(!findings.some((f) => f.level === "fail"), JSON.stringify(findings));
    // A configured path source whose folder is gone fails doctor.
    fs.rmSync(extra, { recursive: true });
    run(`s.writeSourceConfig(s.readSourceConfig().sources.map((r) => r.id === "extra" ? { ...r, enabled: true } : r)); return true;`);
    const missing = run(`return d.packageProvenanceFindings();`);
    assert.ok(missing.some((f) => f.level === "fail" && /package source extra: folder does not exist/.test(f.message)), JSON.stringify(missing));
  } finally {
    roots.cleanup();
  }
}

// An interrupted write leaves a temp file beside the lock; the lock still reads as before. A
// truncated lock is reported, not read as empty.
{
  const roots = makeSourceRoots("roborepo-provenance-interrupted-");
  const { run } = within(roots);
  try {
    run(`l.writeLockRecord({ sourceId: "local", packageId: "kept", kind: "live", resolved: "/x" }); return true;`);
    const lockFile = path.join(roots.stateRoot, "packages", "package-lock.json");
    fs.writeFileSync(path.join(path.dirname(lockFile), ".package-lock.json.999.1.tmp"), "{ \"schemaVersion\": 1, \"pack");
    assert.deepEqual(Object.keys(run(`return l.readPackageLock().packages;`)), ["kept"], "a stray temp file is ignored");
    fs.writeFileSync(lockFile, "{ \"schemaVersion\": 1, \"pack");
    const broken = runModules(roots.env, MODULES, `return l.readPackageLock();`);
    assert.ok(!broken.ok && /invalid package lock/.test(broken.error), broken.error);
    const findings = run(`return d.packageProvenanceFindings();`);
    assert.ok(findings.some((f) => f.level === "fail" && /invalid package lock/.test(f.message)), JSON.stringify(findings));
  } finally {
    roots.cleanup();
  }
}

// Bare-ID migration: sources are recorded without changing the lists, a version-1 registry keeps
// its version, an ambiguous ID is reported and left unrecorded, and an override counts as a choice.
{
  const roots = makeSourceRoots("roborepo-provenance-migration-");
  const { run, json } = within(roots);
  try {
    writeRulesPackage(roots.builtInDir, "mig-builtin");
    writeRulesPackage(roots.builtInDir, "mig-shared");
    writeRulesPackage(roots.workspaceDir, "mig-local");
    writeRulesPackage(roots.workspaceDir, "mig-shared");
    fs.mkdirSync(roots.stateRoot, { recursive: true });
    const registry = { schemaVersion: 1, packages: ["mig-builtin", "mig-shared"], disabled: ["mig-local"] };
    fs.writeFileSync(path.join(roots.stateRoot, "enabled-packages.json"), JSON.stringify(registry));
    fs.writeFileSync(path.join(roots.stateRoot, "applied-packages.json"), JSON.stringify({ packages: ["mig-builtin", "mig-shared"] }));

    assert.equal(run(`return m.needsProvenanceMigration();`), true);
    const dry = run(`return m.migrateBareIdPackageState({ dryRun: true });`);
    assert.equal(dry.migrated, false);
    assert.equal(json("enabled-packages.json").sources, undefined, "a dry run writes nothing");

    const result = run(`return m.migrateBareIdPackageState();`);
    assert.deepEqual(result.ambiguous, [{ id: "mig-shared", candidates: ["builtin/mig-shared", "local/mig-shared"] }]);
    const after = json("enabled-packages.json");
    assert.deepEqual(after.packages, registry.packages, "selected ids unchanged");
    assert.deepEqual(after.disabled, registry.disabled, "deselections unchanged");
    assert.equal(after.schemaVersion, 1, "a version-1 registry keeps its version, so its list keeps its meaning");
    assert.deepEqual(after.sources, { "mig-builtin": "builtin", "mig-local": "local" }, "the ambiguous id gets no source");
    assert.deepEqual(json("applied-packages.json").packages, ["mig-builtin", "mig-shared"]);
    assert.deepEqual(Object.keys(run(`return l.readPackageLock().packages;`)), ["mig-builtin"], "only resolvable applied packages get lock records");
    assert.equal(run(`return m.needsProvenanceMigration();`), false, "migration runs once");

    // The same state with an override: the override is the recorded choice.
    fs.writeFileSync(path.join(roots.stateRoot, "enabled-packages.json"), JSON.stringify(registry));
    fs.writeFileSync(path.join(roots.stateRoot, "applied-packages.json"), JSON.stringify({ packages: ["mig-builtin", "mig-shared"] }));
    fs.rmSync(path.join(roots.stateRoot, "packages"), { recursive: true, force: true });
    writeReplaceOverride(roots.workspace, ["mig-shared"]);
    const overridden = run(`return m.migrateBareIdPackageState();`);
    assert.deepEqual(overridden.ambiguous, []);
    assert.equal(json("enabled-packages.json").sources["mig-shared"], "local");
    assert.equal(run(`return l.readPackageLock().packages["mig-shared"].sourceId;`), "local");
  } finally {
    roots.cleanup();
  }
}

// A recorded source stops offering the package: no substitution, and reconcile keeps the records.
{
  const roots = makeSourceRoots("roborepo-provenance-missing-source-");
  const { run, ok, json } = within(roots);
  try {
    writeRulesPackage(roots.workspaceDir, "moved", { marker: "local copy" });
    ok("package", "enable", "moved");
    fs.rmSync(path.join(roots.workspaceDir, "moved"), { recursive: true });
    writeRulesPackage(roots.builtInDir, "moved", { marker: "builtin copy" });
    const out = ok("package", "reconcile");
    assert.match(out, /package moved is unresolved/);
    assert.deepEqual(json("enabled-packages.json").packages, ["moved"], "reconcile does not forget an unresolved package");
    assert.ok(!liveClaudeRules(roots.home).includes("builtin copy"), "the other source's package is not applied");
    const findings = run(`return d.packageProvenanceFindings();`);
    assert.ok(findings.some((f) => f.level === "fail" && /package moved is unresolved/.test(f.message)), JSON.stringify(findings));
  } finally {
    roots.cleanup();
  }
}

// A selected package that requires an unresolved package is unresolved too: reconcile reports it,
// keeps both selections, and still applies the other packages instead of failing validation.
{
  const roots = makeSourceRoots("roborepo-provenance-unresolved-requirement-");
  const { ok, json } = within(roots);
  try {
    const team = path.join(roots.tmp, "team");
    writeRulesPackage(team, "child");
    writeRulesPackage(roots.workspaceDir, "parent", { requires: ["child"] });
    writeRulesPackage(roots.workspaceDir, "bystander", { marker: "bystander applied" });
    ok("package", "source", "add", team);
    ok("package", "enable", "parent");
    ok("package", "enable", "bystander");
    fs.rmSync(path.join(team, "child"), { recursive: true });
    const out = ok("package", "reconcile");
    assert.match(out, /package parent is unresolved \(it requires unresolved package child\)/);
    assert.match(out, /reconcile: Fixture bystander/, "the other packages are still reconciled");
    assert.deepEqual(json("enabled-packages.json").packages.sort(), ["bystander", "parent"], "the selection is kept");
    assert.match(ok("package", "list"), /bystander/, "package list still loads");
  } finally {
    roots.cleanup();
  }
}

// The content hash frames every entry with its length, so moving bytes between files changes it;
// a symbolic link in a copy RoboRepo installs is refused, never copied past the integrity check.
{
  const roots = makeSourceRoots("roborepo-provenance-hash-");
  const { run } = within(roots);
  const store = { ...MODULES, st: "scripts/cli/package-install-store.mjs" };
  try {
    const one = path.join(roots.tmp, "one");
    const two = path.join(roots.tmp, "two");
    fs.mkdirSync(one);
    fs.mkdirSync(two);
    fs.writeFileSync(path.join(one, "a"), "x\0b\0y");
    fs.writeFileSync(path.join(two, "a"), "x");
    fs.writeFileSync(path.join(two, "b"), "y");
    const hashes = runModules(roots.env, store, `return [st.hashPackageTree(${JSON.stringify(one)}), st.hashPackageTree(${JSON.stringify(two)})];`);
    assert.ok(hashes.ok, hashes.error);
    assert.notEqual(hashes.value[0], hashes.value[1], "one file holding x\\0b\\0y must not hash like files a=x and b=y");

    const pkg = path.join(roots.tmp, "linked", "linked-pkg");
    writeRulesPackage(path.dirname(pkg), "linked-pkg");
    const before = runModules(roots.env, store, `return st.hashPackageTree(${JSON.stringify(pkg)});`);
    assert.ok(before.ok, before.error);
    fs.writeFileSync(path.join(roots.tmp, "outside.md"), "outside content\n");
    fs.symlinkSync(path.join(roots.tmp, "outside.md"), path.join(pkg, "extra.md"));
    const promote = runModules(roots.env, store, `
      return st.promoteMaterialized({
        sourceFolder: ${JSON.stringify(pkg)},
        resolution: { sourceId: "gitsrc", packageId: "linked-pkg", resolved: "abc123", sourceType: "git", trust: "unverified", integrity: ${JSON.stringify(before.value)} },
      });
    `);
    assert.ok(!promote.ok && /symbolic links are not allowed/.test(promote.error), promote.error);
    assert.equal(run(`return l.lockRecordFor("linked-pkg");`), null, "nothing is recorded");
    assert.ok(!fs.existsSync(path.join(roots.stateRoot, "packages", "installed", "gitsrc")), "nothing is installed");

    // An already installed copy for that revision is checked the same way.
    fs.rmSync(path.join(pkg, "extra.md"));
    const target = path.join(roots.stateRoot, "packages", "installed", "gitsrc", "abc123", "linked-pkg");
    fs.cpSync(pkg, target, { recursive: true });
    fs.symlinkSync(path.join(roots.tmp, "outside.md"), path.join(target, "extra.md"));
    const reuse = runModules(roots.env, store, `
      return st.promoteMaterialized({
        sourceFolder: ${JSON.stringify(pkg)},
        resolution: { sourceId: "gitsrc", packageId: "linked-pkg", resolved: "abc123", sourceType: "git", trust: "unverified", integrity: ${JSON.stringify(before.value)} },
      });
    `);
    assert.ok(!reuse.ok && /symbolic links are not allowed/.test(reuse.error), reuse.error);

    // A link under a name the hash skips (the source metadata file) is refused too, in the staged
    // copy and in an existing target, so writing metadata can never follow it out of the store.
    fs.rmSync(path.join(target, "extra.md"));
    fs.symlinkSync(path.join(roots.tmp, "outside.md"), path.join(target, ".roborepo-source.json"));
    const reuseExcluded = runModules(roots.env, store, `
      return st.promoteMaterialized({
        sourceFolder: ${JSON.stringify(pkg)},
        resolution: { sourceId: "gitsrc", packageId: "linked-pkg", resolved: "abc123", sourceType: "git", trust: "unverified", integrity: ${JSON.stringify(before.value)} },
      });
    `);
    assert.ok(!reuseExcluded.ok && /symbolic links are not allowed/.test(reuseExcluded.error), reuseExcluded.error);
    fs.rmSync(path.join(roots.stateRoot, "packages", "installed"), { recursive: true, force: true });

    fs.symlinkSync(path.join(roots.tmp, "outside.md"), path.join(pkg, ".roborepo-source.json"));
    const stagedExcluded = runModules(roots.env, store, `
      return st.promoteMaterialized({
        sourceFolder: ${JSON.stringify(pkg)},
        resolution: { sourceId: "gitsrc", packageId: "linked-pkg", resolved: "abc123", sourceType: "git", trust: "unverified", integrity: ${JSON.stringify(before.value)} },
        metadata: { collection: "c" },
      });
    `);
    assert.ok(!stagedExcluded.ok && /symbolic links are not allowed/.test(stagedExcluded.error), stagedExcluded.error);
    assert.equal(fs.readFileSync(path.join(roots.tmp, "outside.md"), "utf8"), "outside content\n", "the link target is untouched");
    assert.equal(run(`return l.lockRecordFor("linked-pkg");`), null, "nothing is recorded");
  } finally {
    roots.cleanup();
  }
}

// Overlapping processes each read the lock, change one record and write it back. The package lock
// serializes that, so no process's record is lost.
{
  const roots = makeSourceRoots("roborepo-provenance-lock-race-");
  const { run } = within(roots);
  try {
    const lockModule = path.join(roots.appRoot, "scripts/cli/package-lock.mjs");
    const writers = 6;
    const perWriter = 15;
    const script = (n) => `
      const l = await import(${JSON.stringify(lockModule)});
      for (let i = 0; i < ${perWriter}; i++) {
        l.writeLockRecord({ sourceId: "local", packageId: "w${n}-" + i, kind: "live", resolved: "/x" });
      }
    `;
    const exits = await Promise.all(Array.from({ length: writers }, (_, n) => new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script(n)], { env: roots.env, stdio: ["ignore", "ignore", "inherit"] });
      child.on("exit", resolve);
    })));
    assert.deepEqual(exits, Array(writers).fill(0), "every writer finishes");
    const ids = run(`return Object.keys(l.readPackageLock().packages);`);
    assert.equal(ids.length, writers * perWriter, `every concurrent write is kept (${ids.length} of ${writers * perWriter})`);
    assert.ok(!fs.existsSync(path.join(roots.stateRoot, "packages", "package-lock.json.lock")), "the lock is released");

    // A lock left by a process that no longer exists is taken over rather than blocking forever.
    fs.writeFileSync(path.join(roots.stateRoot, "packages", "package-lock.json.lock"), "999999999\n");
    run(`l.writeLockRecord({ sourceId: "local", packageId: "after-crash", kind: "live", resolved: "/x" }); return true;`);
    assert.ok(run(`return Boolean(l.lockRecordFor("after-crash"));`));
  } finally {
    roots.cleanup();
  }
}

console.log("ok: package provenance records, migration, and unresolved sources");
