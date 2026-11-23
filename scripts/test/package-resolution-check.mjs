#!/usr/bin/env node
// The install lifecycle for live sources and the shared package view: a System package can be
// disabled but never removed; removing a Custom package forgets RoboRepo's record and leaves the
// user's folder; a built-in/workspace collision is settled by installing a qualified name; and the
// Config page view and `package list --json` both say which tab and source every package has.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSourceRoots, runCli, runModules, writeRulesPackage } from "./fixtures/package-sources.mjs";

const roots = makeSourceRoots("roborepo-package-resolution-");
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

try {
  writeRulesPackage(roots.builtInDir, "sys-pkg");
  writeRulesPackage(roots.workspaceDir, "my-pkg");
  const team = path.join(roots.tmp, "team");
  writeRulesPackage(team, "team-pkg");
  const added = json("package", "source", "add", team);
  assert.equal(added.source.id, "team");
  assert.equal(added.source.tab, "custom", "a local folder source is Custom");

  // Every package maps to exactly one tab, in the CLI view and the Config page view alike.
  const view = json("package", "list");
  const tabs = Object.fromEntries(view.packages.map((row) => [row.qualifiedName, row.tab]));
  assert.deepEqual(tabs, { "builtin/sys-pkg": "system", "local/my-pkg": "custom", "team/team-pkg": "custom" });
  assert.deepEqual(view.tabs.map((tab) => [tab.label, tab.count]), [["System", 1], ["Custom", 2], ["Third Party", 0]]);
  const config = runModules(roots.env, { cfg: "scripts/cli/config.mjs" }, `
    return cfg.readConfigSnapshot().behaviorView.flatMap((s) => s.items || []).filter((i) => i.toggle === "package")
      .map((i) => [i.id, i.tab, i.sourceId, i.sourceBadge]).sort();
  `);
  assert.ok(config.ok, config.error);
  assert.deepEqual(config.value, [["my-pkg", "custom", "local", "local"], ["sys-pkg", "system", "builtin", null], ["team-pkg", "custom", "team", "team"]]);

  // System: disable works, remove is refused with its exit code, active or not.
  ok("package", "enable", "sys-pkg");
  const refused = cli("package", "remove", "sys-pkg");
  assert.equal(refused.status, 6, `removing a System package exits 6\n${refused.output}`);
  assert.match(refused.output, /System package and cannot be removed/);
  ok("package", "disable", "sys-pkg");
  assert.equal(cli("package", "remove", "builtin/sys-pkg").status, 6, "refused when inactive too");

  // Custom: install records the folder in place; remove forgets it and leaves the folder.
  const installed = ok("package", "install", "team/team-pkg");
  assert.match(installed, /installed: team\/team-pkg in place at /);
  assert.equal(lock()["team-pkg"].kind, "live");
  ok("package", "enable", "team-pkg");
  assert.match(ok("package", "remove", "team-pkg"), /removed team\/team-pkg \(disabled first\)/);
  assert.ok(!lock()["team-pkg"], "the record is gone");
  assert.ok(fs.existsSync(path.join(team, "team-pkg", "package.config.json")), "the user's folder is untouched");
  assert.ok(json("package", "list").packages.some((row) => row.qualifiedName === "team/team-pkg"), "still available from its folder");

  // A built-in and a workspace package share an ID nobody chose yet: the catalog refuses to guess,
  // a bare install is ambiguous, and installing a qualified name records the choice.
  writeRulesPackage(roots.builtInDir, "fresh-pkg");
  writeRulesPackage(roots.workspaceDir, "fresh-pkg", { label: "Local fresh" });
  const collision = cli("package", "list");
  assert.notEqual(collision.status, 0);
  assert.match(collision.output, /fresh-pkg/);
  const ambiguous = cli("package", "install", "fresh-pkg");
  assert.equal(ambiguous.status, 3, `${ambiguous.output}`);
  assert.match(ambiguous.output, /builtin\/fresh-pkg[\s\S]*local\/fresh-pkg/);
  ok("package", "install", "local/fresh-pkg");
  assert.equal(lock()["fresh-pkg"].sourceId, "local");
  const chosen = json("package", "list").packages.filter((row) => row.id === "fresh-pkg");
  assert.deepEqual(chosen.map((row) => [row.qualifiedName, row.tab]), [["local/fresh-pkg", "custom"]]);

  // An ID applied earlier already has a recorded source, so a later same-ID package elsewhere does
  // not take it over and a bare reference keeps resolving to the recorded source.
  writeRulesPackage(roots.workspaceDir, "sys-pkg", { label: "Local sys" });
  assert.deepEqual(json("package", "list").packages.filter((row) => row.id === "sys-pkg").map((row) => row.qualifiedName), ["builtin/sys-pkg"]);
  assert.match(ok("package", "install", "sys-pkg"), /builtin\/sys-pkg/);

  // Source commands: unknown source and a default source's removal are refused with exit codes.
  assert.equal(cli("package", "source", "info", "nope").status, 2);
  assert.equal(cli("package", "source", "remove", "local").status, 6);
  assert.equal(cli("package", "source", "disable", "builtin").status, 6);
  ok("package", "source", "disable", "team");
  assert.ok(!json("package", "list").packages.some((row) => row.sourceId === "team"), "a disabled source offers nothing");
  ok("package", "source", "remove", "team");
  assert.ok(fs.existsSync(path.join(team, "team-pkg")), "removing a path source leaves its folder");
} finally {
  roots.cleanup();
}

console.log("ok: package install lifecycle for live sources and the shared package view");
