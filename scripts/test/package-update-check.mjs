#!/usr/bin/env node
// Install, update, and remove of git-sourced packages when state moves underneath them, against
// local fixture repositories (file:// URLs). Covers: a confirmed install bound to the plan the user
// saw; an install of an already-pinned package planned from its installed copy; a confirmed update
// bound to its shown starting revision and to the refreshed listing; an update whose re-apply
// fails rolling back; an update applying a newly required package and removing hooks and config
// patches the new revision dropped; update restoring a missing copy at its pin; removal and the
// package view when a local override shadows a recorded git copy; `available` cleared when a
// source drops an installed package; a folder source refused an id a kept git install still
// names; a failed bulk refresh exiting non-zero under --json; reinstalling a pinned package whose
// copy was deleted, previewed at its pin; and removing an enabled package left unresolved by a
// missing requirement.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isolateGitConfig } from "./lib/git-config.mjs";
import { liveClaudeRules, makeSourceRoots, runCli, runModules, writeReplaceOverride, writeRulesPackage } from "./fixtures/package-sources.mjs";

const roots = (() => {
  const made = makeSourceRoots("roborepo-package-update-");
  const restore = isolateGitConfig(made.tmp);
  // The child processes see the isolated Git config, not the runner's injected settings.
  const env = Object.fromEntries(Object.entries(made.env).filter(([key]) => !key.startsWith("GIT_CONFIG")));
  return { ...made, env: { ...env, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: "1" }, restore };
})();

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    if (content === null) {
      fs.rmSync(file, { recursive: true, force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

// A repository with one commit; `commit(files)` writes (or, for a null value, deletes) files and
// commits, returning the new SHA.
function makeRepo(name, files) {
  const dir = path.join(roots.tmp, "repos", name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  const commit = (next) => {
    writeFiles(dir, next);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", "fixture");
    return git(dir, "rev-parse", "HEAD");
  };
  const first = commit(files);
  return { dir, url: pathToFileURL(dir).href, first, commit };
}

const manifest = (id, extra = {}) => JSON.stringify({
  schemaVersion: 1,
  id,
  label: `Upd ${id}`,
  description: `Update fixture ${id}.`,
  presentation: { category: "integrations" },
  ...extra,
});
const rulesOnly = (id, text = `## Upd rules ${id}\n`) => ({
  [`packages/${id}/package.config.json`]: manifest(id, { resources: [{ type: "rules", harness: "claude", source: "rules.md" }] }),
  [`packages/${id}/rules.md`]: text,
});

const cli = (...args) => runCli(roots.env, args);
const ok = (...args) => {
  const result = cli(...args);
  assert.equal(result.status, 0, `${args.join(" ")} should succeed\n${result.output}`);
  return result.output;
};
const view = () => {
  const result = cli("package", "list", "--json");
  assert.equal(result.status, 0, result.output);
  return JSON.parse(result.stdout).packages;
};
const lock = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(roots.stateRoot, "packages", "package-lock.json"), "utf8")).packages;
  } catch {
    return {};
  }
};
const claudeSettings = () => JSON.parse(fs.readFileSync(path.join(roots.home, ".claude", "settings.json"), "utf8"));
const service = (body) => runModules(roots.env, { svc: "scripts/cli/package-service.mjs", pk: "scripts/cli/packages.mjs" }, `
  const log = console.log; console.log = console.error;
  try { ${body} } finally { console.log = log; }
`);

try {
  // ---------------------------------------------------------------------------------------------
  // Revision A: `tool` registers a Claude hook and a config patch; `other` has rules only.
  const toolA = {
    "packages/tool/package.config.json": manifest("tool", {
      resources: [
        { type: "rules", harness: "claude", source: "rules.md" },
        { type: "hooks", harness: "claude", source: "hooks.json" },
        { type: "config-patch", harness: "claude", label: "permissions", patches: [{ op: "union", path: ["permissions", "allow"], value: ["UpdFixtureDroppedPermission"] }] },
      ],
    }),
    "packages/tool/rules.md": "## Upd tool v1\n",
    "packages/tool/hooks.json": JSON.stringify({ SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo upd-dropped-hook" }] }] }),
  };
  const team = makeRepo("team", { ...toolA, ...rulesOnly("other") });
  const revA = team.first;
  ok("package", "source", "add", team.url, "--id", "team");
  ok("package", "install", "team/tool", "--yes");
  ok("package", "enable", "tool");
  assert.match(JSON.stringify(claudeSettings().hooks || {}), /upd-dropped-hook/, "the hook is applied");
  assert.ok(claudeSettings().permissions?.allow?.includes("UpdFixtureDroppedPermission"), "the config patch is applied");

  // A confirmed install is bound to the plan the user saw: the source moving between the preview
  // and the install asks again instead of installing the unseen revision.
  const preview = service(`return svc.previewInstall("team/other");`);
  assert.ok(preview.ok, preview.error);
  assert.deepEqual(preview.value.plan, [{ qualifiedName: "team/other", revision: revA }]);

  // Revision B: `tool` gains a requirement no source offers.
  const toolB = {
    "packages/tool/package.config.json": manifest("tool", {
      requires: ["upd-ghost"],
      resources: [{ type: "rules", harness: "claude", source: "rules.md" }],
    }),
  };
  const revB = team.commit({ ...toolB, "packages/other/rules.md": "## Upd rules other v2\n" });
  ok("package", "source", "refresh", "team");
  const staleInstall = service(`
    try { svc.installPackage("team/other", { confirmed: true, expectedPlan: ${JSON.stringify(preview.value.plan)} }); return "installed"; }
    catch (err) { return { code: err.code, planChanged: err.details?.planChanged ?? false }; }
  `);
  assert.ok(staleInstall.ok, staleInstall.error);
  assert.deepEqual(staleInstall.value, { code: "confirmationRequired", planChanged: true }, "a changed plan needs a new confirmation");
  assert.ok(!lock().other, "nothing installs from a plan the user did not see");

  // Installing the already-pinned `tool` keeps revision A, so B's missing requirement does not
  // apply to it.
  const pinnedInstall = cli("package", "install", "team/tool", "--yes");
  assert.equal(pinnedInstall.status, 0, `an install that keeps the pin plans from the installed copy\n${pinnedInstall.output}`);
  assert.match(pinnedInstall.output, /already installed: team\/tool/);
  assert.equal(lock().tool.resolved, revA);

  // Revision C: `tool` requires a built-in package and drops its hook and config patch.
  // Rules render for every effective package, so the dependency's config patch is what shows it
  // was applied.
  writeRulesPackage(roots.builtInDir, "upd-dep", {
    resources: [
      { type: "rules", harness: "claude", source: "rules.md" },
      { type: "config-patch", harness: "claude", label: "permissions", patches: [{ op: "union", path: ["permissions", "allow"], value: ["UpdFixtureDepPermission"] }] },
    ],
  });
  const revC = team.commit({
    "packages/tool/package.config.json": manifest("tool", {
      requires: ["upd-dep"],
      resources: [{ type: "rules", harness: "claude", source: "rules.md" }],
    }),
    "packages/tool/rules.md": "## Upd tool v3\n",
    "packages/tool/hooks.json": null,
  });
  ok("package", "source", "refresh", "team");
  const copyA = lock().tool.installedPath;

  // A confirmed update is bound to the starting revision it showed.
  const movedFrom = service(`
    try { await svc.updatePackage("tool", { confirmed: true, expectedRevision: ${JSON.stringify(revC)}, expectedFrom: ${JSON.stringify(revB)}, reapply: pk.reapplyPackage }); return "updated"; }
    catch (err) { return { code: err.code, from: err.details?.change?.from ?? null }; }
  `);
  assert.ok(movedFrom.ok, movedFrom.error);
  assert.deepEqual(movedFrom.value, { code: "confirmationRequired", from: revA }, "a different starting revision asks again with the current change");
  assert.equal(lock().tool.resolved, revA, "the pin stays");

  // A refresh landing between the update's own refresh and its read of the listing must not swap
  // in another revision. The catalog read is redirected to C's listing once the update has
  // written B's.
  const catalogFile = path.join(roots.stateRoot, "packages", "catalogs", "team.json");
  const catalogC = fs.readFileSync(catalogFile, "utf8");
  const raced = runModules(roots.env, { svc: "scripts/cli/package-service.mjs" }, `
    const fs = (await import("node:fs")).default;
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
      const out = read.call(fs, file, ...rest);
      if (String(file) === ${JSON.stringify(catalogFile)} && String(out).includes(${JSON.stringify(revB)})) {
        return typeof out === "string" ? ${JSON.stringify(catalogC)} : Buffer.from(${JSON.stringify(catalogC)});
      }
      return out;
    };
    try { await svc.updatePackage("tool", { confirmed: true, expectedRevision: ${JSON.stringify(revB)} }); return "updated"; }
    catch (err) { return err.code; }
  `);
  assert.ok(raced.ok, raced.error);
  assert.equal(raced.value, "refused", "an update refuses a listing that moved during the update");
  assert.equal(lock().tool.resolved, revA, "nothing moved");

  // A failed re-apply rolls the update back: the old record and copy stay, and a retry updates.
  const failed = service(`
    try { await svc.updatePackage("tool", { confirmed: true, expectedRevision: ${JSON.stringify(revC)}, reapply: async () => { throw new Error("fixture re-apply failure"); } }); return "updated"; }
    catch (err) { return { code: err.code, message: err.message }; }
  `);
  assert.ok(failed.ok, failed.error);
  assert.equal(failed.value.code, "invalid", JSON.stringify(failed.value));
  assert.match(failed.value.message, /fixture re-apply failure/);
  assert.equal(lock().tool.resolved, revA, "the lock is rolled back to the previous revision");
  assert.ok(fs.existsSync(copyA), "the previous copy is kept");
  assert.ok(!fs.existsSync(path.join(roots.stateRoot, "packages", "installed", "team", revC)), "the new copy is removed");

  // The update applies the newly required package and removes what C no longer declares.
  const updated = ok("package", "update", "tool", "--yes");
  assert.match(updated, /re-applied/);
  assert.equal(lock().tool.resolved, revC);
  assert.ok(!fs.existsSync(copyA), "the previous copy goes once the update succeeds");
  assert.ok(claudeSettings().permissions?.allow?.includes("UpdFixtureDepPermission"), "the new requirement is applied");
  assert.ok(JSON.parse(fs.readFileSync(path.join(roots.stateRoot, "applied-packages.json"), "utf8")).packages.includes("upd-dep"), "and recorded as applied");
  assert.match(liveClaudeRules(roots.home), /Upd tool v3/);
  assert.doesNotMatch(JSON.stringify(claudeSettings().hooks || {}), /upd-dropped-hook/, "the dropped hook is removed");
  assert.ok(!(claudeSettings().permissions?.allow || []).includes("UpdFixtureDroppedPermission"), "the dropped config patch is removed");

  // A missing copy at an unchanged pin is restored by update, even with its cache gone.
  const copyC = lock().tool.installedPath;
  fs.rmSync(copyC, { recursive: true, force: true });
  fs.rmSync(path.join(roots.stateRoot, "packages", "cache", "team", revC), { recursive: true, force: true });
  assert.match(ok("package", "update", "tool", "--yes"), /restored the missing installed copy/);
  assert.equal(lock().tool.resolved, revC, "the pin does not move");
  assert.ok(fs.existsSync(path.join(copyC, "package.config.json")), "the copy is back");

  // ---------------------------------------------------------------------------------------------
  // A local replace override shadows the recorded, active git copy.
  writeRulesPackage(roots.workspaceDir, "tool", { marker: "local" });
  writeReplaceOverride(roots.workspace, ["tool"]);
  const shadowed = view().filter((row) => row.id === "tool");
  assert.equal(shadowed.find((row) => row.sourceId === "team")?.active, false, `the shadowed git row is not active: ${JSON.stringify(shadowed)}`);
  assert.equal(shadowed.find((row) => row.sourceId === "local")?.active, true, "the effective local row is active");
  // Re-applying the override (reconcile applies every enabled package) keeps the git record.
  ok("package", "reconcile");
  assert.equal(lock().tool?.sourceId, "team", "applying the override does not overwrite the git record");
  assert.ok(fs.existsSync(copyC), "the git copy is still recorded and present");
  const wrongSource = cli("package", "remove", "local/tool");
  assert.equal(wrongSource.status, 2, `removal follows the lock record, not the override\n${wrongSource.output}`);
  assert.equal(lock().tool?.sourceId, "team", "the git record stays");
  const removedShadow = ok("package", "remove", "team/tool");
  assert.doesNotMatch(removedShadow, /disabled first/, "the local override is not disabled");
  assert.ok(!lock().tool && !fs.existsSync(copyC), "the git record and copy go");
  assert.equal(view().find((row) => row.id === "tool")?.active, true, "the local package stays active");

  // ---------------------------------------------------------------------------------------------
  // A source whose new revision drops an installed package: the copy stays installed but is no
  // longer available.
  const drop = makeRepo("drop", { ...rulesOnly("drop-keep"), ...rulesOnly("drop-gone") });
  ok("package", "source", "add", drop.url, "--id", "drop");
  ok("package", "install", "drop/drop-gone", "--yes");
  drop.commit({ "packages/drop-gone": null });
  ok("package", "source", "refresh", "drop");
  const gone = view().find((row) => row.qualifiedName === "drop/drop-gone");
  assert.ok(gone?.installed, `still installed: ${JSON.stringify(gone)}`);
  assert.equal(gone.available, false, "no longer available from its source");

  // ---------------------------------------------------------------------------------------------
  // A kept git install reserves its source id against a folder source.
  const kept = makeRepo("kept", rulesOnly("kept-tool"));
  ok("package", "source", "add", kept.url, "--id", "kept");
  ok("package", "install", "kept/kept-tool", "--yes");
  ok("package", "source", "remove", "kept", "--keep-installed");
  const folder = path.join(roots.tmp, "kept-folder");
  writeRulesPackage(folder, "kept-tool");
  const reusedByFolder = cli("package", "source", "add", folder, "--id", "kept");
  assert.equal(reusedByFolder.status, 6, `a folder cannot take a kept git install's source id\n${reusedByFolder.output}`);
  assert.match(reusedByFolder.output, /still name source kept/);
  ok("package", "source", "add", kept.url, "--id", "kept");

  // ---------------------------------------------------------------------------------------------
  // A failed source in a bulk refresh fails the --json run too, and the JSON still lists it.
  fs.renameSync(drop.dir, `${drop.dir}-offline`);
  const bulk = cli("package", "source", "refresh", "--json");
  assert.equal(bulk.status, 5, `a failed refresh exits 5 under --json\n${bulk.output}`);
  const rows = JSON.parse(bulk.stdout);
  assert.ok(rows.some((row) => row.id === "drop" && row.error), JSON.stringify(rows));
  assert.ok(rows.some((row) => row.id === "team" && !row.error), "the other sources still refresh");

  // ---------------------------------------------------------------------------------------------
  // Reinstalling a pinned package whose copy was deleted previews and restores the pinned
  // revision, not the newer listing and the requirements only that listing adds.
  const pin = makeRepo("pin", rulesOnly("pin-tool", "## Upd pin v1\n"));
  ok("package", "source", "add", pin.url, "--id", "pin");
  ok("package", "install", "pin/pin-tool", "--yes");
  pin.commit({
    "packages/pin-tool/package.config.json": manifest("pin-tool", { requires: ["pin-extra"], resources: [{ type: "rules", harness: "claude", source: "rules.md" }] }),
    "packages/pin-tool/extra.sh": "#!/bin/sh\n",
    ...rulesOnly("pin-extra"),
  });
  ok("package", "source", "refresh", "pin");
  fs.rmSync(lock()["pin-tool"].installedPath, { recursive: true, force: true });
  const restored = ok("package", "install", "pin/pin-tool", "--yes");
  assert.match(restored, new RegExp(`pin/pin-tool \\(unverified\\) at ${pin.first.slice(0, 12)}`), `the preview names the pinned revision\n${restored}`);
  assert.doesNotMatch(restored, /extra\.sh|pin-extra/, "the preview shows the pinned revision's contents only");
  assert.equal(lock()["pin-tool"].resolved, pin.first, "the pin does not move");
  assert.ok(!lock()["pin-extra"], "a requirement only the newer revision has is not installed");

  // Removing an enabled package that left the catalog because a package it requires became
  // unresolved takes out what it registered, from its own copy.
  const strand = makeRepo("strand", {
    "packages/strand-top/package.config.json": manifest("strand-top", { requires: ["strand-base"], resources: [{ type: "rules", harness: "claude", source: "rules.md" }] }),
    "packages/strand-top/rules.md": "## Upd strand top\n",
    ...rulesOnly("strand-base"),
  });
  ok("package", "source", "add", strand.url, "--id", "strand");
  ok("package", "install", "strand/strand-top", "--yes");
  ok("package", "enable", "strand-top");
  assert.match(liveClaudeRules(roots.home), /Upd strand top/);
  fs.rmSync(lock()["strand-base"].installedPath, { recursive: true, force: true });
  const removedStranded = ok("package", "remove", "strand-top");
  assert.match(removedStranded, /disabled first/, removedStranded);
  assert.doesNotMatch(liveClaudeRules(roots.home), /Upd strand top/, "its rules are removed from the harness");
  assert.ok(!lock()["strand-top"], "its record goes");
  const registryAfter = JSON.parse(fs.readFileSync(path.join(roots.stateRoot, "enabled-packages.json"), "utf8"));
  assert.ok(!registryAfter.packages.includes("strand-top"), "its selection goes");

  // A package still recorded as applied whose own files are missing, from a source that is gone,
  // is still removable: it goes with a warning instead of staying stuck.
  ok("package", "source", "remove", "strand", "--keep-installed");
  const appliedIds = () => JSON.parse(fs.readFileSync(path.join(roots.stateRoot, "applied-packages.json"), "utf8")).packages;
  assert.ok(appliedIds().includes("strand-base"), "the requirement was applied with its root");
  const removedMissing = cli("package", "remove", "strand-base");
  assert.equal(removedMissing.status, 0, `a package with missing files can be removed\n${removedMissing.output}`);
  assert.match(removedMissing.output, /could not be removed/, "and the user is told what may remain");
  assert.ok(!lock()["strand-base"], "its record goes");
  assert.ok(!appliedIds().includes("strand-base"), "it is no longer recorded as applied");

  // An enabled package whose own copy was deleted is turned off from its pinned revision in the
  // source's cache, hooks included; --json output stays clean.
  const goneRepo = makeRepo("gone", {
    "packages/gone-tool/package.config.json": manifest("gone-tool", {
      resources: [
        { type: "rules", harness: "claude", source: "rules.md" },
        { type: "hooks", harness: "claude", source: "hooks.json" },
      ],
    }),
    "packages/gone-tool/rules.md": "## Upd gone tool\n",
    "packages/gone-tool/hooks.json": JSON.stringify({ SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo upd-gone-hook" }] }] }),
  });
  ok("package", "source", "add", goneRepo.url, "--id", "gone");
  ok("package", "install", "gone/gone-tool", "--yes");
  ok("package", "enable", "gone-tool");
  assert.match(JSON.stringify(claudeSettings().hooks || {}), /upd-gone-hook/, "the hook is applied");
  fs.rmSync(lock()["gone-tool"].installedPath, { recursive: true, force: true });
  const removedGone = cli("package", "remove", "gone-tool", "--json");
  assert.equal(removedGone.status, 0, removedGone.output);
  const goneResult = JSON.parse(removedGone.stdout);
  assert.equal(goneResult.removed, true);
  assert.equal(goneResult.warning, undefined, "the cached revision supplied its files");
  assert.doesNotMatch(JSON.stringify(claudeSettings().hooks || {}), /upd-gone-hook/, "its hook is removed");
  assert.doesNotMatch(liveClaudeRules(roots.home), /Upd gone tool/, "its rules are removed");

  // An enabled folder package whose source was disabled is turned off from its recorded folder,
  // hooks included, without claiming its files are missing.
  const liveDir = path.join(roots.tmp, "live-folder");
  const livePkg = path.join(liveDir, "live-tool");
  writeFiles(livePkg, {
    "package.config.json": manifest("live-tool", {
      resources: [
        { type: "rules", harness: "claude", source: "rules.md" },
        { type: "hooks", harness: "claude", source: "hooks.json" },
      ],
    }),
    "rules.md": "## Upd live tool\n",
    "hooks.json": JSON.stringify({ SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo upd-live-hook" }] }] }),
  });
  ok("package", "source", "add", liveDir, "--id", "livesrc");
  ok("package", "install", "livesrc/live-tool", "--yes");
  ok("package", "enable", "live-tool");
  assert.match(JSON.stringify(claudeSettings().hooks || {}), /upd-live-hook/, "the folder package's hook is applied");
  ok("package", "source", "disable", "livesrc");
  const removedLive = ok("package", "remove", "live-tool");
  assert.doesNotMatch(removedLive, /missing/, `the recorded folder supplies its files\n${removedLive}`);
  assert.doesNotMatch(JSON.stringify(claudeSettings().hooks || {}), /upd-live-hook/, "its hook is removed");
  assert.doesNotMatch(liveClaudeRules(roots.home), /Upd live tool/, "its rules are removed");
  assert.ok(fs.existsSync(path.join(livePkg, "hooks.json")), "the user's folder is never touched");
} finally {
  roots.restore();
  roots.cleanup();
}

console.log("ok: package install, update, and remove under moving state");
