import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootConfigActive, rootConfigBaseline } from "./paths.mjs";
import { isMainModule } from "./roots.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { recordWrite } from "./root-config-state.mjs";
import { recordConfigWrite } from "./write-log.mjs";

// Registry-driven label ("<Display Name> settings"), not a hardcoded claude/codex map — every
// registered provider's rootConfig gets a sensible label with no per-provider entry needed.
function harnessLabel(harness) {
  try {
    return `${getHarnessProvider(harness).manifest.displayName} settings`;
  } catch {
    return harness;
  }
}

function mergeRootConfig(harness, repoText, localText) {
  return getHarnessProvider(harness).adapters.rootConfig.merge(repoText, localText);
}

const MARKER_LINES = new Set([
  "# BEGIN GENERATED AGENT PERMISSIONS",
  "# Source: manifests/inventory/agent-permissions.json",
  "# END GENERATED AGENT PERMISSIONS",
]);

function usage() {
  console.error("usage: roborepo maintenance repair local-config [--dry-run|--apply|--check|--hint]");
}

export function localConfigRepairCommand(args = []) {
  const mode = parseMode(args);
  const plans = buildLocalConfigRepairPlans();

  if (mode === "check") {
    if (plans.length) {
      printHint(plans, { prefix: "fail" });
      process.exit(1);
    }
    console.log("ok: local config repair not needed");
    return;
  }

  if (mode === "hint") {
    if (plans.length) printHint(plans, { prefix: "hint" });
    return;
  }

  if (!plans.length) {
    console.log("ok: local config repair not needed");
    return;
  }

  printPlan(plans, mode);
  if (mode === "apply") applyPlans(plans);
  // Dry-run is the default, so a bare `repair local-config` also lands here; name the write step.
  else console.log("\nNothing was written. To apply these changes, run: roborepo maintenance repair local-config --apply");
}

function parseMode(args) {
  let mode = "dry-run";
  for (const arg of args) {
    switch (arg) {
      case "--dry-run": mode = "dry-run"; break;
      case "--apply": mode = "apply"; break;
      case "--check": mode = "check"; break;
      case "--hint": mode = "hint"; break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
      default:
        usage();
        process.exit(2);
    }
  }
  return mode;
}

export function buildLocalConfigRepairPlans() {
  return Object.keys(rootConfigActive).map(buildHarnessPlan).filter(Boolean);
}

function buildHarnessPlan(harness) {
  const activePath = rootConfigActive[harness];
  const baselinePath = rootConfigBaseline[harness];
  if (!fs.existsSync(activePath) || !fs.existsSync(baselinePath)) return null;

  const activeText = fs.readFileSync(activePath, "utf8");
  const baselineText = fs.readFileSync(baselinePath, "utf8");
  const backups = backupCandidates(harness, activePath);
  const activeNormalized = normalizeGeneratedMarkers(activeText);
  const issues = [];
  if (activeNormalized !== activeText) issues.push("remove duplicated generated marker lines");

  for (const backup of backups.slice(0, 1)) {
    // A backup older than the generated baseline cannot recover anything current. The merge below
    // is additive (backup ∪ active), and no backup records intent, so a setting the user has since
    // deleted on purpose still looks "missing" and gets proposed for restoration — every update,
    // forever. describeWhyNow() already names this case; skipping it here means the hint stops
    // firing for a repair whose only effect would be to undo the user's own edits.
    //
    // Deliberately not applied to the newer-than-baseline case: there, "missing in active" really
    // can mean a setting an install dropped, which is what this command exists to recover.
    if (isStaleBackup(backup, baselinePath)) continue;
    const backupText = fs.readFileSync(backup.path, "utf8");
    const backupMerged = mergeRootConfig(harness, baselineText, backupText);
    const repaired = normalizeGeneratedMarkers(mergeRootConfig(harness, backupMerged, activeText));
    if (repaired === activeText) continue;
    const keyDiff = diffConfigKeys(harness, activeNormalized, repaired);
    const hasRealDiff = keyDiff.added.length > 0 || keyDiff.changed.length > 0;
    // No recoverable setting differs — mergeRootConfig only reserialized in a different
    // key/section order. Not actionable; do not surface a repair plan for a safe no-op.
    // (A duplicated-marker issue is handled by the marker-only path below.)
    if (!hasRealDiff) break;
    const backupIssues = issues.slice();
    backupIssues.push(summarizeKeyDiff(backup.path, keyDiff));
    const plan = repairPlan(harness, activePath, repaired, backupIssues);
    plan.keyDiff = keyDiff;
    plan.why = describeWhyNow(backup, baselinePath, activePath);
    return plan;
  }

  if (activeNormalized !== activeText) {
    return repairPlan(harness, activePath, activeNormalized, issues);
  }
  return null;
}

function repairPlan(harness, activePath, repaired, issues) {
  return { harness, label: harnessLabel(harness), activePath, repaired, issues };
}

// Structural diff (parsed keys, not raw text) so hook/section reordering that mergeRootConfig
// re-serializes differently from the active file doesn't get reported as a real setting change.
function diffConfigKeys(harness, activeText, repairedText) {
  if (harness === "codex") return diffTomlKeys(activeText, repairedText);
  if (harness === "claude") return diffJsonKeys(activeText, repairedText);
  throw new Error(`unsupported harness: ${harness}`);
}

function flattenObject(value, prefix = "", out = new Map()) {
  if (Array.isArray(value)) {
    // Hook/permission arrays commonly get re-serialized in a different order by the merge
    // (block splitting, generated-rule regen) without any actual entry being added or removed.
    // Compare as an order-independent set so reordering never reads as a real setting change.
    out.set(prefix, new Set(value.map((entry) => JSON.stringify(entry))));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenObject(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.set(prefix, value);
  return out;
}

function diffJsonKeys(activeText, repairedText) {
  let active = {};
  let repaired = {};
  try { active = JSON.parse(activeText || "{}"); } catch {}
  try { repaired = JSON.parse(repairedText || "{}"); } catch {}
  const activeFlat = flattenObject(active);
  const repairedFlat = flattenObject(repaired);
  return compareFlatMaps(activeFlat, repairedFlat);
}

function diffTomlKeys(activeText, repairedText) {
  const activeFlat = flattenToml(activeText);
  const repairedFlat = flattenToml(repairedText);
  return compareFlatMaps(activeFlat, repairedFlat);
}

function flattenToml(text) {
  const out = new Map();
  let section = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const header = tomlHeader(line);
    if (header) {
      section = header;
      continue;
    }
    const match = line.match(/^\s*([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*=\s*(.*)$/);
    if (!match) continue;
    out.set(`${section} ${match[1]}`, match[2].trim());
  }
  return out;
}

function tomlHeader(line) {
  return /^\[[^\]]+\]$/.test(line.trim()) ? line.trim() : null;
}

function compareFlatMaps(activeFlat, repairedFlat) {
  const added = [];
  const changed = [];
  for (const [key, repairedValue] of repairedFlat) {
    if (!activeFlat.has(key)) {
      added.push({ key, value: repairedValue });
      continue;
    }
    const activeValue = activeFlat.get(key);
    if (repairedValue instanceof Set && activeValue instanceof Set) {
      // Order-independent: only entries truly absent from the active array count as additions.
      // A reordered-but-identical array (same entries, different position) reports nothing here.
      for (const entry of repairedValue) {
        if (!activeValue.has(entry)) added.push({ key, value: JSON.parse(entry) });
      }
      continue;
    }
    if (JSON.stringify(activeValue) !== JSON.stringify(repairedValue)) {
      changed.push({ key, from: activeValue, to: repairedValue });
    }
  }
  return { added, changed };
}

function summarizeKeyDiff(backupPath, keyDiff) {
  const kind = keyDiff.changed.length ? "additive + overwrite" : "additive only";
  return `recover local-only settings from ${backupPath} [${kind}]`;
}

function describeWhyNow(backup, baselinePath, activePath) {
  try {
    const backupMtime = backup.mtimeMs;
    const baselineMtime = fs.statSync(baselinePath).mtimeMs;
    const activeMtime = fs.statSync(activePath).mtimeMs;
    if (backupMtime < baselineMtime) {
      return "reason: this backup predates the current generated baseline, so it diverges from what the latest roborepo update produces";
    }
    if (backupMtime < activeMtime) {
      return "reason: the active config has been modified since this backup was taken";
    }
    return "reason: active config and backup diverge with no clear ordering — compare both by hand before applying";
  } catch {
    return "reason: unable to determine timing between backup and active config";
  }
}

// Unreadable timestamps => not stale. This gates whether a recovery is offered at all, so an
// unknown answer must fall back to showing the plan (with describeWhyNow's caveat) rather than
// silently hiding a repair the user may genuinely need.
function isStaleBackup(backup, baselinePath) {
  try {
    return backup.mtimeMs < fs.statSync(baselinePath).mtimeMs;
  } catch {
    return false;
  }
}

function backupCandidates(harness, activePath) {
  const dir = path.dirname(activePath);
  const ext = path.extname(activePath);
  const stem = path.basename(activePath, ext);
  const prefix = `${stem}_original_`;
  const suffix = ext;
  const candidates = [];

  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
      const file = path.join(dir, name);
      candidates.push({ path: file, mtimeMs: fs.statSync(file).mtimeMs });
    }
  } catch {}

  const preInstall = path.join(os.homedir(), ".roborepo", "backups", "pre-install", harness, path.basename(activePath));
  if (fs.existsSync(preInstall)) {
    candidates.push({ path: preInstall, mtimeMs: fs.statSync(preInstall).mtimeMs });
  }

  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function normalizeGeneratedMarkers(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (MARKER_LINES.has(line.trim())) {
      if (seen.has(line.trim())) continue;
      seen.add(line.trim());
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
}

function printHint(plans, { prefix }) {
  const harnesses = plans.map((plan) => plan.harness).join(", ");
  console.log(`${prefix}: local config repair candidates found (${harnesses}).`);
  console.log("      Run: roborepo maintenance repair local-config --dry-run");
}

function printPlan(plans, mode) {
  console.log(mode === "apply" ? "Applying local config repair:" : "Local config repair dry-run:");
  for (const plan of plans) {
    console.log(`  ${plan.label}: ${plan.activePath}`);
    for (const issue of plan.issues) console.log(`    - ${issue}`);
    if (plan.keyDiff) printKeyDiffDetail(plan.keyDiff);
    if (plan.why) console.log(`    ${plan.why}`);
    if (mode !== "apply") console.log("    would write repaired local config");
  }
}

function printKeyDiffDetail(keyDiff) {
  if (keyDiff.added.length) {
    console.log("    would add (missing in active, present in backup):");
    for (const entry of keyDiff.added.slice(0, 8)) {
      console.log(`      + ${entry.key} = ${formatValue(entry.value)}`);
    }
    if (keyDiff.added.length > 8) console.log(`      ... (+${keyDiff.added.length - 8} more)`);
  }
  if (keyDiff.changed.length) {
    console.log("    would overwrite (active value differs from backup):");
    for (const entry of keyDiff.changed.slice(0, 8)) {
      console.log(`      ~ ${entry.key}: ${formatValue(entry.from)} -> ${formatValue(entry.to)}`);
    }
    if (keyDiff.changed.length > 8) console.log(`      ... (+${keyDiff.changed.length - 8} more)`);
  }
}

function formatValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function applyPlans(plans) {
  const ts = process.env.ROBOREPO_INSTALL_TIMESTAMP || timestamp();
  for (const plan of plans) {
    const backupPath = repairBackupPath(plan.activePath, ts);
    fs.copyFileSync(plan.activePath, backupPath);
    fs.writeFileSync(plan.activePath, plan.repaired);
    recordWrite(plan.harness, plan.activePath);
    recordConfigWrite(plan.activePath, "repair local config");
    console.log(`backup: ${plan.activePath} -> ${backupPath}`);
    console.log(`repair: ${plan.activePath}`);
  }
}

function repairBackupPath(activePath, ts) {
  const ext = path.extname(activePath);
  const stem = path.basename(activePath, ext);
  const dir = path.dirname(activePath);
  let candidate = path.join(dir, `${stem}_repair_${ts}${ext}`);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}_repair_${ts}.${i}${ext}`);
    i += 1;
  }
  return candidate;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

if (isMainModule(import.meta.url)) localConfigRepairCommand(process.argv.slice(2));
