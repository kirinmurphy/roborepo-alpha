import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot, harnessHome } from "./paths.mjs";
import { isMainModule } from "./roots.mjs";
import { installStatePath, presetsStatePath } from "./state-paths.mjs";
import { readConfigSnapshot, buildBehaviorView } from "./config.mjs";
import { mutatePackage, setBehaviorBucket } from "./config-mutate.mjs";
import { renderHomeRules, removeHomeRules, isRenderedRulesOutput } from "./rules-render.mjs";
import { listHarnessProviders, getHarnessProvider } from "../harnesses/registry.mjs";
import { confirmYesNo, makePrompter, selectMenu, wizard } from "./skill-lib.mjs";
import { pathExists, findSiblingArtifact, copyTree, stageCandidate, backupOriginal, timestampedPath } from "./staging-lib.mjs";
import { checkDrift, recordWrite } from "./root-config-state.mjs";

const PRESET_MANIFEST = path.join(repoRoot, "manifests", "platform", "presets.json");
const INSTALL_MANIFEST = path.join(repoRoot, "manifests", "platform", "manifest.tsv");
const MANIFEST_HOME = harnessHome;
const ANSI = process.stdout.isTTY && !process.env.ROBOREPO_NO_COLOR
  ? { reset: "\x1b[0m", bold: "\x1b[1m", magenta: "\x1b[35m" }
  : { reset: "", bold: "", magenta: "" };

// The forced onboarding gate that used to live here (maybeRunPresetOnboarding) is gone: first-run
// behavior is now `roborepo init`, routed from main.mjs via scripts/cli/first-run-routing.mjs.

export async function presetsCommand(rest) {
  const [sub, ...args] = rest;
  switch (sub) {
    case "onboard":
      return presetsOnboard(args);
    case "intro":
      return presetsIntro(args);
    case "bundle":
      return bundleCommand(args);
    case "apply":
      return presetsApply(args);
    case "status":
      return presetsStatus(args);
    case "check":
      return presetsCheck(args);
    case "remove":
      return presetsRemove(args);
    default:
      console.error(`usage: roborepo package manage | roborepo bundle status|apply|check|remove`);
      process.exit(2);
  }
}

export async function bundleCommand(args) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "apply":
      return presetsApply(rest);
    case "status":
      return presetsStatus(rest);
    case "check":
      return presetsCheck(rest);
    case "remove":
      return presetsRemove(rest);
    default:
      console.error(`usage: roborepo bundle status|apply|check|remove`);
      process.exit(2);
  }
}

// Interactive onboarding, organized around the four user-facing behavior sections that the /config
// web portal shows (Token Optimization, Commands, Code Conventions, Permissions) rather than the
// internal bundle list. Each toggleable item drives the same config-mutate primitives the web POST
// endpoints use, so terminal and web stay in lockstep. Permissions are read-only here.
// Non-TTY (headless) keeps applying the default configuration, the same set install wires up.
export async function presetsOnboard(args) {
  rejectUnknownFlags(args, new Set(["--menu", "--launch-portal"]));
  const launchPortal = args.includes("--launch-portal");

  const tty = process.stdin.isTTY && process.stdout.isTTY;
  if (!tty) {
    console.log("Non-interactive shell: applying the default configuration (same as install).");
    presetsApply(["--default"]);
    markOnboarded();
    return;
  }

  await runInteractiveOnboard({ launchPortal, source: "library" });
  markOnboarded();
}

function markOnboarded() {
  const catalog = readPresetCatalog();
  const state = readPresetState();
  const selected = withDependencies(new Set(state.selected ?? catalog.default));
  writePresetState({
    ...state,
    selected: [...selected],
    onboardedAt: state.onboardedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bundles: bundleStates(catalog, selected),
  });
}

// Each toggleable item maps to a mutate call. `enabled` is the DESIRED final state (the wizard already
// flipped the in-memory flag; here we persist it). Telemetry is imported lazily to avoid a static
// import cycle (telemetry.mjs → presets.mjs). Returns { ok, message }.
async function applyItemToggle(section, item, enabled) {
  if (item.toggle === "package") return mutatePackage(item.id, enabled);
  if (section.category === "Token Optimization") {
    // jcodemunch / jdocmunch / caveman / telemetry are all packages now (telemetry via a service
    // component), so they route through the one generic package mutate.
    if (["jcodemunch", "jdocmunch", "caveman", "telemetry"].includes(item.id)) return mutatePackage(item.id, enabled);
    return { ok: false, message: `${item.label} is managed elsewhere (not toggleable here)` };
  }
  if (section.category === "Chat-Time Output") {
    // The three inline chat-note behaviors are rules packages; route through the generic mutate.
    return mutatePackage(item.id, enabled);
  }
  return { ok: false, message: `${section.category} is read-only in onboarding` };
}

// Named behaviors (write files, delete files, go online, commit code, push/pull/PRs) are the one
// bounded, small (5-item) interactive piece onboarding gets for Permissions — a single deny/ask/
// allow cycle per item, same shape the wizard already renders for any N-state item. Arbitrary
// (non-named) commands stay portal-only: add/remove/move across an unbounded list is a poor fit
// for a terminal wizard. `bucket` here is the item's new `state` (one of deny/ask/allow).
async function applyBehaviorBucket(behaviorId, bucket) {
  return setBehaviorBucket(behaviorId, bucket);
}

// Is this view item user-toggleable in the wizard? Package items carry their own toggle contract
// from buildBehaviorView; named Permissions behaviors are the one non-package toggle here
// (3-state, not boolean — see buildOnboardSteps).
function isToggleableItem(section, item) {
  if (item.toggle === "package") return true;
  if (section.category === "Permissions") {
    return item.kind === "behavior";
  }
  return false;
}

// Translate the live /config behavior view into wizard steps, in manifest order, then add the
// Permissions panel. The wizard re-reads state after each toggle, so marks always reflect truth.
export function buildOnboardSteps({ showWebNotice = false } = {}) {
  const view = buildBehaviorView(readConfigSnapshot());
  const steps = [];

  for (const section of view.filter((entry) => entry.items?.some((item) => item.toggle === "package"))) {
    const items = section.items
      .filter((item) => isToggleableItem(section, item))
      .map((item) => ({
        label: item.label,
        description: item.description || "",
        active: item.active,
        wasActive: item.active, // original state; diffed against `active` on finish to batch the work
        toggleable: true,
        // Carried so onFinish can route the change to the right mutate primitive.
        section,
        item,
      }));
    if (items.length === 0) continue;
    steps.push({
      title: section.category,
      description: section.description,
      itemHeader: "",
      footnote: section.footnote,
      items,
    });
  }

  if (showWebNotice && steps[0]) {
    steps[0].notice = "Prefer a web UI? Run: roborepo web";
  }

  // Permissions: the 5 named behaviors are directly toggleable here (deny/ask/allow cycle via
  // Space). Arbitrary commands are NOT editable in onboarding — a growable add/remove/move list
  // is a poor fit for a terminal wizard; the description below points to the portal for those.
  const perms = view.find((s) => s.category === "Permissions");
  if (perms) {
    const behaviorItems = perms.items
      .filter((it) => it.kind === "behavior")
      .map((it) => {
        // Harness-level caveats (e.g. a harness with no per-command ask tier) are surfaced once
        // as a section notice from the provider manifest, not repeated per item.
        const codexNote = it.codexOnly ? " (Codex only)" : "";
        return {
          label: it.label,
          description: `${it.description || ""}${codexNote}`.trim(),
          states: ["allow", "ask", "deny"],
          state: it.bucket,
          wasState: it.bucket, // original state; diffed against `state` on finish to batch the work
          toggleable: true,
          section: perms,
          item: it,
        };
      });
    if (behaviorItems.length > 0) {
      steps.push({
        title: "Permissions",
        description: "Other commands (git status, npm test, etc.) — manage those at: roborepo web",
        items: behaviorItems,
      });
    }
  }

  return steps;
}

// Deferred applier: run once when the wizard exits. Walk every step's items, diff each item's final
// `active` (or `state`, for N-state items) against its original, and persist only the ones that
// changed. All blocking work (mcp add/remove, symlinks, permission renders) happens here, after
// raw mode is off — so it can log freely without corrupting the in-place repaint that ran during
// the wizard.
// Pure diff: the wizard flips each item's `active`/`state` in memory; this picks the rows that
// actually changed (toggleable, not in a readonly step, and the current value differs from the
// original), preserving step/item order. Exported so the deferred-apply selection can be
// unit-tested without driving the interactive keypress loop.
export function pendingWizardChanges(steps) {
  const pending = [];
  for (const step of steps) {
    if (step.readonly) continue;
    for (const row of step.items) {
      if (!row.toggleable) continue;
      if (row.states ? row.state === row.wasState : row.active === row.wasActive) continue;
      pending.push(row);
    }
  }
  return pending;
}

export async function applyWizardChanges(steps) {
  const pending = pendingWizardChanges(steps);
  if (pending.length === 0) {
    console.log("\nNo changes.");
    return { applied: true, changed: false };
  }
  console.log("\nApplying changes…");
  let failed = 0;
  for (const row of pending) {
    if (row.states) {
      const result = await applyBehaviorBucket(row.item.id, row.state);
      const status = result.ok ? "ok" : `failed: ${result.message}`;
      if (!result.ok) failed += 1;
      console.log(`  ${row.state} ${row.item.id ?? row.label} — ${status}`);
      continue;
    }
    const verb = row.active ? "enable" : "disable";
    const result = await applyItemToggle(row.section, row.item, row.active);
    const status = result.ok ? "ok" : `failed: ${result.message}`;
    if (!result.ok) failed += 1;
    console.log(`  ${verb} ${row.item.id ?? row.label} — ${status}`);
  }
  return { applied: true, changed: true, failed };
}

async function runInteractiveOnboard({ launchPortal = false, source = "library" } = {}) {
  if (source === "install") {
    console.log("roborepo onboarding — toggle behavior across the sections, then press Enter on the last step.\n");
    console.log("Web UI: roborepo web\n");
  }
  const result = await wizard(
    buildOnboardSteps({ showWebNotice: source === "install" }),
    applyWizardChanges,
    { title: source === "install" ? "Onboarding" : "Package Library" },
  );
  writeInteractiveResult(result, source === "install" ? "Onboarding" : "Package Library");
  // The first-install intro owns the "open web?" nudge, so it runs the wizard with launchPortal=false
  // to avoid a duplicate portal prompt.
  if (launchPortal) await maybeLaunchPortal();
  if (source === "install") console.log("Onboarding complete.");
}

function writeInteractiveResult(result, title) {
  const resultFile = process.env.INTERACTIVE_RESULT_FILE;
  if (!resultFile) return;
  const payload = result?.changed
    ? { notice: { text: `${title} updated`, level: result.failed ? "warning" : "success" } }
    : {};
  try {
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify(payload) + "\n");
  } catch {}
}

// First-install welcome page + 4-option menu. A property of the INSTALL workflow only: install calls
// `roborepo onboard-intro` once, after core install, before any onboarding. Never shown on a direct
// `roborepo package manage`, and the already-onboarded guard in scripts/install/main.sh keeps it off updates
// and re-installs. Marks onboarded at the end of every path so it never re-shows.
export async function presetsIntro(args) {
  rejectUnknownFlags(args, new Set());

  const tty = process.stdin.isTTY && process.stdout.isTTY;
  if (!tty) {
    // Headless install path: defaults are already applied by install; just record onboarding so the
    // intro never re-shows, mirroring presetsOnboard's headless branch.
    markOnboarded();
    return;
  }

  printIntroBanner();
  printIntroWelcome();

  const choice = await selectMenu("What next?", [
    { label: "Install additional tools", value: "tools", desc: "choose which behaviors are enabled (onboarding)" },
    { label: "Open in web",              value: "web",   desc: "manage your settings in the browser" },
    { label: "Add telemetry only",       value: "telemetry", desc: "capture token usage, skip everything else" },
    { label: "Done",                     value: "done",  desc: "finish — change anything later with roborepo" },
  ]);

  switch (choice) {
    case "tools":
      // Run the onboarding wizard inline; the intro owns the web nudge, so skip the portal prompt.
      await runInteractiveOnboard({ launchPortal: false, source: "install" });
      break;
    case "web":
      spawnSync(process.execPath, [path.join(repoRoot, "scripts", "cli", "main.mjs"), "web"], { stdio: "inherit" });
      break;
    case "telemetry": {
      const result = await mutatePackage("telemetry", true);
      console.log(result.ok ? "\nTelemetry enabled. View it with: roborepo web" : `\nFailed to enable telemetry: ${result.message}`);
      break;
    }
    case "done":
    case null:
    default:
      break;
  }

  markOnboarded();
  printIntroHelp();
}

function introWidth() {
  return process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
}

function printIntroBanner() {
  const width = introWidth();
  const rule = "=".repeat(width);
  const label = "===== Welcome to roborepo ";
  const tail = "=".repeat(Math.max(0, width - label.length));
  console.log(`\n${rule}\n${rule}\n${label}${tail}\n${rule}\n${rule}\n`);
}

function providerNameList() {
  const names = listHarnessProviders().map((provider) => provider.manifest.displayName);
  if (names.length <= 1) return names.join("") || "your harness";
  return names.length === 2 ? names.join("/") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function printIntroWelcome() {
  console.log(`roborepo — version-controlled ${providerNameList()} harness config.\n`);
  console.log("Main commands");
  console.log("  roborepo web        manage your settings online");
  console.log("  roborepo package manage    choose which behaviors are enabled");
  console.log("  roborepo package enable X   turn on a package (jcodemunch, telemetry, ...)");
  console.log("  roborepo update     re-apply config after pulling changes");
  console.log("");
  console.log("Run `roborepo --help` for all commands.");
  console.log("Run `roborepo web` to manage your settings online.\n");
}

function printIntroHelp() {
  console.log("\nAll set. Manage roborepo anytime:");
  console.log("  roborepo --help     all commands");
  console.log("  roborepo web        manage your settings online");
}

async function maybeLaunchPortal() {
  console.log("\nWeb portal:");
  console.log("  roborepo web             open the portal and keep the server running in the background");
  console.log("  URL: http://127.0.0.1:4317");

  const prompter = makePrompter();
  try {
    const launch = await confirmYesNo(prompter, "Launch the local web portal now?", true);
    if (!launch) return;
  } finally {
    prompter.close();
  }

  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "cli", "main.mjs"), "serve", "--detach"], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error("Portal launch failed. You can retry with: roborepo web");
  }
}

export function presetsApply(args) {
  rejectUnknownFlags(args, new Set(["--default", "--all"]));
  const catalog = readPresetCatalog();
  const requested = withDependencies(requestedBundles(args, catalog));
  applySelection(requested, catalog, { reconcile: false });
  const state = readPresetState();
  const selected = withDependencies(new Set([...(state.selected ?? []), ...requested]));
  writePresetState({
    ...state,
    selected: [...selected],
    updatedAt: new Date().toISOString(),
    bundles: bundleStates(catalog, selected),
  });
}

export function presetsStatus(args) {
  rejectUnknownFlags(args, new Set());
  const catalog = readPresetCatalog();
  const state = readPresetState();
  const selected = new Set(state.selected ?? []);
  const policy = readInstallPolicy();
  console.log(`onboarded: ${state.onboardedAt ? state.onboardedAt : "no"}`);
  for (const bundle of catalog.bundles) {
    const applied = bundleApplied(bundle, manifestRowsByKey(), policy);
    const mark = selected.has(bundle.id) ? "selected" : "unselected";
    console.log(`${bundle.id.padEnd(12)} ${mark.padEnd(10)} ${applied ? "applied" : "missing"}  ${bundle.label}`);
  }
}

export function presetsCheck(args) {
  rejectUnknownFlags(args, new Set());
  const catalog = readPresetCatalog();
  const state = readPresetState();
  const selected = new Set(state.selected ?? []);
  const rows = manifestRowsByKey();
  const policy = readInstallPolicy();
  let failed = 0;
  for (const bundle of catalog.bundles) {
    if (!selected.has(bundle.id)) continue;
    if (bundleApplied(bundle, rows, policy)) {
      console.log(`ok: ${bundle.id}`);
    } else {
      console.error(`fail: ${bundle.id} selected but not fully applied`);
      failed = 1;
    }
  }
  process.exit(failed);
}

export function presetsRemove(args) {
  rejectUnknownFlags(args, new Set());
  const catalog = readPresetCatalog();
  const requested = requestedBundles(args, catalog);
  const rows = manifestRowsByKey();
  for (const id of requested) {
    const bundle = catalog.byId.get(id);
    removeBundle(bundle, rows);
  }
  const state = readPresetState();
  const selected = new Set(state.selected ?? []);
  for (const id of requested) selected.delete(id);
  writePresetState({
    ...state,
    selected: [...selected],
    updatedAt: new Date().toISOString(),
    bundles: bundleStates(catalog, selected),
  });
}

// Telemetry is intentionally listed in BOTH catalogs: a hollow bundle here (rows: []) AND a real
// service component in packages.json. The bundle entry's only job is bookkeeping in presetState +
// letting `presetsApply(["telemetry"])` trigger withDependencies() → link the base `hooks` bundle
// (belt-and-suspenders so capture-dense-bash.mjs in ~/.claude/hooks/ is reachable). On a full install
// the base bundle already links those hooks, so this is redundant-but-harmless; the telemetry-only
// install path (telemetryInstall) skips presetsApply deliberately. The real enable/disable lives in
// telemetry.mjs setTelemetryEnabled. Safe to untangle into a single package-only path later.
export function markTelemetrySelected(enabled) {
  const catalog = readPresetCatalog();
  const state = readPresetState();
  const selected = new Set(state.selected ?? []);
  if (enabled) selected.add("telemetry");
  else selected.delete("telemetry");
  writePresetState({
    ...state,
    selected: [...selected],
    updatedAt: new Date().toISOString(),
    bundles: bundleStates(catalog, selected),
  });
}

function isInstalledCore() {
  try {
    const state = JSON.parse(fs.readFileSync(installStatePath, "utf8"));
    return state?.repo === repoRoot;
  } catch {
    return false;
  }
}

function isBypassCommand(args) {
  const cmd = args[0];
  if (cmd === undefined || cmd === "-h" || cmd === "--help") return true;
  return new Set(["update", "repair", "doctor", "verify", "onboard", "bundle", "presets", "telemetry"]).has(cmd);
}

function readPresetCatalog() {
  const raw = JSON.parse(fs.readFileSync(PRESET_MANIFEST, "utf8"));
  const bundles = raw.bundles ?? [];
  const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  return { default: raw.default ?? [], bundles, byId };
}

function readPresetState() {
  try {
    return JSON.parse(fs.readFileSync(presetsStatePath, "utf8"));
  } catch {
    return {};
  }
}

function writePresetState(state) {
  fs.mkdirSync(path.dirname(presetsStatePath), { recursive: true });
  fs.writeFileSync(presetsStatePath, JSON.stringify(state, null, 2) + "\n");
}

function bundleStates(catalog, selected) {
  const states = {};
  for (const bundle of catalog.bundles) {
    states[bundle.id] = {
      selected: selected.has(bundle.id),
      rows: bundle.rows.length,
    };
  }
  return states;
}

function requestedBundles(args, catalog) {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (args.includes("--all") || positional.includes("all")) {
    return new Set(catalog.bundles.map((bundle) => bundle.id));
  }
  if (args.includes("--default") || positional.includes("default") || positional.length === 0) {
    return new Set(catalog.default);
  }
  const selected = new Set();
  for (const id of positional) {
    if (!catalog.byId.has(id)) {
      console.error(`unknown preset bundle: ${id}`);
      process.exit(2);
    }
    selected.add(id);
  }
  return selected;
}

function withDependencies(selected) {
  if (selected.has("telemetry")) selected.add("hooks");
  return selected;
}

function applySelection(selected, catalog, { reconcile }) {
  const rows = manifestRowsByKey();
  const policy = readInstallPolicy();
  for (const bundle of catalog.bundles) {
    if (selected.has(bundle.id)) applyBundle(bundle, rows, policy);
    else if (reconcile) removeBundle(bundle, rows);
  }
}

function applyBundle(bundle, rows, policy) {
  for (const key of bundle.rows) {
    const row = rows.get(key);
    if (!row) {
      console.warn(`warn: preset ${bundle.id} references missing manifest row ${key}`);
      continue;
    }
    applyRow(row, policy);
  }
}

function removeBundle(bundle, rows) {
  const policy = readInstallPolicy();
  for (const key of bundle.rows) {
    const row = rows.get(key);
    if (!row) continue;
    removeRow(row, policy);
  }
}

function applyRow(row, policy) {
  if (!harnessAvailable(row.harness)) return;
  if (row.kind === "cleanup") return cleanupRow(row);
  if (row.kind === "rendered_rules") return renderRulesItem(row);
  if (row.kind === "managed_copy" || row.kind === "link") return copyItem(row, policy);
  if (row.kind === "root_config") return copyItem(row, policy);
}

function renderRulesItem(row) {
  renderHomeRules({ harness: row.harness });
}

function cleanupRow(row) {
  const target = readlink(row.homeAbs);
  if (target && resolvesInsideRepo(row.homeAbs)) {
    fs.unlinkSync(row.homeAbs);
    console.log(`cleanup: ${row.homeAbs}`);
  }
}


// A root_config file is "builtin-authored" once install has written its hooks/markers in. Backing
// such a file up as a "pre-install" original poisons the backup — a later uninstall would restore
// roborepo hooks into a supposedly-clean file. Only ever back up a genuine pre-install file.
// Also recognizes rendered_rules output (the "# Generated Harness Rules" header).
function isBuiltInAuthored(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return /roborepo telemetry capture|write-guard|BEGIN GENERATED AGENT PERMISSIONS|MANAGED_BY_ROBOREPO|# Generated Harness Rules|BEGIN managed:builtin-code-style|BEGIN managed:managed-agents-import/.test(text);
  } catch {
    return false;
  }
}

function savePreInstallBackup(row) {
  if (!row.harness) return;
  if (readlink(row.homeAbs)) return;
  if (!pathExists(row.homeAbs)) return;
  const dest = path.join(os.homedir(), ".roborepo", "backups", "pre-install", row.harness, path.basename(row.homeAbs));
  if (fs.existsSync(dest)) return; // already have the user's original — never overwrite it
  if (isBuiltInAuthored(row.homeAbs)) {
    // Live file is already roborepo's (prior install or stray apply) — skip so poison isn't captured.
    console.log(`skip pre-install backup: ${row.homeAbs} is already builtin-authored`);
    return;
  }
  const source = path.join(repoRoot, row.srcRel);
  if (pathLooksRepoManaged(source, row.homeAbs)) {
    // Content matches repo source — this is a roborepo copy, not a user original; skip.
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyTree(row.homeAbs, dest);
  console.log(`pre-install backup: ${row.homeAbs} -> ${dest}`);
}

function copyItem(row, policy) {
  const source = path.join(repoRoot, row.srcRel);
  savePreInstallBackup(row);
  fs.mkdirSync(path.dirname(row.homeAbs), { recursive: true });
  const link = readlink(row.homeAbs);
  if (link && resolvesInsideRepo(row.homeAbs)) fs.unlinkSync(row.homeAbs);

  if (!pathExists(row.homeAbs)) {
    copyTree(source, row.homeAbs);
    console.log(`copy: ${row.homeAbs} <- ${source}`);
    if (row.kind === "root_config") recordWrite(row.harness, row.homeAbs);
    return;
  }

  if (pathsEquivalentForCopy(source, row.homeAbs)) {
    console.log(`ok: ${row.homeAbs}`);
    if (row.kind === "root_config") recordWrite(row.harness, row.homeAbs);
    return;
  }

  // root_config files are mutable and expected to change between installs (new permissions, hooks,
  // MCP entries). A byte mismatch against the current repo source doesn't by itself mean the user
  // touched the file — it may just mean the baseline moved on. Only real drift (the file changed
  // since roborepo's own last write) should be treated as a collision here.
  if (row.kind === "root_config") {
    const drift = checkDrift(row.harness, row.homeAbs);
    const repoText = fs.readFileSync(source, "utf8");
    const localText = fs.readFileSync(row.homeAbs, "utf8");
    const merged = getHarnessProvider(row.harness).adapters.rootConfig.merge(repoText, localText);
    if (drift.status === "clean") {
      fs.writeFileSync(row.homeAbs, merged);
      console.log(`update: ${row.homeAbs} <- ${source} (baseline changed, no local drift)`);
      // The merge just changed the file's content, so recordWrite must rehash post-write — there's
      // no precomputed hash to thread through here.
      recordWrite(row.harness, row.homeAbs);
      return;
    }
    // status is "unwritten" (no prior recorded write) or "drifted" (local edits after roborepo's
    // last write). Both are real collisions, so abort stops here before anything is written.
    if (policy.onConflict === "abort" && merged !== localText) abortOnConflict(row, source);
    if (drift.status === "drifted") {
      // Mirrors export_user_config in install-lib.sh. keep leaves the user's edits exactly as they
      // are and records nothing, so the drift stays visible to `config root inspect`; overwrite
      // backs the drifted file up before merging over it.
      if (policy.onConflict === "keep") {
        stageRootConfigCandidate(row, source);
        return;
      }
      const originalPath = timestampedPath(row.homeAbs, "original");
      fs.copyFileSync(row.homeAbs, originalPath);
      console.log(`backup: ${row.homeAbs} -> ${originalPath}`);
    }
    // An unwritten file is a first adopt: merging preserves local settings and layers repo-only
    // additions on top, so it applies under keep and overwrite alike.
    fs.writeFileSync(row.homeAbs, merged);
    console.log(`merge: ${row.homeAbs} <- ${source} (local root config preserved)`);
    recordWrite(row.harness, row.homeAbs);
    return;
  }

  if (policy.onConflict === "abort") abortOnConflict(row, source);
  if (policy.onConflict === "keep") {
    stageUpdate(row);
    printMergePrompt(row);
    return;
  }

  if (pathHasMeaningfulContent(row.homeAbs)) {
    const originalPath = backupOriginal(row.homeAbs);
    console.log(`backup: ${row.homeAbs} -> ${originalPath}`);
    printMergePrompt(row);
  } else {
    fs.rmSync(row.homeAbs, { recursive: true, force: true });
  }
  copyTree(source, row.homeAbs);
  console.log(`copy: ${row.homeAbs} <- ${source}`);
  if (row.kind === "root_config") recordWrite(row.harness, row.homeAbs);
}

function removeOwnedLink(row) {
  const link = readlink(row.homeAbs);
  if (!link) return;
  if (!resolvesInsideRepo(row.homeAbs)) return;
  fs.unlinkSync(row.homeAbs);
  console.log(`unlink: ${row.homeAbs}`);
}

function restorePreInstallBackup(row) {
  if (!row.harness) return;
  const backup = path.join(os.homedir(), ".roborepo", "backups", "pre-install", row.harness, path.basename(row.homeAbs));
  if (!fs.existsSync(backup)) return;
  if (pathExists(row.homeAbs)) return;
  fs.mkdirSync(path.dirname(row.homeAbs), { recursive: true });
  fs.renameSync(backup, row.homeAbs);
  console.log(`restore: ${row.homeAbs} <- ${backup}`);
}

function removeRenderedRulesRow(row) {
  // Unlink a legacy repo symlink if present (older installs).
  const link = readlink(row.homeAbs);
  if (link && resolvesInsideRepo(row.homeAbs)) {
    fs.unlinkSync(row.homeAbs);
    console.log(`unlink: ${row.homeAbs}`);
  }
  if (!pathExists(row.homeAbs)) {
    restorePreInstallBackup(row);
    return;
  }
  removeHomeRules({ harness: row.harness });

  // Leave genuine user files. Remove only files we rendered.
  if (!isBuiltInAuthored(row.homeAbs)) return;
  fs.rmSync(row.homeAbs, { recursive: true, force: true });
  console.log(`unlink: ${row.homeAbs}`);
  restorePreInstallBackup(row);
}

function removeRow(row, policy) {
  if (row.kind === "rendered_rules") return removeRenderedRulesRow(row);
  const source = path.join(repoRoot, row.srcRel);
  const staged = findSiblingArtifact(row.homeAbs, "update");
  const backup = findSiblingArtifact(row.homeAbs, "original");

  if (staged && policy.onConflict === "keep") {
    fs.rmSync(staged, { recursive: true, force: true });
    console.log(`unlink: ${staged}`);
  }

  if (row.kind === "link") {
    const link = readlink(row.homeAbs);
    if (link && path.resolve(path.dirname(row.homeAbs), link) === source) {
      fs.unlinkSync(row.homeAbs);
      console.log(`unlink: ${row.homeAbs}`);
      return;
    }
  }

  if (!pathExists(row.homeAbs)) return;

  if (policy.onConflict === "keep") {
    if (staged) return;
    if (!pathLooksRepoManaged(source, row.homeAbs)) return;
    fs.rmSync(row.homeAbs, { recursive: true, force: true });
    console.log(`unlink: ${row.homeAbs}`);
    return;
  }

  if (backup && pathLooksRepoManaged(source, row.homeAbs)) {
    fs.rmSync(row.homeAbs, { recursive: true, force: true });
    fs.renameSync(backup, row.homeAbs);
    console.log(`restore: ${row.homeAbs} <- ${backup}`);
    return;
  }

  if (pathLooksRepoManaged(source, row.homeAbs)) {
    fs.rmSync(row.homeAbs, { recursive: true, force: true });
    console.log(`unlink: ${row.homeAbs}`);
  }
}

function bundleApplied(bundle, rows, policy = readInstallPolicy()) {
  return bundle.rows.every((key) => {
    const row = rows.get(key);
    if (!row || !harnessAvailable(row.harness)) return true;
    if (row.kind === "managed_copy" || row.kind === "link" || row.kind === "root_config")
      return fs.existsSync(row.homeAbs) && !readlink(row.homeAbs);
    if (row.kind === "rendered_rules")
      return fs.existsSync(row.homeAbs) && !readlink(row.homeAbs) && isRenderedRulesOutput(row.homeAbs);
    return true;
  });
}

function readInstallPolicy() {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(installStatePath, "utf8"));
  } catch {}
  const policies = new Set(["keep", "overwrite", "abort"]);
  const envConflict = process.env.ROBOREPO_ON_CONFLICT;
  const stateConflict = state.onConflict;
  const onConflict = policies.has(envConflict)
    ? envConflict
    : policies.has(stateConflict)
      ? stateConflict
      : "keep";
  return { onConflict };
}

// A drifted root config under keep: stage the repo candidate beside the user's file, unless an
// identical candidate is already staged — repeated updates would otherwise pile up one copy per run.
function stageRootConfigCandidate(row, source) {
  const staged = findSiblingArtifact(row.homeAbs, "update");
  if (staged && fs.readFileSync(staged, "utf8") === fs.readFileSync(source, "utf8")) {
    console.log(`ok: ${row.homeAbs} (drifted local root config kept; candidate already staged as ${path.basename(staged)})`);
    return;
  }
  stageUpdate(row);
  printMergePrompt(row);
}

function abortOnConflict(row, source) {
  console.error(`abort: install canceled by user (${row.homeAbs} conflicts with ${source}; this file was not changed)`);
  console.error("Rerun with --on-conflict keep or --on-conflict overwrite to continue.");
  process.exit(1);
}

function stageUpdate(row) {
  const source = path.join(repoRoot, row.srcRel);
  const updatePath = stageCandidate(source, row.homeAbs);
  console.log(`stage: ${updatePath} <- ${source}`);
}

function printMergePrompt(row) {
  const source = path.join(repoRoot, row.srcRel);
  console.log("");
  console.log("================================================================================");
  console.log(`${ANSI.magenta}${ANSI.bold}MERGE REVIEW REQUIRED: harness install conflict${ANSI.reset}`);
  console.log("Merge review prompt:");
  console.log(`Local path: ${row.homeAbs}`);
  console.log("================================================================================");
  console.log(`Resolve this harness install conflict.

Repo harness path:
  ${source}

Existing local path:
  ${row.homeAbs}

Default stance: preserve the existing local path as source of truth unless you can prove a repo change can be added without breaking local behavior.

Required first step: compute your own complete comparison of both paths. Do not rely on this prompt as an exhaustive conflict summary. For directories, inspect the full recursive file list and content diffs. For structured files, parse the format when possible instead of using only text matching.

Goal: preserve the user's existing local behavior while installing useful harness behavior from the repo.

Merge instructions:
- Keep local-only behavior by default.
- Add repo-only harness behavior only when it does not conflict with local behavior.
- If both sides edit the same setting, hook, rule, command, skill, or MCP/server entry, explain the conflict and stop for user choice.
- Do not delete, replace, or move the local path unless the user explicitly approves that exact action.
- Report the files changed and the conflicts left unresolved.`);
  console.log("================================================================================");
  console.log("");
}

function pathsEquivalentForCopy(source, target) {
  if (!pathExists(source) || !pathExists(target)) return false;
  if (!fs.lstatSync(source).isFile() || !fs.lstatSync(target).isFile() || readlink(target)) return false;
  return fs.readFileSync(source).equals(fs.readFileSync(target));
}

function pathHasMeaningfulContent(target) {
  if (!pathExists(target)) return false;
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink()) return true;
  if (stats.isFile()) return stats.size > 0;
  if (stats.isDirectory()) return fs.readdirSync(target).length > 0;
  return true;
}

function pathLooksRepoManaged(source, target) {
  if (!pathExists(source) || !pathExists(target)) return false;
  const srcStat = fs.lstatSync(source);
  const dstStat = fs.lstatSync(target);
  if (dstStat.isSymbolicLink()) {
    return resolvesInsideRepo(target);
  }
  if (srcStat.isFile() && dstStat.isFile()) {
    return fs.readFileSync(source).equals(fs.readFileSync(target));
  }
  if (srcStat.isDirectory() && dstStat.isDirectory()) {
    return directoryTreesEqual(source, target);
  }
  return false;
}

function directoryTreesEqual(source, target) {
  const sourceEntries = fs.readdirSync(source, { withFileTypes: true }).map((entry) => entry.name).sort();
  const targetEntries = fs.readdirSync(target, { withFileTypes: true }).map((entry) => entry.name).sort();
  if (sourceEntries.length !== targetEntries.length) return false;
  for (let i = 0; i < sourceEntries.length; i += 1) {
    if (sourceEntries[i] !== targetEntries[i]) return false;
    const sourceChild = path.join(source, sourceEntries[i]);
    const targetChild = path.join(target, targetEntries[i]);
    const sourceStat = fs.lstatSync(sourceChild);
    const targetStat = fs.lstatSync(targetChild);
    if (sourceStat.isDirectory() && targetStat.isDirectory()) {
      if (!directoryTreesEqual(sourceChild, targetChild)) return false;
      continue;
    }
    if (sourceStat.isFile() && targetStat.isFile()) {
      if (!fs.readFileSync(sourceChild).equals(fs.readFileSync(targetChild))) return false;
      continue;
    }
    if (sourceStat.isSymbolicLink() && targetStat.isSymbolicLink()) {
      if (fs.readlinkSync(sourceChild) !== fs.readlinkSync(targetChild)) return false;
      continue;
    }
    return false;
  }
  return true;
}

function manifestRowsByKey() {
  const map = new Map();
  for (const row of readManifestRows()) {
    map.set(`${row.harness}:${row.homeSub}`, row);
  }
  return map;
}

function readManifestRows() {
  const rows = [];
  for (const line of fs.readFileSync(INSTALL_MANIFEST, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [harness, kind, srcRel, homeSub, homeRoot, flags] = line.split("\t");
    rows.push({
      harness,
      kind,
      srcRel,
      homeSub,
      homeRoot,
      flags,
      homeAbs: path.join(MANIFEST_HOME[homeRoot], homeSub),
    });
  }
  return rows;
}

function harnessAvailable(harness) {
  const homePath = MANIFEST_HOME[harness];
  return typeof homePath === "string" && fs.existsSync(homePath);
}

function readlink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink() ? fs.readlinkSync(target) : null;
  } catch {
    return null;
  }
}

function realpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function resolvesInsideRepo(target) {
  const real = path.resolve(path.dirname(target), readlink(target) ?? "");
  return real === repoRoot || real.startsWith(`${repoRoot}${path.sep}`);
}

function rejectUnknownFlags(args, allowed) {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    if (!allowed.has(arg)) {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }
}

if (isMainModule(import.meta.url)) {
  presetsCommand(process.argv.slice(2)).catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}