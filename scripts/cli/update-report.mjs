import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { packageMode, repoRoot, harnessHome } from "./paths.mjs";
import { enabledPackagesPath, stateSkillsDir } from "./state-paths.mjs";
import { buildLocalConfigRepairPlans } from "./local-config-repair.mjs";
import { findOrphanSkillLinks } from "./skill-prune-orphans.mjs";

const HARNESS_HOME = harnessHome;

const MANAGED_MARKER = ".builtin-managed";

const DRY_RUN_VERBS = { added: "add", updated: "update", removed: "remove", linked: "link", unlinked: "unlink" };

export async function runUpdateWithReport(commandConfig, args) {
  const { installArgs, verbose } = parseReportArgs(args);
  const dryRun = installArgs.includes("--dry-run");
  const before = snapshotInstallState();
  const result = runInstall(commandConfig, installArgs, { verbose });
  const installOutput = `${result.stdout || ""}${result.stderr || ""}`;
  if (!verbose && result.status !== 0) {
    process.stdout.write(installOutput);
  }
  if (result.status === 0) {
    if (!dryRun) await refreshLivePermissions({ verbose });
    const after = dryRun ? projectDryRunState(before) : snapshotInstallState();
    printUpdateReport(before, after, { verbose, installOutput, dryRun });
    if (!dryRun) await printChangedHookReviewHint(before.hooks, after.hooks);
  }
  process.exit(result.status ?? 1);
}

// An update that rewrote a harness's hook files can leave RoboRepo hooks awaiting review.
async function printChangedHookReviewHint(before, after) {
  const previous = new Map(before.map((row) => [row.key, row.digest]));
  const harnesses = after.filter((row) => previous.get(row.key) !== row.digest).map((row) => row.key.split(":")[0]);
  if (harnesses.length === 0) return;
  const [{ readinessSupported }, { printHookReviewHint }] = await Promise.all([
    import("../harnesses/hook-readiness.mjs"), import("./hook-review-guidance.mjs"),
  ]);
  await printHookReviewHint(harnesses.filter(readinessSupported));
}

async function refreshLivePermissions({ verbose = false } = {}) {
  const { readCommandOverrides } = await import("./config-mutate.mjs");
  const { renderPermissionsToHome } = await import("./permissions-render.mjs");
  const { touched } = renderPermissionsToHome({ overrides: readCommandOverrides(), cwd: process.cwd() });
  if (verbose) {
    for (const file of touched) console.log(`permissions: ${file}`);
  }
}

function parseReportArgs(args) {
  const installArgs = [];
  let verbose = process.env.UPDATE_VERBOSE === "1";
  for (const arg of args) {
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    installArgs.push(arg);
  }
  return { installArgs, verbose };
}

function runInstall(commandConfig, args, { verbose = false } = {}) {
  if (!commandConfig?.path || commandConfig.runtime !== "bash") {
    console.error("invalid update command config");
    process.exit(1);
  }

  const script = path.join(repoRoot, commandConfig.path);
  if (!fs.existsSync(script)) {
    console.error(`missing script: ${script}`);
    process.exit(1);
  }

  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    stdio: verbose ? "inherit" : "pipe",
    env: { ...process.env, ...(packageMode ? { ROBOREPO_PACKAGE_MODE: "1" } : {}) },
  });
  if (result.error) {
    console.error(`failed to run ${commandConfig.path}: ${result.error.message}`);
    process.exit(1);
  }
  return result;
}

function snapshotInstallState() {
  const rows = readManifestRows();
  return {
    copied: snapshotManifestRows(rows, "managed_copy"),
    rootConfig: snapshotManifestRows(rows, "root_config"),
    renderedRules: snapshotManifestRows(rows, "rendered_rules"),
    hooks: snapshotNamedRows(rows, new Set(["hooks", "hooks.json"])),
    permissions: snapshotNamedRows(rows, new Set(["rules"])),
    packageRegistry: fileDigest(enabledPackagesPath),
    skills: snapshotSkillBodies(),
    skillLinks: snapshotManagedSkills(),
  };
}

function readManifestRows() {
  const manifest = path.join(repoRoot, "manifests", "platform", "manifest.tsv");
  const lines = fs.readFileSync(manifest, "utf8").split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [harness, kind, srcRel, homeSub] = line.split("\t");
    if (!HARNESS_HOME[harness] || !kind || !homeSub) continue;
    rows.push({
      harness,
      kind,
      srcRel,
      homeSub,
      homeAbs: path.join(HARNESS_HOME[harness], homeSub),
    });
  }
  return rows;
}

function snapshotManifestRows(rows, kind) {
  return rows
    .filter((row) => row.kind === kind)
    .map((row) => ({
      key: `${row.harness}:${row.homeSub}`,
      label: labelForRow(row),
      digest: pathDigest(row.homeAbs),
    }));
}

function snapshotNamedRows(rows, names) {
  return rows
    .filter((row) => names.has(row.homeSub))
    .map((row) => ({
      key: `${row.harness}:${row.homeSub}`,
      label: labelForRow(row),
      digest: pathDigest(row.homeAbs),
    }));
}

function labelForRow(row) {
  if (row.kind === "rendered_rules") return `rules ${row.harness}`;
  if (row.kind === "root_config") return `root config ${row.harness}`;
  if (row.homeSub === "hooks" || row.homeSub === "hooks.json") return `hooks ${row.harness}`;
  if (row.homeSub === "rules") return `permissions ${row.harness}`;
  return `${row.homeSub.replaceAll("/", " ")} ${row.harness}`;
}

// There is exactly one copy of each skill body, in <state>/skills/<name>. A harness never gets its
// own copy — it gets a symlink pointing back here. So "a skill changed" is a fact about this dir
// alone, and is snapshotted separately from the per-harness pointers below.
function snapshotSkillBodies() {
  const entries = [];
  if (!fs.existsSync(stateSkillsDir)) return entries;
  for (const name of fs.readdirSync(stateSkillsDir).sort()) {
    const skillDir = path.join(stateSkillsDir, name);
    if (!isDirectorySafe(skillDir)) continue;
    entries.push({
      key: name,
      label: `skill ${name}`,
      digest: pathDigest(skillDir),
    });
  }
  return entries;
}

// A dry run writes nothing, so re-snapshotting after it always reads "changed: none". Instead,
// project the skill bodies the real run would refresh: a managed cache whose content differs from
// its source. The test is the installer's own (link_skill_item, and doctor's stale-skill warning):
// `diff -rq` ignoring the marker, so the preview cannot disagree with what update then does.
function projectDryRunState(before) {
  const skills = before.skills.map((entry) => {
    const cacheDir = path.join(stateSkillsDir, entry.key);
    const sourceDir = skillSourceDir(entry.key);
    if (!sourceDir || !fs.existsSync(path.join(cacheDir, MANAGED_MARKER))) return entry;
    const diff = spawnSync("diff", ["-rq", "-x", MANAGED_MARKER, sourceDir, cacheDir], { stdio: "ignore" });
    return diff.status === 0 ? entry : { ...entry, digest: `pending:${pathDigest(sourceDir)}` };
  });
  return { ...before, skills };
}

// Mirrors list_global_skill_sources in install-lib.sh: the system support skill plus every
// package-owned skill.
function skillSourceDir(name) {
  const candidates = [path.join(repoRoot, "globals", "system", "skills", name)];
  const packagesDir = path.join(repoRoot, "globals", "packages");
  if (fs.existsSync(packagesDir)) {
    for (const pkg of fs.readdirSync(packagesDir).sort()) candidates.push(path.join(packagesDir, pkg, "skills", name));
  }
  return candidates.find((dir) => fs.existsSync(path.join(dir, "SKILL.md"))) ?? null;
}

// The per-harness pointers. Adding a harness fans an already-installed skill out to one more dir;
// that is a link, not a new skill, so these entries stay out of the skills group and are folded
// into link details by linkDetails().
function snapshotManagedSkills() {
  const entries = [];
  for (const [harness, home] of Object.entries(HARNESS_HOME)) {
    const skillsDir = path.join(home, "skills");
    if (!fs.existsSync(skillsDir)) continue;
    for (const name of fs.readdirSync(skillsDir).sort()) {
      const skillDir = path.join(skillsDir, name);
      if (!isManagedSkillLink(skillDir)) continue;
      entries.push({
        key: `${harness}:${name}`,
        skill: name,
        harness,
        label: `skill ${name} ${harness}`,
        digest: pathDigest(skillDir),
      });
    }
  }
  return entries;
}

// statSync follows symlinks and throws on a dangling one, which a half-finished install can leave
// behind — a broken cache entry should be skipped, not crash the whole update report.
function isDirectorySafe(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// A managed entry is either a symlink into the shared cache (the normal case) or a real dir
// carrying the marker (legacy/copied installs), so both shapes stay visible to the report.
function isManagedSkillLink(skillDir) {
  try {
    if (fs.lstatSync(skillDir).isSymbolicLink()) {
      return path.resolve(path.dirname(skillDir), fs.readlinkSync(skillDir)).startsWith(stateSkillsDir);
    }
  } catch {
    return false;
  }
  return fs.existsSync(path.join(skillDir, MANAGED_MARKER));
}

function fileDigest(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`;
    if (!stat.isFile()) return pathDigest(file);
    return hashParts(["file", fs.readFileSync(file)]);
  } catch {
    return "missing";
  }
}

function pathDigest(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(target)}`;
    if (stat.isFile()) return fileDigest(target);
    if (!stat.isDirectory()) return `other:${stat.size}:${stat.mtimeMs}`;
    const parts = ["dir"];
    walkDir(target, target, parts);
    return hashParts(parts);
  } catch {
    return "missing";
  }
}

function walkDir(root, dir, parts) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const rel = path.relative(root, abs);
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) {
      parts.push(`link:${rel}:${fs.readlinkSync(abs)}`);
    } else if (stat.isDirectory()) {
      parts.push(`dir:${rel}`);
      walkDir(root, abs, parts);
    } else if (stat.isFile()) {
      parts.push(`file:${rel}`);
      parts.push(fs.readFileSync(abs));
    }
  }
}

function hashParts(parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function printUpdateReport(before, after, { verbose = false, installOutput = "", dryRun = false } = {}) {
  console.log("");
  const groups = [
    ["rules", compareEntries(before.renderedRules, after.renderedRules)],
    ["root config", compareEntries(before.rootConfig, after.rootConfig)],
    ["copied files", compareEntries(before.copied, after.copied)],
    ["skills", compareSkills(before, after)],
    ["package registry", compareScalar(before.packageRegistry, after.packageRegistry, "package registry")],
    ["hooks", compareEntries(before.hooks, after.hooks)],
    ["permissions", compareEntries(before.permissions, after.permissions)],
  ];
  if (!verbose) printUpdateSummary(groups, installOutput);
  console.log("Update change report:");
  printReportGroups(groups, { verbose, dryRun });
  printLocalConfigRepairHint();
  printOrphanSkillHint();
}

function compareScalar(before, after, label) {
  return before === after
    ? { changed: [], unchanged: [label] }
    : { changed: [{ label, verb: "updated" }], unchanged: [] };
}

function compareEntries(beforeEntries, afterEntries) {
  const before = new Map(beforeEntries.map((entry) => [entry.key, entry]));
  const after = new Map(afterEntries.map((entry) => [entry.key, entry]));
  const changed = [];
  const unchanged = [];
  for (const [key, entry] of after) {
    const previous = before.get(key);
    if (!previous) changed.push({ label: entry.label, verb: "added" });
    else if (previous.digest !== entry.digest) changed.push({ label: entry.label, verb: "updated" });
    else unchanged.push(entry.label);
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) changed.push({ label: entry.label, verb: "removed" });
  }
  return { changed, unchanged };
}

// Skills report as one line per skill, with harness fan-out as a detail. A new harness produces
// "linked skill X (gemini)" rather than an "added" row per skill, so a run that only wired up an
// extra harness never reads as N brand-new skills.
function compareSkills(before, after) {
  const bodies = compareEntries(before.skills, after.skills);
  const links = compareEntries(before.skillLinks, after.skillLinks);
  const bodyVerbs = new Map(bodies.changed.map((entry) => [entry.label, entry.verb]));
  const linksBySkill = groupLinksBySkill(before.skillLinks, after.skillLinks, links.changed);

  const changed = bodies.changed.map((entry) => {
    const detail = linkDetails(linksBySkill.get(entry.label));
    return detail ? { ...entry, label: `${entry.label} ${detail}` } : entry;
  });
  // Skills whose body is untouched but whose harness coverage moved — the pure fan-out case.
  for (const [label, moves] of linksBySkill) {
    if (bodyVerbs.has(label)) continue;
    const verb = moves.every((move) => move.verb === "removed") ? "unlinked" : "linked";
    changed.push({ label: `${label} ${linkDetails(moves)}`, verb });
  }
  return { changed, unchanged: bodies.unchanged };
}

function groupLinksBySkill(beforeLinks, afterLinks, changedLinks) {
  const harnessByLabel = new Map(
    [...beforeLinks, ...afterLinks].map((entry) => [entry.label, entry]),
  );
  const bySkill = new Map();
  for (const change of changedLinks) {
    const entry = harnessByLabel.get(change.label);
    if (!entry) continue;
    const key = `skill ${entry.skill}`;
    if (!bySkill.has(key)) bySkill.set(key, []);
    bySkill.get(key).push({ harness: entry.harness, verb: change.verb });
  }
  return bySkill;
}

function linkDetails(moves) {
  if (!moves?.length) return "";
  const added = moves.filter((move) => move.verb !== "removed").map((move) => move.harness).sort();
  const removed = moves.filter((move) => move.verb === "removed").map((move) => move.harness).sort();
  const parts = [];
  if (added.length) parts.push(`+${added.join(", ")}`);
  if (removed.length) parts.push(`-${removed.join(", ")}`);
  return `(${parts.join(" ")})`;
}

function printUpdateSummary(groups, installOutput) {
  console.log("━━━ roborepo update ━━━━━━━━━━━━━━━━━━━━━━━");
  printSummaryLine("ok", "shell + PATH");
  printSummaryLine("ok", "base skills");
  printSummaryLine(groupChanged(groups, "root config") ? "changed" : "ok", "local config");
  printSummaryLine(groupsChanged(groups, ["skills", "package registry"]) ? "changed" : "ok", "enabled packages");
  printSummaryLine(groupChanged(groups, "rules") ? "changed" : "ok", "rendered rules");
  for (const line of notableLines(installOutput)) console.log(line);
  console.log("");
}

function printSummaryLine(status, label) {
  console.log(`${status}: ${label}`);
}

function groupChanged(groups, label) {
  return groups.find(([groupLabel]) => groupLabel === label)?.[1].changed.length > 0;
}

function groupsChanged(groups, labels) {
  return labels.some((label) => groupChanged(groups, label));
}

function notableLines(output) {
  return String(output || "").split(/\r?\n/).filter((line) => {
    return /^(warn|fail|error|needs action|conflict|abort):/i.test(line)
      // "maintenance" optional: this filters the output of whatever roborepo produced it, which
      // may be an older installed copy still printing the pre-namespace spelling.
      || /MERGE REVIEW REQUIRED|Run: roborepo (?:maintenance )?repair local-config/.test(line);
  });
}

function printReportGroups(groups, { verbose, dryRun = false }) {
  const changed = uniqueChanges(groups.flatMap(([, group]) => group.changed));
  const unchanged = unique(groups.flatMap(([, group]) => group.unchanged));
  if (changed.length) {
    console.log("  changed:");
    for (const { label, verb } of changed) console.log(`    - ${dryRun ? `would ${DRY_RUN_VERBS[verb] ?? verb}` : verb} ${label}`);
  } else {
    console.log("  changed: none");
  }
  if (verbose && unchanged.length) {
    console.log(`  unchanged: ${unchanged.join(", ")}`);
  } else if (!verbose && unchanged.length) {
    console.log(`  unchanged: ${unchanged.length} item(s) hidden (run: roborepo update --verbose)`);
  }
}

function unique(values) {
  return [...new Set(values)].sort();
}

function uniqueChanges(entries) {
  const byLabel = new Map(entries.map((entry) => [entry.label, entry]));
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// Surfaced here as well as in doctor because a skill removed from the repo leaves its per-harness
// pointer behind on the very run that removes it — update is where the user is standing when the
// orphan appears, and a stale link is otherwise silent until someone runs doctor.
function printOrphanSkillHint() {
  const orphans = findOrphanSkillLinks();
  if (!orphans.length) return;
  console.log("");
  console.log(`Orphaned skill link(s) found (${orphans.map((orphan) => `${orphan.name}/${orphan.harness}`).join(", ")}).`);
  console.log("Run: roborepo skill prune-orphans");
}

function printLocalConfigRepairHint() {
  const plans = buildLocalConfigRepairPlans();
  if (!plans.length) return;
  const harnesses = plans.map((plan) => plan.harness).join(", ");
  console.log("");
  console.log(`Local config repair candidates found (${harnesses}).`);
  console.log("Run: roborepo maintenance repair local-config --dry-run");
}