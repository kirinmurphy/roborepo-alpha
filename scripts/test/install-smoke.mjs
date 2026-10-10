#!/usr/bin/env node
// Health check for a LIVE roborepo installation — the thing to run right after `roborepo update`.
//
// Every other suite in this repo tests the code. This one tests the machine: whether what the repo
// says should be installed is actually installed, matches its source, and is registered where the
// harness will find it. Those are different questions, and the gap between them is where a silently
// half-applied update lives — an update that copies a hook but never registers it, or registers a
// package whose rules were never rendered, leaves every code-level test green.
//
// Read-only by design. It inspects ~/.claude, ~/.codex, and the roborepo state root and writes
// nothing, so it is safe to run against a working machine at any time.
//
// It reports every failure rather than stopping at the first: after an update you want the whole
// picture, not the earliest symptom. Exit code is 1 if anything failed.
//
// Not covered here: whether an installed skill's CONTENT is correct (that is the repo's own suites)
// and whether an agent OBEYS an installed rule (no test can assert that; it is
// verified by hand).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const home = os.homedir();
const stateRoot = process.env.ROBOREPO_STATE_ROOT || process.env.ROBOREPO_STATE_DIR || path.join(home, ".roborepo");

const results = [];
const check = (label, detail, ok) => results.push({ label, detail, ok });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// --- the CLI answers at all ------------------------------------------------------------------
//
// `version` is a subcommand, not a --flag: an unknown flag prints "unknown command" and still exits
// 0, so status alone proves nothing here. The reported version is what makes this a real check.
{
  const result = spawnSync("roborepo", ["version"], { encoding: "utf8" });
  const first = (result.stdout || "").trim().split("\n")[0];
  const ok = result.status === 0 && /^roborepo\s+\S+/.test(first);
  check("CLI responds", first || result.error?.message || "no output", ok);
}

// --- the install points at a real repo ---------------------------------------------------------
//
// install-state.json records the checkout an update installs FROM. A stale path here is why an
// update can report success while installing nothing the user expected: it read a different tree.
{
  const state = readJson(path.join(stateRoot, "install-state.json"));
  const repo = state?.repo;
  const exists = Boolean(repo) && fs.existsSync(path.join(repo, "package.json"));
  const sameAsThisCheckout = repo === repoRoot;
  check(
    "install source",
    !repo ? "install-state.json has no repo path"
      : !exists ? `${repo} (missing or not a checkout)`
        : sameAsThisCheckout ? repo
          : `${repo} — NOTE: not the checkout running this test (${repoRoot})`,
    exists,
  );
}

// --- enabled packages are real packages --------------------------------------------------------
//
// An id in enabled-packages.json that no longer exists in globals/packages means a rename or delete
// landed without migrating state; the package silently contributes nothing.
{
  const enabled = readJson(path.join(stateRoot, "enabled-packages.json"))?.packages || [];
  const packagesDir = path.join(repoRoot, "globals", "packages");
  const known = new Set(fs.existsSync(packagesDir) ? fs.readdirSync(packagesDir) : []);
  const orphans = enabled.filter((id) => !known.has(id));
  check(
    "enabled packages exist",
    orphans.length ? `${orphans.length} enabled id(s) missing from globals/packages: ${orphans.join(", ")}`
      : `${enabled.length} enabled, all present in globals/packages`,
    orphans.length === 0 && enabled.length > 0,
  );
}

// --- every hook script an enabled package declares is installed and current ---------------------
//
// The core assertion. Hook scripts are COPIED into the harness home rather than symlinked, so
// unlike skills they can silently go stale: the repo moves on and the installed copy does not.
// Comparing bytes is what makes "installed" mean "installed and current".
{
  const enabled = new Set(readJson(path.join(stateRoot, "enabled-packages.json"))?.packages || []);
  const harnessHome = { claude: path.join(home, ".claude"), codex: path.join(home, ".codex") };
  const expected = [];

  const packagesDir = path.join(repoRoot, "globals", "packages");
  for (const id of fs.existsSync(packagesDir) ? fs.readdirSync(packagesDir) : []) {
    if (!enabled.has(id)) continue;
    const config = readJson(path.join(packagesDir, id, "package.config.json"));
    for (const resource of config?.resources || []) {
      if (resource.type !== "hooks" || !resource.scripts?.length) continue;
      const harnesses = resource.harness === "both" ? ["claude", "codex"] : [resource.harness];
      for (const harness of harnesses) {
        for (const script of resource.scripts) {
          expected.push({
            id,
            harness,
            source: path.join(packagesDir, id, script),
            installed: path.join(harnessHome[harness], "hooks", path.basename(script)),
          });
        }
      }
    }
  }

  const missing = [];
  const stale = [];
  for (const item of expected) {
    if (!fs.existsSync(item.installed)) {
      missing.push(`${item.harness}:${path.basename(item.installed)} (${item.id})`);
      continue;
    }
    const same = fs.readFileSync(item.source).equals(fs.readFileSync(item.installed));
    if (!same) stale.push(`${item.harness}:${path.basename(item.installed)} (${item.id})`);
  }

  const problems = [...missing.map((m) => `missing ${m}`), ...stale.map((s) => `stale ${s}`)];
  check(
    "package hook scripts installed",
    problems.length ? problems.join("; ")
      : expected.length ? `${expected.length} script(s) installed and byte-identical to source`
        : "no enabled package ships hook scripts",
    problems.length === 0,
  );
}

// --- installed hook scripts are registered with the harness -------------------------------------
//
// A copied script that no settings file references never runs. This is the half-applied update that
// looks completely healthy from the filesystem alone.
{
  const settings = readJson(path.join(home, ".claude", "settings.json"));
  const registered = JSON.stringify(settings?.hooks || {});
  const hooksDir = path.join(home, ".claude", "hooks");
  const installed = fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir).filter((f) => f.endsWith(".mjs")) : [];
  const unreferenced = installed.filter((file) => !registered.includes(file));
  check(
    "hook scripts registered",
    unreferenced.length ? `installed but referenced by no hook entry: ${unreferenced.join(", ")}`
      : `${installed.length} script(s) referenced from settings.json`,
    unreferenced.length === 0 && installed.length > 0,
  );
}

// --- rules from enabled packages reached the rendered rules file --------------------------------
//
// Rules are generated INTO the harness home rather than linked, so a package can be enabled while
// its rules were never re-rendered. Matching on each package's own heading keeps this honest: a
// non-empty CLAUDE.md is not evidence that any particular package contributed to it.
{
  const enabled = new Set(readJson(path.join(stateRoot, "enabled-packages.json"))?.packages || []);
  const rendered = (() => {
    try {
      return fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
    } catch {
      return "";
    }
  })();

  const packagesDir = path.join(repoRoot, "globals", "packages");
  const absent = [];
  let rulePackages = 0;
  for (const id of fs.existsSync(packagesDir) ? fs.readdirSync(packagesDir) : []) {
    if (!enabled.has(id)) continue;
    const config = readJson(path.join(packagesDir, id, "package.config.json"));
    const rules = (config?.resources || []).find((resource) => resource.type === "rules");
    if (!rules) continue;
    rulePackages += 1;
    // The rules fragment's own H2 is what lands in the rendered file, so it is the honest marker.
    const source = (() => {
      try {
        return fs.readFileSync(path.join(packagesDir, id, rules.source), "utf8");
      } catch {
        return "";
      }
    })();
    const heading = /^##\s+(.+)$/m.exec(source)?.[1];
    if (heading && !rendered.includes(heading)) absent.push(`${id} ("${heading}")`);
  }

  check(
    "package rules rendered",
    absent.length ? `enabled but absent from CLAUDE.md: ${absent.join(", ")}`
      : `${rulePackages} rule-shipping package(s) present in CLAUDE.md`,
    absent.length === 0 && rendered.length > 0,
  );
}

// --- skill symlinks resolve ---------------------------------------------------------------------
//
// Skills are symlinked into the harness home from the roborepo cache. A dangling link is what a
// half-finished update or a moved cache leaves behind, and the harness reports it as a missing
// skill rather than a broken link.
for (const harness of ["claude", "codex"]) {
  const skillsDir = path.join(home, `.${harness}`, "skills");
  if (!fs.existsSync(skillsDir)) {
    check(`${harness} skill links`, "no skills directory", true);
    continue;
  }
  const entries = fs.readdirSync(skillsDir);
  const broken = entries.filter((entry) => !fs.existsSync(path.join(skillsDir, entry)));
  check(
    `${harness} skill links`,
    broken.length ? `${broken.length} dangling: ${broken.join(", ")}` : `${entries.length} resolve`,
    broken.length === 0,
  );
}

// --- report --------------------------------------------------------------------------------------
const width = Math.max(...results.map((r) => r.label.length));
console.log("\nroborepo smoke: live install\n");
for (const { label, detail, ok } of results) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(width)}  ${detail}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed${failed.length ? `, ${failed.length} failed` : ""}\n`);
if (failed.length) {
  console.log("A failure here is about this machine, not the repository. Re-run `roborepo update`, then this check.\n");
  process.exit(1);
}
