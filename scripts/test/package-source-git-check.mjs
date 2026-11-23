#!/usr/bin/env node
// Git package sources against local fixture repositories (file:// URLs), never the public
// internet. Covers: a URL resolving to an exact commit in the lock; each grouping rule (Agent
// Skills folders as a collection, a Claude Code plugin as one package, RoboRepo manifests as
// declared); the contents summary naming scripts and hooks before install; confirmation for an
// unverified source; a moved branch changing nothing until an explicit refresh and update; the
// trusted catalog pinning its reviewed commit; offline activation once installed; an unreachable
// repo, an invalid URL, and a symlinked repo failing without writing state; and same-ID
// disambiguation against a built-in package.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isolateGitConfig } from "./lib/git-config.mjs";
import { makeSourceRoots, repoRoot, runCli, runModules, writeRulesPackage } from "./fixtures/package-sources.mjs";

const roots = (() => {
  const made = makeSourceRoots("roborepo-package-source-git-");
  const restore = isolateGitConfig(made.tmp);
  return { ...made, env: { ...made.env, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: "1" }, restore };
})();

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

// A repository with one commit; returns { dir, url, commit(files) -> sha, head() }.
function makeRepo(name, files) {
  const dir = path.join(roots.tmp, "repos", name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  const commit = (next) => {
    writeFiles(dir, next);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
    return git(dir, "rev-parse", "HEAD");
  };
  const first = commit(files);
  return { dir, url: pathToFileURL(dir).href, first, commit, head: () => git(dir, "rev-parse", "HEAD") };
}

const skill = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const cli = (...args) => runCli(roots.env, args);
const ok = (...args) => {
  const result = cli(...args);
  assert.equal(result.status, 0, `${args.join(" ")} should succeed\n${result.output}`);
  return result.output;
};
const json = (...args) => {
  const result = cli(...args, "--json");
  assert.equal(result.status, 0, `${args.join(" ")} should succeed\n${result.output}`);
  return JSON.parse(result.stdout);
};
const lock = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(roots.stateRoot, "packages", "package-lock.json"), "utf8")).packages;
  } catch {
    return {};
  }
};
const sourcesFile = path.join(roots.stateRoot, "package-sources.json");

try {
  // ---------------------------------------------------------------------------------------------
  // Agent Skills folders: one package per skill, a collection when there are two or more.
  const skillsRepo = makeRepo("audit-skills", {
    "skills/audit-one/SKILL.md": skill("audit-one", "Audit one thing."),
    "skills/audit-one/check.cjs": "console.log('check');\n",
    "skills/audit-two/SKILL.md": skill("audit-two", "Audit another thing."),
    "README.md": "fixture\n",
  });
  const added = json("package", "source", "add", skillsRepo.url, "--id", "audits");
  assert.equal(added.source.trust, "unverified");
  assert.equal(added.source.tab, "third-party");
  assert.deepEqual(added.packages, ["audit-one", "audit-two"]);
  assert.deepEqual(lock(), {}, "adding a source installs nothing");

  const view = json("package", "list");
  const one = view.packages.find((row) => row.qualifiedName === "audits/audit-one");
  assert.ok(one && one.available && !one.installed && !one.active, `available, not installed: ${JSON.stringify(one)}`);
  assert.deepEqual(one.collection, { id: "audits", title: added.source.location.replace(/^file:\/\//, "") }, "two skill folders form a collection derived from the source");
  assert.equal(one.tab, "third-party");

  // Unverified: the summary is shown and a non-interactive install without --yes refuses.
  const refused = cli("package", "install", "audits/audit-one");
  assert.equal(refused.status, 4, `unconfirmed install exits 4\n${refused.output}`);
  assert.match(refused.output, /skills: audit-one/);
  assert.match(refused.output, /scripts: skills\/audit-one\/check\.cjs/, "the summary names the script before install");
  assert.deepEqual(lock(), {}, "a refused install writes nothing");

  ok("package", "install", "audits/audit-one", "--yes");
  const record = lock()["audit-one"];
  assert.equal(record.kind, "materialized");
  assert.equal(record.resolved, skillsRepo.first, "the lock pins the exact commit");
  assert.match(record.integrity, /^sha256-[0-9a-f]{64}$/);
  assert.ok(record.installedPath.startsWith(path.join(roots.stateRoot, "packages", "installed", "audits", skillsRepo.first)));
  assert.ok(fs.existsSync(path.join(record.installedPath, "skills", "audit-one", "SKILL.md")));
  assert.match(ok("package", "install", "audits/audit-one", "--yes"), /already installed/, "install is idempotent");

  // Install does not activate; enable does, from the installed copy.
  assert.ok(!json("package", "list").packages.find((row) => row.id === "audit-one").active);
  ok("package", "enable", "audit-one");
  assert.ok(json("package", "list").packages.find((row) => row.id === "audit-one").active);
  assert.ok(fs.existsSync(path.join(roots.stateRoot, "skills", "audit-one", "SKILL.md")), "the skill is installed from the copy");

  // The branch moves: nothing changes until an explicit refresh and update.
  const second = skillsRepo.commit({ "skills/audit-one/SKILL.md": skill("audit-one", "Audit one thing, better.") });
  assert.equal(lock()["audit-one"].resolved, skillsRepo.first);
  assert.ok(!json("package", "list").packages.find((row) => row.id === "audit-one").updateAvailable, "no network read before refresh");
  ok("package", "source", "refresh", "audits");
  assert.equal(lock()["audit-one"].resolved, skillsRepo.first, "refresh never moves an installed pin");
  assert.ok(json("package", "list").packages.find((row) => row.id === "audit-one").updateAvailable);
  const pending = cli("package", "update", "audit-one");
  assert.equal(pending.status, 4, `update shows the change and waits for confirmation\n${pending.output}`);
  assert.match(pending.output, /changed: .*skills\/audit-one\/SKILL\.md/);
  assert.equal(lock()["audit-one"].resolved, skillsRepo.first);
  const oldCopy = lock()["audit-one"].installedPath;
  // The branch moves again while the user reads the change for `second`: the confirmed update
  // still lands on `second`, the commit they saw.
  skillsRepo.commit({ "skills/audit-one/SKILL.md": skill("audit-one", "Unreviewed third change.") });
  const confirmedUpdate = runModules(roots.env, { svc: "scripts/cli/package-service.mjs", pk: "scripts/cli/packages.mjs" }, `
    const log = console.log; console.log = console.error;
    try { return await svc.updatePackage("audit-one", { confirmed: true, expectedRevision: ${JSON.stringify(second)}, reapply: pk.reapplyPackage }); }
    finally { console.log = log; }
  `);
  assert.ok(confirmedUpdate.ok, confirmedUpdate.error);
  const updated = confirmedUpdate.value;
  assert.equal(updated.to, second);
  assert.equal(updated.reapplied, true, "an active package is re-applied from its new copy");
  assert.equal(lock()["audit-one"].resolved, second);
  assert.ok(!fs.existsSync(oldCopy), "the previous copy is removed");
  assert.match(fs.readFileSync(path.join(roots.stateRoot, "skills", "audit-one", "SKILL.md"), "utf8"), /better/);

  // Offline: the repository disappears; the installed package still enables and lists, and a
  // refresh fails without losing the last listing.
  const offlineDir = `${skillsRepo.dir}-offline`;
  fs.renameSync(skillsRepo.dir, offlineDir);
  ok("package", "disable", "audit-one");
  ok("package", "enable", "audit-one");
  const failedRefresh = cli("package", "source", "refresh", "audits");
  assert.equal(failedRefresh.status, 5, `an unreachable source refresh exits 5\n${failedRefresh.output}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(roots.stateRoot, "packages", "catalogs", "audits.json"), "utf8")).revision, second, "the last good listing stays");
  fs.renameSync(offlineDir, skillsRepo.dir);

  // Remove: an active package is disabled first, then its copy and record go.
  const copy = lock()["audit-one"].installedPath;
  assert.match(ok("package", "remove", "audit-one"), /disabled first/);
  assert.ok(!lock()["audit-one"] && !fs.existsSync(copy));
  assert.ok(!fs.existsSync(path.join(roots.stateRoot, "skills", "audit-one")), "the removed package's skill is gone");

  // Removing a source with an installed package is refused; --keep-installed keeps it usable.
  ok("package", "install", "audits/audit-two", "--yes");
  assert.equal(cli("package", "source", "remove", "audits").status, 6);
  ok("package", "source", "remove", "audits", "--keep-installed");
  ok("package", "enable", "audit-two");
  const orphan = json("package", "list").packages.find((row) => row.id === "audit-two");
  assert.ok(orphan.installed && orphan.active && !orphan.available, `kept without a source: ${JSON.stringify(orphan)}`);
  // The orphan's source id cannot be reused for another repository, which would let an update
  // swap in that repository's content under the same name.
  const impostor = makeRepo("impostor", { "skills/audit-two/SKILL.md": skill("audit-two", "Not the original.") });
  const reused = cli("package", "source", "add", impostor.url, "--id", "audits");
  assert.equal(reused.status, 6, `reusing a source id for another repo is refused\n${reused.output}`);
  assert.match(reused.output, /still name source audits for another repository/);
  ok("package", "remove", "audit-two");

  // ---------------------------------------------------------------------------------------------
  // A Claude Code plugin is one package holding every skill.
  const pluginRepo = makeRepo("review-plugin", {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "review-kit", description: "Review helpers." }),
    "skills/review-a/SKILL.md": skill("review-a", "Review A."),
    "skills/review-b/SKILL.md": skill("review-b", "Review B."),
    "hooks/hooks.json": "{}",
  });
  const plugin = json("package", "source", "add", pluginRepo.url, "--id", "reviews");
  assert.deepEqual(plugin.packages, ["review-kit"]);
  const pluginPreview = cli("package", "install", "reviews/review-kit");
  assert.match(pluginPreview.output, /skills: review-a, review-b/);
  assert.match(pluginPreview.output, /plugin files not installed: plugin\/hooks\/hooks\.json/, "plugin hooks are named, not installed");
  // An update that drops a skill removes it from the harnesses, not just from the copy.
  ok("package", "install", "reviews/review-kit", "--yes");
  ok("package", "enable", "review-kit");
  assert.ok(fs.existsSync(path.join(roots.stateRoot, "skills", "review-b")));
  fs.rmSync(path.join(pluginRepo.dir, "skills", "review-b"), { recursive: true });
  pluginRepo.commit({});
  ok("package", "source", "refresh", "reviews");
  assert.match(ok("package", "update", "review-kit", "--yes"), /removed: [^\n]*skills\/review-b\/SKILL\.md[\s\S]*re-applied/);
  assert.ok(!fs.existsSync(path.join(roots.stateRoot, "skills", "review-b")), "the dropped skill is removed");
  assert.ok(!fs.existsSync(path.join(roots.home, ".claude", "skills", "review-b")), "and unlinked from the harness");
  assert.ok(fs.existsSync(path.join(roots.stateRoot, "skills", "review-a")), "the kept skill stays");
  ok("package", "remove", "review-kit");

  // A RoboRepo package keeps its own manifest; its hooks resource shows in the summary.
  const manifestRepo = makeRepo("robo-pack", {
    "packages/robo-hooked/package.config.json": JSON.stringify({
      schemaVersion: 1, id: "robo-hooked", label: "Robo Hooked", description: "A package with a hook.",
      presentation: { category: "integrations" },
      resources: [{ type: "hooks", harness: "claude", source: "hooks.json" }],
    }),
    "packages/robo-hooked/hooks.json": JSON.stringify({ hooks: {} }),
  });
  json("package", "source", "add", manifestRepo.url, "--id", "robo");
  assert.match(cli("package", "install", "robo/robo-hooked").output, /hooks: hooks\.json \(claude\)/);

  // ---------------------------------------------------------------------------------------------
  // The trusted catalog: an entry pins a reviewed commit even after the branch moved, installs
  // without a confirmation, and carries a Trusted badge.
  const trustedRepo = makeRepo("trusted-skill", { "SKILL.md": skill("trusted-skill", "A reviewed skill.") });
  const reviewed = trustedRepo.first;
  trustedRepo.commit({ "SKILL.md": skill("trusted-skill", "An unreviewed change.") });
  fs.writeFileSync(path.join(roots.appRoot, "manifests", "inventory", "trusted-package-sources.json"), JSON.stringify({
    schemaVersion: 1,
    entries: [{ repo: trustedRepo.url, commit: reviewed, description: "Fixture trusted repo." }],
  }));
  const trustedList = json("package", "source", "trusted");
  assert.equal(trustedList.length, 1);
  const trusted = json("package", "source", "add", trustedRepo.url, "--id", "vetted");
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.source.trust, "trusted");
  assert.equal(trusted.source.revision, reviewed, "a trusted source lists the reviewed commit, not the branch head");
  ok("package", "install", "vetted/trusted-skill");
  assert.equal(lock()["trusted-skill"].trust, "trusted");
  assert.equal(lock()["trusted-skill"].resolved, reviewed);
  const trustedRow = json("package", "list").packages.find((row) => row.id === "trusted-skill");
  assert.match(trustedRow.sourceBadge, /· Trusted$/);
  // A trusted package cannot be moved to any commit but the reviewed one.
  const offReview = runModules(roots.env, { svc: "scripts/cli/package-service.mjs" }, `
    try { await svc.updatePackage("trusted-skill", { confirmed: true, expectedRevision: ${JSON.stringify(trustedRepo.head())} }); return "moved"; }
    catch (err) { return err.code; }
  `);
  assert.ok(offReview.ok && offReview.value === "refused", JSON.stringify(offReview));
  // The repo leaves the trusted catalog: refresh refuses instead of moving to the unreviewed head.
  const trustedCatalogFile = path.join(roots.appRoot, "manifests", "inventory", "trusted-package-sources.json");
  const savedCatalog = fs.readFileSync(trustedCatalogFile, "utf8");
  fs.writeFileSync(trustedCatalogFile, JSON.stringify({ schemaVersion: 1, entries: [] }));
  const dropped = cli("package", "source", "refresh", "vetted");
  assert.equal(dropped.status, 5, `${dropped.output}`);
  assert.match(dropped.output, /no longer in the trusted catalog/);
  assert.equal(lock()["trusted-skill"].resolved, reviewed, "the installed pin stays on the reviewed commit");
  fs.writeFileSync(trustedCatalogFile, savedCatalog);

  // ---------------------------------------------------------------------------------------------
  // Same ID as a built-in package: a bare reference is ambiguous; a qualified one is the choice.
  writeRulesPackage(roots.builtInDir, "shared-name");
  const clashRepo = makeRepo("clash", { "skills/shared-name/SKILL.md": skill("shared-name", "Clashes with a built-in.") });
  json("package", "source", "add", clashRepo.url, "--id", "clash");
  const ambiguous = cli("package", "install", "shared-name");
  assert.equal(ambiguous.status, 3, `a bare ambiguous install exits 3\n${ambiguous.output}`);
  assert.match(ambiguous.output, /Multiple sources provide "shared-name":[\s\S]*builtin\/shared-name[\s\S]*clash\/shared-name/);
  ok("package", "install", "clash/shared-name", "--yes");
  const chosen = json("package", "list").packages.filter((row) => row.id === "shared-name" && row.installed);
  assert.deepEqual(chosen.map((row) => row.qualifiedName), ["clash/shared-name"], "the explicit choice is the package in the catalog");

  // ---------------------------------------------------------------------------------------------
  // A dependency from an unverified source is shown, hook included, before anything installs.
  const depsRepo = makeRepo("deps-pack", {
    "packages/dep-root/package.config.json": JSON.stringify({
      schemaVersion: 1, id: "dep-root", label: "Dep Root", description: "Requires dep-hooked.",
      presentation: { category: "integrations" }, requires: ["dep-hooked"],
      resources: [{ type: "rules", harness: "claude", source: "rules.md" }],
    }),
    "packages/dep-root/rules.md": "## Dep root\n",
    "packages/dep-hooked/package.config.json": JSON.stringify({
      schemaVersion: 1, id: "dep-hooked", label: "Dep Hooked", description: "Has a hook.",
      presentation: { category: "integrations" },
      resources: [{ type: "hooks", harness: "claude", source: "hooks.json" }],
    }),
    "packages/dep-hooked/hooks.json": JSON.stringify({ hooks: {} }),
  });
  json("package", "source", "add", depsRepo.url, "--id", "deps");
  const depPreview = cli("package", "install", "deps/dep-root");
  assert.equal(depPreview.status, 4, depPreview.output);
  assert.match(depPreview.output, /deps\/dep-hooked \(unverified\)[^\n]*contains:\n {2}hooks: hooks\.json \(claude\)/, `the dependency's hook is shown\n${depPreview.output}`);
  assert.ok(!lock()["dep-root"] && !lock()["dep-hooked"], "nothing installs unconfirmed");
  ok("package", "install", "deps/dep-root", "--yes");
  assert.ok(lock()["dep-root"] && lock()["dep-hooked"], "the dependency installs with its parent once confirmed");

  // Install never moves an installed pin, even after a refresh found a newer commit.
  const depsFirst = lock()["dep-root"].resolved;
  depsRepo.commit({ "packages/dep-root/rules.md": "## Dep root v2\n" });
  ok("package", "source", "refresh", "deps");
  const reinstall = ok("package", "install", "deps/dep-root", "--yes");
  assert.match(reinstall, /already installed[\s\S]*newer revision[\s\S]*roborepo package update dep-root/);
  assert.equal(lock()["dep-root"].resolved, depsFirst, "the pin stays until an explicit update");
  // The installed copy goes missing: the list says so, and reinstalling restores the pinned
  // commit, not the newer one the listing now shows.
  fs.rmSync(lock()["dep-root"].installedPath, { recursive: true, force: true });
  assert.match(ok("package", "list"), /unresolved: dep-root \(installed copy is missing/);
  ok("package", "install", "deps/dep-root", "--yes");
  assert.equal(lock()["dep-root"].resolved, depsFirst, "a repair reinstall keeps the pinned commit");
  assert.ok(fs.existsSync(path.join(lock()["dep-root"].installedPath, "package.config.json")));
  // A managed copy is not edited in place.
  const addSkill = cli("package", "dev", "add-skill", "dep-root", "extra-skill");
  assert.notEqual(addSkill.status, 0);
  assert.match(addSkill.output, /installed from deps; copy it into a local folder/);

  // A cache altered after refresh fails integrity at install and leaves the prior record alone.
  const robo = JSON.parse(fs.readFileSync(path.join(roots.stateRoot, "packages", "catalogs", "robo.json"), "utf8"));
  assert.match(robo.packages[0].integrity, /^sha256-/, "refresh records each package's content hash");
  fs.appendFileSync(path.join(roots.stateRoot, "packages", "cache", "robo", robo.revision, "packages", "robo-hooked", "hooks.json"), "\n");
  const tampered = cli("package", "install", "robo/robo-hooked", "--yes");
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.output, /integrity mismatch/);
  assert.ok(!lock()["robo-hooked"], "a failed integrity check writes no record");
  assert.ok(!fs.existsSync(path.join(roots.stateRoot, "packages", "installed", "robo")), "and leaves no copy");

  // A requirement already recorded from another source is never replaced by the requiring repo's
  // own package of that name; the install stops and asks for an explicit choice.
  writeRulesPackage(roots.builtInDir, "rec-dep");
  ok("package", "enable", "rec-dep");
  ok("package", "disable", "rec-dep");
  const recRepo = makeRepo("rec-pack", {
    "packages/needs-rec/package.config.json": JSON.stringify({
      schemaVersion: 1, id: "needs-rec", label: "Needs Rec", description: "Requires rec-dep.",
      presentation: { category: "integrations" }, requires: ["rec-dep"],
      resources: [{ type: "rules", harness: "claude", source: "rules.md" }],
    }),
    "packages/needs-rec/rules.md": "## Needs rec\n",
    "packages/rec-dep/package.config.json": JSON.stringify({
      schemaVersion: 1, id: "rec-dep", label: "Rec Dep", description: "Same name as a recorded built-in.",
      presentation: { category: "integrations" }, resources: [{ type: "rules", harness: "claude", source: "rules.md" }],
    }),
    "packages/rec-dep/rules.md": "## Rec dep from repo\n",
  });
  json("package", "source", "add", recRepo.url, "--id", "rec");
  const recInstall = cli("package", "install", "rec/needs-rec", "--yes");
  assert.equal(recInstall.status, 3, `a recorded requirement is not switched silently\n${recInstall.output}`);
  assert.match(recInstall.output, /recorded as builtin\/rec-dep and also offered as rec\/rec-dep/);
  assert.equal(lock()["rec-dep"].sourceId, "builtin");
  assert.ok(!lock()["needs-rec"], "nothing installs");

  // The contents summary names each config change by harness, operation, and setting, and lists
  // runtime assets that would be installed and run.
  const summary = runModules(roots.env, { g: "scripts/cli/package-source-git.mjs" }, `
    return g.formatContentsSummary(g.contentsSummary(${JSON.stringify(path.join(repoRoot, "globals", "packages", "usage-statusline"))}));
  `);
  assert.ok(summary.ok, summary.error);
  const summaryText = summary.value.join("\n");
  assert.match(summaryText, /config changes: [^\n]*claude: set statusLine \(status line\)/);
  assert.match(summaryText, /claude: union env\.CLAUDE_CODE_PLUGIN_DIRS/);
  assert.match(summaryText, /runtime assets: /);

  // ---------------------------------------------------------------------------------------------
  // Failures that must leave no state behind.
  const before = fs.readFileSync(sourcesFile, "utf8");
  const unreachable = cli("package", "source", "add", pathToFileURL(path.join(roots.tmp, "repos", "missing")).href, "--id", "gone");
  assert.equal(unreachable.status, 5, `an unreachable repo exits 5\n${unreachable.output}`);
  const invalid = cli("package", "source", "add", "https://gitlab.com/owner/repo");
  assert.equal(invalid.status, 2, `an unsupported URL exits 2\n${invalid.output}`);
  const linked = makeRepo("linked", { "skills/linked/SKILL.md": skill("linked", "Has a link.") });
  fs.symlinkSync("/etc/hosts", path.join(linked.dir, "skills", "linked", "hosts"));
  linked.commit({});
  const unsafe = cli("package", "source", "add", linked.url, "--id", "linked");
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.output, /symbolic link/);
  assert.equal(fs.readFileSync(sourcesFile, "utf8"), before, "failed adds write no source record");
  for (const id of ["gone", "linked"]) {
    assert.ok(!fs.existsSync(path.join(roots.stateRoot, "packages", "catalogs", `${id}.json`)), `no catalog for ${id}`);
    assert.ok(!fs.existsSync(path.join(roots.stateRoot, "packages", "cache", id)) || fs.readdirSync(path.join(roots.stateRoot, "packages", "cache", id)).length === 0, `no cache for ${id}`);
  }

  // The adapter contract holds for a git source too.
  const contract = runModules(roots.env, { s: "scripts/cli/package-sources.mjs", a: "scripts/cli/package-source-adapters.mjs", g: "scripts/cli/package-source-git.mjs" }, `
    const adapter = a.createSourceAdapter(s.findSource("vetted"));
    const resolution = adapter.resolve("trusted-skill");
    return { kind: adapter.kind, ids: adapter.list().map((e) => e.packageId), resolution, folder: adapter.materialize(resolution) };
  `);
  assert.ok(contract.ok, contract.error);
  assert.equal(contract.value.kind, "git");
  assert.deepEqual(contract.value.ids, ["trusted-skill"]);
  assert.equal(contract.value.resolution.resolved, reviewed);
  assert.ok(contract.value.folder.includes(path.join("packages", "cache", "vetted", reviewed)));
} finally {
  roots.restore();
  roots.cleanup();
}

console.log("ok: git package sources, trusted catalog, and install lifecycle");
